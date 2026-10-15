import { readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Export only the already-inspected npm payload, never the development tree/history.
const [archive, destination] = process.argv.slice(2);
if (!archive || !destination) throw new Error('Usage: node tools/export-github-bundle.mjs <bundle.tgz> <new-directory>');
const target = resolve(destination);
if (existsSync(target)) throw new Error('Destination must not exist');
// Resolve the nearest existing ancestor before appending a non-existing suffix.
// Check both lexical and real paths, including junction/symlink aliases. This is
// an accidental-overwrite guard, not a hostile concurrent-filesystem guarantee.
let ancestor = target;
const suffix = [];
for (;;) {
  try { lstatSync(ancestor); break; }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Destination ancestor cannot be inspected');
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Destination ancestor not found');
    suffix.unshift(relative(parent, ancestor));
    ancestor = parent;
  }
}
const resolvedTarget = resolve(realpathSync(ancestor), ...suffix);
const canonicalRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../'));
};
if (inside(canonicalRoot, target) || inside(canonicalRoot, resolvedTarget)) throw new Error('Destination must be outside source checkouts');
for (const path of [target, resolvedTarget]) {
  for (let parent = path; ; parent = dirname(parent)) {
    if (existsSync(join(parent, '.git'))) throw new Error('Destination must be outside source checkouts');
    if (dirname(parent) === parent) break;
  }
}
// Inspect exactly the immutable bytes exported below, not a separately reopened path.
const packed = readFileSync(resolve(archive));
const inspection = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-bundle.mjs', import.meta.url)), '-'], { input: packed, encoding: 'utf8' });
if (inspection.error || inspection.status !== 0) throw new Error('Bundle inspection failed; no files exported');
const bytes = gunzipSync(packed, { maxOutputLength: 64 * 1024 * 1024 });
const files = new Map();
for (let offset = 0; offset + 512 <= bytes.length;) {
  const header = bytes.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
  const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/').slice(8);
  const size = Number.parseInt(field(124, 12).trim(), 8);
  files.set(name, bytes.subarray(offset + 512, offset + 512 + size));
  offset += 512 + Math.ceil(size / 512) * 512;
}
const manifest = JSON.parse(files.get('package.json').toString('utf8'));
const allowed = manifest.files;
if (!Array.isArray(allowed) || !allowed.every(path => typeof path === 'string')) throw new Error('Explicit package files required');
// Script policy was checked by verify-bundle: exact manual development commands only, no lifecycle hooks.
const patterns = [
  /mfa\.[A-Za-z0-9_-]{60,}/, /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /[A-Z]:[\\/]Users[\\/](?!USER(?:[\\/]|\b)|Public(?:[\\/]|\b)|Default(?:[\\/]|\b))[^\\/\s"'<>]+/i,
];
for (const [name, contents] of files) {
  if (!['package.json', 'README.md', 'LICENSE', 'LICENSE.md'].includes(name) && !allowed.some(path => path.endsWith('/') ? name.startsWith(path) : path === name)) throw new Error('Unallowlisted export member: ' + name);
  if (patterns.some(pattern => pattern.test(contents.toString('utf8')))) throw new Error('Potential sensitive data; value withheld: ' + name);
}
mkdirSync(target);
for (const [name, contents] of files) {
  const path = join(target, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { flag: 'wx' });
}
const inventory = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, contents]) => `${createHash('sha256').update(contents).digest('hex')}  ${name}`).join('\n') + '\n';
writeFileSync(join(target, 'MANIFEST.sha256'), inventory, { flag: 'wx' });
console.log(JSON.stringify({ exported: files.size, version: manifest.version, inventory: 'MANIFEST.sha256', lifecycleScripts: false }));
