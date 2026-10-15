import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { HostSecretStore, SecretJournalState } from '../packages/discord-plugin/windows-secrets.js';
const { SQLiteSecretJournal } = await import(new URL('../../packages/discord-plugin/secret-journal.js', import.meta.url).href) as typeof import('../packages/discord-plugin/secret-journal.js');
const { SecretLifecycle, ProtectedStoreError } = await import(new URL('../../packages/discord-plugin/windows-secrets.js', import.meta.url).href) as typeof import('../packages/discord-plugin/windows-secrets.js');
const old = 'a'.repeat(64), candidate = 'b'.repeat(64);
function store() {
  const values = new Map([[old, 'old-dummy'], [candidate, 'new-dummy']]);
  const api: HostSecretStore = { async create(value) { const ref = randomBytes(32).toString('hex'); values.set(ref, value); return ref; }, async read(ref) { return values.get(ref)!; }, async retire(ref) { values.delete(ref); } };
  return { values, api };
}
test('durable journal reopen, CAS, concurrent verification guard and recovery phases', async t => {
  const temp = resolve(await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT ?? tmpdir(), 'dsh-journal-test-')));
  assert.ok(basename(temp).startsWith('dsh-journal-test-'));
  const root = join(temp, 'private'); let journal: import('../packages/discord-plugin/secret-journal.js').SQLiteSecretJournal | undefined;
  try {
    try { journal = await SQLiteSecretJournal.open(root); }
    catch (e) {
      assert.ok(e instanceof ProtectedStoreError);
      assert.equal(e.code, 'PROTECTED_STORE_UNSAFE_PATH');
      t.skip('Native private path refused; durable SQLite integration unverified on this fixture'); return;
    }
    const first = journal;
    await assert.rejects(first.compareAndSwap(0, { revision: 1, activeRef: old, pending: null }), /SECRET_EXCLUSIVE_UNAVAILABLE/);
    await first.withExclusive(async () => {
      assert.equal(await first.compareAndSwap(0, { revision: 1, activeRef: old, pending: null }), true);
      assert.equal(await first.compareAndSwap(0, { revision: 1, activeRef: candidate, pending: null }), false);
    });
    first.close(); journal = await SQLiteSecretJournal.open(root);
    assert.deepEqual(await journal.load(), { revision: 1, activeRef: old, pending: null });
    const second = await SQLiteSecretJournal.open(root);
    try {
      const f = store(); let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(r => { release = r; }); const ready = new Promise<void>(r => { entered = r; });
      const rotate = new SecretLifecycle(f.api, journal).replace('transient-dummy-never-in-sqlite', 1, async () => { entered(); await gate; return true; });
      await ready;
      await assert.rejects(new SecretLifecycle(f.api, second).recover(), /SECRET_UPDATE_BUSY/);
      await assert.rejects(new SecretLifecycle(f.api, second).delete(2, true), /SECRET_UPDATE_BUSY/);
      release(); assert.deepEqual(await rotate, { revision: 4, configured: true });
      assert.equal((await readFile(join(root, 'secret-journal.sqlite'))).includes(Buffer.from('transient-dummy-never-in-sqlite')), false);
    } finally { second.close(); }
    // Simulate crashes by persisting each exact boundary then closing/reopening.
    for (const phase of ['candidate', 'switched', 'deleting'] as const) {
      const f = store(); const state = await journal.load();
      const pending: SecretJournalState = phase === 'deleting'
        ? { revision: state.revision + 1, activeRef: null, pending: { candidateRef: null, previousRef: old, phase } }
        : { revision: state.revision + 1, activeRef: phase === 'candidate' ? old : candidate, pending: { candidateRef: candidate, previousRef: old, phase } };
      journal.close(); journal = undefined;
      // Exit without close/ROLLBACK while holding the guard: OS releases guard,
      // independently committed state must survive this actual process boundary.
      const moduleURL = new URL('../../packages/discord-plugin/secret-journal.js', import.meta.url).href;
      const source = `import { SQLiteSecretJournal } from ${JSON.stringify(moduleURL)}; const j = await SQLiteSecretJournal.open(${JSON.stringify(root)}); await j.withExclusive(async () => { if (!await j.compareAndSwap(${state.revision}, ${JSON.stringify(pending)})) process.exit(2); process.exit(0); });`;
      await new Promise<void>((done, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
        child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error('DUMMY_CRASH_FIXTURE_FAILED')));
      });
      journal = await SQLiteSecretJournal.open(root);
      const lifecycle = new SecretLifecycle(f.api, journal);
      assert.deepEqual(await lifecycle.recover(), { revision: pending.revision + 1, configured: phase !== 'deleting' });
      assert.equal(f.values.has(phase === 'candidate' ? candidate : old), false);
      const done = await lifecycle.recover(); assert.equal(done.revision, pending.revision + 1);
    }
  } finally { journal?.close(); assert.equal(resolve(temp), temp); await rm(temp, { recursive: true, force: true }); }
});
test('exact opaque refs refuse corrupt state before any store deletion; keep/delete are scoped', async () => {
  const f = store(); let state: SecretJournalState = { revision: 0, activeRef: old, pending: null };
  const journal = { async withExclusive<T>(action: () => Promise<T>) { return action(); }, async load() { return state; }, async compareAndSwap(revision: number, next: SecretJournalState) { if (state.revision !== revision) return false; state = next; return true; } };
  const lifecycle = new SecretLifecycle(f.api, journal);
  assert.deepEqual(await lifecycle.keep(0), { revision: 0, configured: true });
  await assert.rejects(lifecycle.delete(0, false), /SECRET_DELETE_CONFIRMATION_REQUIRED/);
  for (const ref of ['arbitrary', old + '\n', old.toUpperCase(), '../escape']) {
    state = { revision: 0, activeRef: ref, pending: null };
    await assert.rejects(lifecycle.delete(0, true), /SECRET_JOURNAL_INVALID/); assert.equal(f.values.has(old), true);
  }
  state = { revision: 0, activeRef: old, pending: null };
  let refuseRetire = true;
  const failing: HostSecretStore = { ...f.api, async retire(ref) { if (refuseRetire) throw new Error('private-failure'); await f.api.retire(ref); } };
  const deletion = new SecretLifecycle(failing, journal);
  await assert.rejects(deletion.delete(0, true), /SECRET_UPDATE_FAILED/);
  assert.equal(state.pending?.phase, 'deleting'); assert.equal(f.values.has(old), true);
  refuseRetire = false;
  assert.deepEqual(await deletion.recover(), { revision: 2, configured: false }); assert.equal(f.values.has(candidate), true);
});
