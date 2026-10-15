import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import type { HostSecretStore, SecretJournal, SecretJournalState } from '../packages/discord-plugin/windows-secrets.js';
const { WindowsSecretStore, SecretLifecycle, ProtectedStoreError } = await import(new URL('../../packages/discord-plugin/windows-secrets.js', import.meta.url).href) as typeof import('../packages/discord-plugin/windows-secrets.js');
test('shipped PowerShell helper bytes retain LF and match the provider integrity pin', async () => {
  const source = await readFile(new URL('../../packages/discord-plugin/windows-secrets.js', import.meta.url), 'utf8');
  const pins = [...source.matchAll(/^const helperHash = '([a-f0-9]{64})';$/gm)];
  assert.equal(pins.length, 1, 'provider must contain exactly one literal SHA-256 helper pin');
  const helper = await readFile(new URL('../../packages/discord-plugin/windows-secrets.ps1', import.meta.url));
  assert.equal(helper.includes(13), false, 'pinned helper must not acquire CRLF checkout bytes');
  assert.equal(createHash('sha256').update(helper).digest('hex'), pins[0]![1]);
});
function fixture() {
  const values = new Map<string, string>([['a'.repeat(64), 'old-dummy']]);
  let state: SecretJournalState = { revision: 0, activeRef: 'a'.repeat(64), pending: null };
  const store: HostSecretStore = {
    async create(value) { const ref = randomBytes(32).toString('hex'); values.set(ref, value); return ref; },
    async read(ref) { const value = values.get(ref); if (!value) throw new Error('synthetic-private-error'); return value; },
    async retire(ref) { values.delete(ref); }
  };
  let held = false;
  const journal: SecretJournal = { async withExclusive(action) { if (held) throw new ProtectedStoreError('SECRET_UPDATE_BUSY'); held = true; try { return await action(); } finally { held = false; } }, async load() { return structuredClone(state); }, async compareAndSwap(revision, next) {
    if (state.revision !== revision) return false; state = structuredClone(next); return true;
  } };
  return { values, store, journal, state: () => state, set: (next: SecretJournalState) => { state = next; } };
}
test('secret lifecycle verifies before switching and retires only the previous secret', async () => {
  const f = fixture(); const lifecycle = new SecretLifecycle(f.store, f.journal);
  const result = await lifecycle.replace('new-dummy', 0, async value => {
    assert.equal(value, 'new-dummy'); assert.equal(f.state().activeRef, 'a'.repeat(64));
    assert.equal(f.state().pending?.phase, 'candidate'); return true;
  });
  assert.deepEqual(result, { revision: 3, configured: true });
  assert.equal(f.values.has('a'.repeat(64)), false); assert.equal(f.state().pending, null);
});
test('failed verifier preserves active value and sanitizes exceptions', async () => {
  const f = fixture(); const lifecycle = new SecretLifecycle(f.store, f.journal);
  await assert.rejects(lifecycle.replace('new-dummy', 0, async () => { throw new Error('do-not-return-private-details'); }), (error: unknown) => {
    assert.ok(error instanceof ProtectedStoreError); assert.equal(error.code, 'SECRET_VERIFICATION_FAILED');
    assert.ok(!String(error).includes('private-details')); return true;
  });
  assert.equal(f.state().activeRef, 'a'.repeat(64)); assert.equal(f.values.size, 1);
  await assert.rejects(lifecycle.replace('another', 0, async () => true), /SECRET_REVISION_CONFLICT/);
});
test('recovery discards unverified candidate without invoking verifier or replaying anything', async () => {
  const f = fixture(); f.values.set('b'.repeat(64), 'candidate');
  f.set({ revision: 1, activeRef: 'a'.repeat(64), pending: { candidateRef: 'b'.repeat(64), previousRef: 'a'.repeat(64), phase: 'candidate' } });
  assert.deepEqual(await new SecretLifecycle(f.store, f.journal).recover(), { revision: 2, configured: true });
  assert.equal(f.values.has('b'.repeat(64)), false); assert.equal(f.values.has('a'.repeat(64)), true);
});
test('recovery after reference switch retries retirement idempotently', async () => {
  const f = fixture(); f.values.set('c'.repeat(64), 'dummy');
  f.set({ revision: 2, activeRef: 'c'.repeat(64), pending: { candidateRef: 'c'.repeat(64), previousRef: 'a'.repeat(64), phase: 'switched' } });
  const lifecycle = new SecretLifecycle(f.store, f.journal);
  await lifecycle.recover(); await lifecycle.recover();
  assert.equal(f.values.has('a'.repeat(64)), false); assert.equal(f.state().activeRef, 'c'.repeat(64));
});
test('parallel updates fail closed and raw journal errors are sanitized', async () => {
  const f = fixture(); let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const lifecycle = new SecretLifecycle(f.store, f.journal);
  const first = lifecycle.replace('new-dummy', 0, async () => { await wait; return true; });
  await assert.rejects(lifecycle.recover(), /SECRET_UPDATE_BUSY/);
  await assert.rejects(new SecretLifecycle(f.store, f.journal).recover(), /SECRET_UPDATE_BUSY/);
  release(); await first;
  const broken: SecretJournal = { async withExclusive(action) { return action(); }, async load() { throw new Error('secret-content'); }, async compareAndSwap() { return false; } };
  await assert.rejects(new SecretLifecycle(f.store, broken).recover(), /SECRET_UPDATE_FAILED/);
});
test('corrupt lifecycle journal cannot retire the active reference', async () => {
  const f = fixture();
  f.set({ revision: 2, activeRef: 'a'.repeat(64), pending: { candidateRef: 'a'.repeat(64), previousRef: 'a'.repeat(64), phase: 'switched' } });
  await assert.rejects(new SecretLifecycle(f.store, f.journal).recover(), /SECRET_JOURNAL_INVALID/);
  assert.equal(f.values.has('a'.repeat(64)), true);
});
test('Windows provider rejects unsafe root/ref and unsupported platform', async () => {
  if (process.platform !== 'win32') { assert.throws(() => new WindowsSecretStore('/tmp/store'), /PROTECTED_API_UNAVAILABLE/); return; }
  for (const root of ['C:\\', '\\\\server\\share', 'relative', 'C:\\store:ads', 'C:\\x\\..\\y', 'C:\\bad.']) assert.throws(() => new WindowsSecretStore(root), /INVALID_SECRET_PATH/);
  const store = new WindowsSecretStore('C:\\unused-test-path');
  for (const ref of ['../escape', 'a'.repeat(64) + '\n', 'A'.repeat(64), { toString: () => 'a'.repeat(64) }]) {
    await assert.rejects(store.read(ref as string), /INVALID_SECRET_REF/);
    await assert.rejects(store.retire(ref as string), /INVALID_SECRET_REF/);
  }
  await assert.rejects(store.create(''), /INVALID_SECRET/);
});
test('native DPAPI CurrentUser roundtrip, ciphertext-only file, corruption rejection', { skip: process.platform !== 'win32' }, async t => {
  const parent = await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT ?? tmpdir(), 'dsh-dpapi-test-'));
  const absolute = resolve(parent);
  assert.ok(basename(absolute).startsWith('dsh-dpapi-test-'));
  const root = join(absolute, 'protected');
  const dummy = `native-test-日本語-🔒-${randomBytes(32).toString('hex')}`;
  const store = new WindowsSecretStore(root);
  try {
    let ref: string;
    try { ref = await store.create(dummy); }
    catch (error) {
      assert.ok(error instanceof ProtectedStoreError);
      assert.equal(error.code, 'PROTECTED_STORE_UNSAFE_PATH');
      assert.deepEqual(await readdir(absolute), []);
      // Refusal is not roundtrip evidence. Keep the native requirement explicitly unverified.
      t.skip('Native store refused this temporary fixture; DPAPI roundtrip unverified'); return;
    }
    assert.match(ref, /^[a-f0-9]{64}$/);
    assert.equal(await store.read(ref) === dummy, true);
    const names = await readdir(root); assert.deepEqual(names, [`${ref}.dpapi`]);
    const blob = await readFile(join(root, names[0]!));
    assert.equal(blob.includes(Buffer.from(dummy)), false);
    await writeFile(join(root, names[0]!), randomBytes(80));
    await assert.rejects(store.read(ref), /PROTECTED_STORE_FAILURE/);
    await store.retire(ref); await store.retire(ref);
    assert.deepEqual(await readdir(root), []);
  } finally {
    // Delete only the fresh, verified temporary directory owned by this test.
    assert.equal(resolve(parent), absolute); await rm(absolute, { recursive: true, force: true });
  }
});
