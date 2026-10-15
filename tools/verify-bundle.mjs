import { readFileSync } from 'node:fs';
import { resolve, posix, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Offline inspection only: do not execute an archive or print its file contents.
// Accept npm's ordinary ustar tarball format, and fail closed on extensions.
const target = process.argv[2];
if (!target) throw new Error('Usage: node tools/verify-bundle.mjs <npm-tarball>');
const packed = readFileSync(target === '-' ? 0 : resolve(target));
if (packed.length > 16 * 1024 * 1024) throw new Error('Archive exceeds inspection limit');
const bytes = gunzipSync(packed, { maxOutputLength: 64 * 1024 * 1024 });
const entries = new Map();
for (let at = 0; at + 512 <= bytes.length;) {
  const header = bytes.subarray(at, at + 512);
  if (header.every(byte => byte === 0)) break;
  const string = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const checksumField = string(148, 8).trim();
  const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (!/^[0-7]+$/.test(checksumField) || Number.parseInt(checksumField, 8) !== checksum) throw new Error('Invalid tar header checksum');
  const name = [string(345, 155), string(0, 100)].filter(Boolean).join('/');
  const type = string(156, 1);
  const sizeField = string(124, 12).trim();
  if (!/^[0-7]+$/.test(sizeField)) throw new Error('Unsupported tar size');
  const size = Number.parseInt(sizeField, 8);
  if (type !== '' && type !== '0') throw new Error('Unexpected non-regular tar member');
  if (!name.startsWith('package/') || /[\\:\x00-\x1f]/.test(name) || posix.normalize(name) !== name || name.split('/').includes('..') || entries.has(name.slice(8))) throw new Error('Unsafe archive member');
  if (!Number.isSafeInteger(size) || at + 512 + size > bytes.length) throw new Error('Truncated archive member');
  entries.set(name.slice(8), bytes.subarray(at + 512, at + 512 + size));
  at += 512 + Math.ceil(size / 512) * 512;
}
const text = path => {
  const value = entries.get(path);
  if (!value) throw new Error('Missing required bundle member: ' + path);
  return value.toString('utf8');
};
const manifest = JSON.parse(text('package.json'));
// Only these manually invoked development commands are permitted; every npm lifecycle hook is denied.
const developmentScripts = {
  build: 'tsc -p tsconfig.json && node scripts/build-plugin.mjs && node scripts/sync-distribution.mjs',
  test: 'npm run build && node --test dist/test/*.test.js',
  'pack:plugin': 'npm run build && npm pack --ignore-scripts',
  'verify:source': 'node tools/verify-public-source.mjs',
};
if (Object.entries(manifest.scripts ?? {}).some(([name, command]) => !Object.hasOwn(developmentScripts, name) || developmentScripts[name] !== command)) throw new Error('Unapproved script or lifecycle hook');
if (manifest.name !== 'dsh-discord-remote-agents' || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('Unexpected bundle identity');
if (manifest.dependencies?.['discord.js'] !== '14.27.0') throw new Error('Missing pinned Discord dependency');
for (const path of ['index.js', 'client.js', 'host-runtime.js', 'native-adapter.js', 'windows-secrets.ps1']) text(path);
if (![...entries.keys()].some(path => path.startsWith('runtime/') && path.endsWith('.js'))) throw new Error('Missing compiled self-contained runtime');
const sensitiveName = /(^|\/)(?:\.env(?:\..*)?|\.git|\.research|config\.json|telegram\.config\.json|node_modules)(?:\/|$)|\.(?:sqlite(?:-.*)?|sqlite3|db|dpapi|credential|log|bak)$/i;
const secretPatterns = [
  /mfa\.[A-Za-z0-9_-]{60,}/,
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
let inspectedModules = 0;
for (const [path, value] of entries) {
  if (sensitiveName.test(path)) throw new Error('Forbidden artifact member: ' + path);
  const source = value.toString('utf8');
  if (secretPatterns.some(pattern => pattern.test(source))) throw new Error('Possible credential detected; value withheld: ' + path);
  if (!/\.(?:js|mjs|cjs|json|yml|ps1|ts)$/.test(path)) continue;
  if (/\.(?:js|mjs|cjs)$/.test(path)) {
    inspectedModules++;
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) {
        const destination = posix.normalize(posix.join(posix.dirname(path), spec));
        if (destination.startsWith('../') || !entries.has(destination)) throw new Error('Unresolved relative bundle import: ' + path + ' -> ' + spec);
      } else {
        if (isAbsolute(spec) || spec.includes('.research') || (!Object.keys(manifest.dependencies ?? {}).some(dep => spec === dep || spec.startsWith(dep + '/')) && spec !== 'react')) throw new Error('Undeclared runtime import: ' + path + ' -> ' + spec);
      }
    }
    if (/["'][^"'\r\n]*\.research[\\/][^"'\r\n]*["']/.test(source)) throw new Error('Research-path runtime reference: ' + path);
  }
}
console.log(JSON.stringify({ ok: true, name: manifest.name, version: manifest.version, files: entries.size, inspectedModules, checks: ['archive-safety', 'required-runtime', 'relative-imports', 'declared-dependencies', 'artifact-secret-patterns'] }));
