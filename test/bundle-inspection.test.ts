import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

function archive(extra: Record<string, string> = {}): Buffer {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'dsh-discord-remote-agents', version: 'fixture', dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { 'discord.js': '14.27.0' } }),
    'cordis.patch.yml': '- id: fixture\n',
    'index.js': "export { value } from './host-runtime.js';\n",
    'host-runtime.js': "export { value } from './runtime/engine.js';\n",
    'runtime/engine.js': 'export const value = 1;\n',
    'native-adapter.js': 'export const native = true;\n',
    'client.js': 'export const client = true;\n',
    'windows-secrets.ps1': '# synthetic fixture only\n',
    ...extra,
  };
  const chunks: Buffer[] = [];
  for (const [path, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write('package/' + path, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function inspect(bytes: Buffer): { status: number | null; stdout: string; stderr: string } {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'discord-bundle-inspection-'));
  try {
    const path = join(directory, 'fixture.tgz');
    writeFileSync(path, bytes);
    const result = spawnSync(process.execPath, [resolve('tools/verify-bundle.mjs'), path], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    assert.equal(dirname(realpathSync(directory)), parent);
    assert.ok(directory.startsWith(join(parent, 'discord-bundle-inspection-')));
    rmSync(directory, { recursive: true, force: true });
  }
}
test('bundle inspector accepts a self-contained declared-dependency fixture without execution', () => {
  const result = inspect(archive());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
test('bundle inspector rejects missing relative runtime and escaping paths', () => {
  assert.notEqual(inspect(archive({ 'host-runtime.js': "import '../../outside.js';" })).status, 0);
  assert.notEqual(inspect(archive({ '../outside.js': 'not allowed' })).status, 0);
});
test('bundle inspector rejects local secrets and undeclared runtime dependencies without disclosure', () => {
  const candidate = 'ghp_' + 'x'.repeat(36);
  const secret = inspect(archive({ 'fixture.js': `export const value = '${candidate}';` }));
  assert.notEqual(secret.status, 0);
  assert.equal((secret.stdout + secret.stderr).includes(candidate), false);
  assert.notEqual(inspect(archive({ '.env': 'placeholder only' })).status, 0);
  assert.notEqual(inspect(archive({ 'fixture.js': "import 'undeclared-package';" })).status, 0);
});
test('bundle inspector rejects truncated and invalid archives', () => {
  assert.notEqual(inspect(Buffer.from('not an archive')).status, 0);
  assert.notEqual(inspect(gzipSync(Buffer.alloc(513, 1))).status, 0);
});

const exportManifest = (extra: Record<string, unknown> = {}) => JSON.stringify({
  name: 'dsh-discord-remote-agents', version: 'fixture',
  dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { 'discord.js': '14.27.0' },
  files: ['cordis.patch.yml', 'index.js', 'host-runtime.js', 'runtime/', 'native-adapter.js', 'client.js', 'windows-secrets.ps1'], ...extra,
});
function exportFixture(extra: Record<string, string>, check: (result: ReturnType<typeof spawnSync>, directory: string, retry: () => ReturnType<typeof spawnSync>) => void): void {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'discord-bundle-export-'));
  try {
    const packed = join(directory, 'fixture.tgz'), output = join(directory, 'public');
    writeFileSync(packed, archive({ 'package.json': exportManifest(), ...extra }));
    const run = () => spawnSync(process.execPath, [resolve('tools/export-github-bundle.mjs'), packed, output], { encoding: 'utf8', windowsHide: true });
    check(run(), output, run);
  } finally {
    assert.equal(dirname(realpathSync(directory)), parent);
    assert.ok(directory.startsWith(join(parent, 'discord-bundle-export-')));
    rmSync(directory, { recursive: true, force: true });
  }
}
test('public exporter copies only the inspected payload, inventories hashes, and refuses overwrite', () => {
  exportFixture({}, (result, output, retry) => {
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(JSON.parse(String(result.stdout)).exported, 8);
    assert.equal(readFileSync(join(output, 'runtime/engine.js'), 'utf8'), 'export const value = 1;\n');
    assert.equal(readFileSync(join(output, 'MANIFEST.sha256'), 'utf8').trim().split('\n').length, 8);
    assert.notEqual(retry().status, 0);
    assert.equal(readFileSync(join(output, 'runtime/engine.js'), 'utf8'), 'export const value = 1;\n');
  });
});
test('public exporter refuses source-root descendants and external junction aliases without writes', () => {
  const parent = realpathSync(tmpdir());
  const fixture = mkdtempSync(join(parent, 'dsh-export-boundary-'));
  try {
    const canonical = join(fixture, 'canonical'), tools = join(canonical, 'tools');
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(canonical, '.git'), 'synthetic worktree marker only\n');
    for (const tool of ['export-github-bundle.mjs', 'verify-bundle.mjs']) {
      writeFileSync(join(tools, tool), readFileSync(resolve('tools', tool)));
    }
    const packed = join(fixture, 'fixture.tgz');
    writeFileSync(packed, archive({ 'package.json': exportManifest() }));
    const alias = join(fixture, 'external-alias');
    symlinkSync(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const run = (output: string) => spawnSync(process.execPath, [join(tools, 'export-github-bundle.mjs'), packed, output], { encoding: 'utf8' });
    const other = join(fixture, 'other-checkout');
    mkdirSync(join(other, '.git'), { recursive: true });
    const otherAlias = join(fixture, 'other-alias');
    symlinkSync(other, otherAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const before = readdirSync(canonical).sort();
    const refused = [canonical, join(canonical, 'bundle-export', 'new'), join(alias, 'bundle-export', 'new'), join(other, 'bundle-export', 'new'), join(otherAlias, 'bundle-export', 'new')];
    if (process.platform === 'win32') refused.push(join(canonical.toUpperCase(), 'bundle-export', 'new'));
    for (const output of refused) {
      const result = run(output);
      if (result.error) throw result.error;
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Destination must (?:not exist|be outside source checkouts)/);
      assert.deepEqual(readdirSync(canonical).sort(), before);
      assert.equal(existsSync(join(canonical, 'bundle-export')), false);
    }
    // A sibling with the same textual prefix is outside the path boundary.
    const sibling = join(fixture, 'canonical-other');
    mkdirSync(sibling);
    const accepted = run(join(sibling, 'public'));
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    assert.equal(dirname(realpathSync(fixture)), parent);
    assert.ok(fixture.startsWith(join(parent, 'dsh-export-boundary-')));
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('public exporter rejects unallowlisted files and lifecycle scripts before creating output', () => {
  for (const extra of [{ 'unexpected.txt': 'not allowlisted' }, { 'package.json': exportManifest({ scripts: { prepare: 'exit 1' } }) }]) {
    exportFixture(extra, (result, output) => { assert.notEqual(result.status, 0); assert.equal(existsSync(output), false); });
  }
});
test('public exporter allows exact manual development scripts but refuses hooks and changed commands', () => {
  const scripts = { build: 'tsc -p tsconfig.json && node scripts/build-plugin.mjs && node scripts/sync-distribution.mjs' };
  exportFixture({ 'package.json': exportManifest({ scripts }), 'README.md': '# synthetic documentation\n' }, (result) => {
    assert.equal(result.status, 0, String(result.stderr));
  });
  for (const denied of [{ ...scripts, install: 'exit 0' }, { build: 'exit 0' }, { pretest: 'exit 0' }, { prepare: 'exit 0' }]) {
    exportFixture({ 'package.json': exportManifest({ scripts: denied }) }, (result, output) => {
      assert.notEqual(result.status, 0); assert.equal(existsSync(output), false);
    });
  }
});

test('distribution build refuses registry-publishable root or canonical manifests before writing payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-registry-policy-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'packages', 'discord-plugin'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'sync-distribution.mjs'), readFileSync(resolve('scripts/sync-distribution.mjs')));
    const safe = { private: true };
    for (const unsafe of [{ private: false }, { private: true, publishConfig: {} }]) {
      for (const [a, b] of [[unsafe, safe], [safe, unsafe]]) {
        writeFileSync(join(root, 'package.json'), JSON.stringify(a));
        writeFileSync(join(root, 'packages', 'discord-plugin', 'package.json'), JSON.stringify(b));
        const result = spawnSync(process.execPath, [join(root, 'scripts', 'sync-distribution.mjs')], { encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Registry publication is disabled/);
        assert.equal(existsSync(join(root, 'MANIFEST.sha256')), false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public exporter rejects additional token patterns without exposing the value', () => {
  const secret = 'github_pat_' + 'x'.repeat(40);
  exportFixture({ 'client.js': `export const synthetic = '${secret}';` }, (result, output) => {
    assert.notEqual(result.status, 0); assert.equal(existsSync(output), false);
    assert.equal((String(result.stdout) + String(result.stderr)).includes(secret), false);
  });
});
