// INTERNAL DESIGN SQLite logic fixtures; never live DSH admission acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { AdmissionInput, AdmissionRun } from '../packages/discord-plugin/admission-journal.js';
const source = new URL('../../packages/discord-plugin/admission-journal.js', import.meta.url);
const { SQLiteAdmissionJournal: Journal, AdmissionJournalError } = await import(source.href) as typeof import('../packages/discord-plugin/admission-journal.js');
const input = (inputId = 'input', override: Partial<AdmissionInput> = {}): AdmissionInput => ({ backendIdentity: 'backend', nativeSessionId: 'session', agentId: 'agent', transport: 'discord', botId: 'bot', inputId, payloadDigest: 'a'.repeat(64), payloadRef: 'b'.repeat(64), guildId: 'guild', channelId: 'channel', threadId: null, actorId: 'actor', bindingId: 'binding', bindingVersion: 1, workspaceAlias: 'workspace', receiverGeneration: 1, leaseEpoch: 1, ...override });
const receipt = (run: AdmissionRun, nativeRunIdOrEquivalent = 'native-run') => ({ clientRequestId: run.clientRequestId, payloadDigest: run.metadata.payloadDigest, run: { backendIdentity: run.metadata.backendIdentity, nativeSessionId: run.metadata.nativeSessionId, nativeRunIdOrEquivalent }, acceptedAt: '2026-10-13T09:00:00.000Z', admissionRevision: 'revision', durable: true as const });
const code = (expected: string) => (error: unknown) => { assert.ok(error instanceof AdmissionJournalError); assert.equal(error.code, expected); assert.equal(error.message, expected); return true; };
test('mock SQLite transactional dedupe fixes IDs and pinned metadata; conflicts cannot retarget', () => {
  const journal = Journal.memoryForTests();
  try {
    assert.equal(journal.durable, false);
    const first = journal.enqueue(input()).run;
    const duplicate = journal.enqueue(input('input', { payloadRef: 'c'.repeat(64), receiverGeneration: 2, leaseEpoch: 2 }));
    assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.run, first); assert.ok(Object.isFrozen(first.metadata));
    for (const override of [{ payloadDigest: 'd'.repeat(64) }, { nativeSessionId: 'other' }, { actorId: 'other' }, { channelId: 'other' }]) assert.throws(() => journal.enqueue(input('input', override)), code('ADMISSION_INPUT_CONFLICT'));
    assert.notEqual(journal.enqueue(input('input', { botId: 'other-bot' })).run.id, first.id);
    assert.equal(journal.listSession('backend', 'session').length, 2);
  } finally { journal.close(); journal.close(); }
});
test('mock FIFO busy keeps sequence and reserved dispatch slot prevents overflow', () => {
  const journal = Journal.memoryForTests();
  try {
    const runs = Array.from({ length: 10 }, (_, index) => journal.enqueue(input(String(index))).run);
    assert.throws(() => journal.enqueue(input('full')), code('ADMISSION_QUEUE_FULL'));
    assert.throws(() => journal.claim(runs[1]!.id, 0), code('ADMISSION_NOT_FIFO_HEAD'));
    const dispatch = journal.claim(runs[0]!.id, 0);
    assert.equal(dispatch.state, 'dispatching');
    assert.throws(() => journal.enqueue(input('reserved')), code('ADMISSION_QUEUE_FULL'));
    const busy = journal.applyResponse(dispatch.id, dispatch.version, { kind: 'busy', activeRun: receipt(dispatch).run, accepted: false });
    assert.equal(busy.state, 'queued'); assert.equal(busy.sequence, runs[0]!.sequence);
    assert.equal(journal.listSession('backend', 'session').filter(run => run.state === 'queued').length, 10);
    const retry = journal.claim(busy.id, busy.version);
    const accepted = journal.applyResponse(retry.id, retry.version, { kind: 'accepted', receipt: receipt(retry) });
    assert.equal(accepted.state, 'accepted'); assert.equal(journal.enqueue(input('new-slot')).run.state, 'queued');
    assert.throws(() => journal.claim(runs[1]!.id, 0), code('ADMISSION_SESSION_BLOCKED'));
  } finally { journal.close(); }
});
test('mock backend/session reservation ignores Agent aliases; stale state/version CAS never updates', () => {
  const journal = Journal.memoryForTests();
  try {
    const first = journal.enqueue(input()).run, second = journal.enqueue(input('second', { agentId: 'alias' })).run;
    const dispatch = journal.claim(first.id, 0);
    assert.throws(() => journal.claim(second.id, 0), code('ADMISSION_SESSION_BLOCKED'));
    assert.throws(() => journal.applyResponse(first.id, 0, { accepted: true }), code('ADMISSION_CAS_CONFLICT'));
    assert.equal(journal.get(first.id)!.state, 'dispatching');
    const unknown = journal.applyResponse(first.id, dispatch.version, undefined);
    assert.equal(unknown.state, 'unknown');
    assert.throws(() => journal.enqueue(input('new-id')), code('ADMISSION_SESSION_UNKNOWN'));
    assert.equal(journal.enqueue(input()).duplicate, true);
    assert.throws(() => journal.applyResponse(unknown.id, unknown.version, { kind: 'accepted', receipt: receipt(unknown) }), code('ADMISSION_CAS_CONFLICT'));
    const restored = journal.reconcileLookup(unknown.id, unknown.version, { kind: 'accepted', receipt: receipt(unknown) });
    assert.equal(restored.state, 'accepted');
    assert.throws(() => journal.reconcileLookup(restored.id, restored.version, { kind: 'unknown' }), code('ADMISSION_CAS_CONFLICT'));
    assert.equal(journal.claim(journal.enqueue(input('other', { backendIdentity: 'independent', agentId: 'independent-agent' })).run.id, 0).state, 'dispatching');
  } finally { journal.close(); }
});
test('mock receipt conflicts preserve prior receipt and nonacceptance never releases unknown', () => {
  const journal = Journal.memoryForTests();
  try {
    let run = journal.claim(journal.enqueue(input()).run.id, 0);
    run = journal.applyResponse(run.id, run.version, { kind: 'duplicate', receipt: receipt(run) });
    const previous = run.receipt;
    run = journal.markUnknown(run.id, run.version);
    run = journal.reconcileLookup(run.id, run.version, { kind: 'accepted', receipt: receipt(run, 'foreign') });
    assert.equal(run.state, 'unknown'); assert.deepEqual(run.receipt, previous);
    run = journal.reconcileLookup(run.id, run.version, { kind: 'not-accepted', proof: 'synthetic-private-proof' });
    assert.equal(run.state, 'unknown'); assert.deepEqual(run.receipt, previous);
    assert.ok(!JSON.stringify(run).includes('private-proof'));
    run = journal.reconcileLookup(run.id, run.version, { kind: 'accepted', receipt: previous }); assert.equal(run.state, 'accepted');
  } finally { journal.close(); }
});
test('mock definite rejection frees reservation; malformed replies remain unknown; closed callbacks sanitized', () => {
  const journal = Journal.memoryForTests();
  const first = journal.claim(journal.enqueue(input()).run.id, 0);
  const failed = journal.applyResponse(first.id, first.version, { kind: 'rejected', code: 'REJECTED', accepted: false });
  assert.equal(failed.state, 'failed');
  const second = journal.claim(journal.enqueue(input('second')).run.id, 0);
  const unknown = journal.applyResponse(second.id, second.version, { kind: 'accepted', receipt: { ...receipt(second), payloadDigest: 'wrong' } });
  assert.equal(unknown.state, 'unknown');
  journal.close();
  assert.throws(() => journal.get(first.id), code('ADMISSION_CLOSED'));
  assert.throws(() => journal.applyResponse(second.id, second.version, {}), code('ADMISSION_CLOSED'));
});
test('mock metadata rejects raw bodies, accessors, proxies, hidden fields and arbitrary paths', () => {
  const journal = Journal.memoryForTests(); let calls = 0;
  const accessor = { ...input(), get actorId(): string { calls++; throw new Error('private'); } };
  for (const value of [{ ...input(), prompt: 'synthetic-private-prompt' }, { ...input(), payloadRef: '../private' }, accessor, new Proxy(input(), { ownKeys() { calls++; throw new Error('private'); } }), Object.defineProperty(input(), 'hidden', { value: true }), { ...input(), [Symbol('hidden')]: true }, { ...input(), actorId: 'actor\nprivate' }, { ...input(), bindingVersion: -1 }]) assert.throws(() => journal.enqueue(value), code('ADMISSION_INVALID_INPUT'));
  assert.equal(calls, 0); assert.equal(journal.listSession('backend', 'session').length, 0); journal.close();
});
test('mock Agent-wide default capacity spans Sessions/backends and retains accepted/unknown', () => {
  const journal = Journal.memoryForTests();
  try {
    let first = journal.claim(journal.enqueue(input()).run.id, 0);
    const second = journal.enqueue(input('second-session', { nativeSessionId: 'second-session' })).run;
    const backend = journal.enqueue(input('other-backend', { backendIdentity: 'other-backend' })).run;
    for (const candidate of [second, backend]) {
      assert.throws(() => journal.claim(candidate.id, candidate.version), code('ADMISSION_AGENT_CAPACITY'));
      assert.deepEqual(journal.get(candidate.id), candidate);
    }
    first = journal.applyResponse(first.id, first.version, { kind: 'accepted', receipt: receipt(first) });
    assert.throws(() => journal.claim(second.id, 0), code('ADMISSION_AGENT_CAPACITY'));
    first = journal.markUnknown(first.id, first.version);
    const newId = journal.enqueue(input('unknown-bypass', { nativeSessionId: 'new-session' })).run;
    assert.throws(() => journal.claim(newId.id, 0), code('ADMISSION_AGENT_CAPACITY'));
    first = journal.reconcileLookup(first.id, first.version, { kind: 'not-accepted', proof: 'untrusted' });
    assert.equal(first.state, 'unknown');
    assert.throws(() => journal.claim(backend.id, 0), code('ADMISSION_AGENT_CAPACITY'));
    const independent = journal.enqueue(input('other-agent', { agentId: 'other-agent', nativeSessionId: 'independent' })).run;
    assert.equal(journal.claim(independent.id, 0).state, 'dispatching');
  } finally { journal.close(); }
});
test('mock configured capacity counts decoded snapshots, rejects invalid limits and retains lowered-budget states', () => {
  const journal = Journal.memoryForTests();
  try {
    const first = journal.enqueue(input()).run;
    for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER - 1, null, '2']) {
      assert.throws(() => journal.claim(first.id, 0, limit as number), code('ADMISSION_INVALID_INPUT'));
      assert.deepEqual(journal.get(first.id), first);
    }
    const second = journal.enqueue(input('second', { nativeSessionId: 'second' })).run;
    const third = journal.enqueue(input('third', { nativeSessionId: 'third' })).run;
    const dispatch1 = journal.claim(first.id, 0, 2), dispatch2 = journal.claim(second.id, 0, 2);
    assert.throws(() => journal.claim(third.id, 0, 2), code('ADMISSION_AGENT_CAPACITY'));
    assert.throws(() => journal.claim(third.id, 0, 1), code('ADMISSION_AGENT_CAPACITY'));
    assert.deepEqual(journal.get(first.id), dispatch1); assert.deepEqual(journal.get(second.id), dispatch2);
    const busy = journal.applyResponse(dispatch1.id, dispatch1.version, { kind: 'busy', accepted: false, activeRun: receipt(dispatch1).run });
    assert.equal(busy.state, 'queued');
    assert.throws(() => journal.claim(third.id, 0), code('ADMISSION_AGENT_CAPACITY'));
    const rejected = journal.applyResponse(dispatch2.id, dispatch2.version, { kind: 'rejected', accepted: false, code: 'REJECTED' });
    assert.equal(rejected.state, 'failed');
    assert.equal(journal.claim(third.id, 0).state, 'dispatching');
    assert.throws(() => journal.claim(first.id, 0, 2), code('ADMISSION_CAS_CONFLICT'));
    assert.deepEqual(journal.get(first.id), busy);
  } finally { journal.close(); }
});
test('production private roots reject unsafe paths without raw errors', async () => {
  for (const path of ['relative', process.platform === 'win32' ? 'C:\\' : '/', 'relative\0private']) await assert.rejects(Journal.open(path), code('ADMISSION_PRIVATE_PATH_UNSAFE'));
});
test('native private SQLite reopen/process crash/schema refusal; skipped if production protection refuses fixture', async t => {
  const temp = resolve(await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT ?? tmpdir(), 'dsh-admission-test-'))); assert.ok(basename(temp).startsWith('dsh-admission-test-'));
  const root = join(temp, 'private'); let journal: import('../packages/discord-plugin/admission-journal.js').SQLiteAdmissionJournal | undefined;
  try {
    try { journal = await Journal.open(root); }
    catch (error) { assert.ok(error instanceof AdmissionJournalError); assert.equal(error.code, 'ADMISSION_PRIVATE_PATH_UNSAFE'); t.skip('Production private hierarchy refused: real SQLite durability/process crash/schema tests unverified'); return; }
    assert.equal(journal.durable, true);
    const queued = journal.enqueue(input()).run;
    await assert.rejects(Journal.open(root), code('ADMISSION_WRITER_BUSY'));
    journal.close(); journal = undefined;
    const childSource = `import { SQLiteAdmissionJournal } from ${JSON.stringify(source.href)}; const j=await SQLiteAdmissionJournal.open(${JSON.stringify(root)}); j.claim(${JSON.stringify(queued.id)},0); process.exit(0);`;
    await new Promise<void>((done, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], { stdio: 'ignore' }); child.once('error', reject); child.once('close', exit => exit === 0 ? done() : reject(new Error('ADMISSION_CRASH_FIXTURE_FAILED'))); });
    journal = await Journal.open(root); const recovered = journal.get(queued.id)!;
    assert.equal(recovered.state, 'unknown'); assert.equal(recovered.version, 2); assert.equal(recovered.clientRequestId, queued.clientRequestId);
    assert.throws(() => journal!.claim(queued.id, recovered.version), code('ADMISSION_CAS_CONFLICT'));
    const restored = journal.reconcileLookup(queued.id, recovered.version, { kind: 'accepted', receipt: receipt(recovered) });
    journal.close(); journal = await Journal.open(root); assert.deepEqual(journal.get(queued.id), restored);
    journal.close(); journal = undefined;
    const file = join(root, 'admission-journal.sqlite');
    const duplicateKeys = new DatabaseSync(file);
    const storedMetadata = duplicateKeys.prepare('SELECT metadata FROM admission_runs WHERE id=?').get(queued.id)!.metadata as string;
    duplicateKeys.prepare('UPDATE admission_runs SET metadata=? WHERE id=?').run(storedMetadata.replace('"agentId":"agent"', '"agentId":"different-agent","agentId":"agent"'), queued.id);
    duplicateKeys.close();
    journal = await Journal.open(root);
    assert.equal(journal.get(queued.id)!.metadata.agentId, 'agent');
    const blocked = journal.enqueue(input('duplicate-key-capacity', { nativeSessionId: 'capacity-session' })).run;
    assert.throws(() => journal!.claim(blocked.id, blocked.version), code('ADMISSION_AGENT_CAPACITY'));
    assert.deepEqual(journal.get(blocked.id), blocked);
    journal.close(); journal = undefined;
    for (const [state, version] of [['queued', 1], ['dispatching', 0], ['failed', 0]] as const) {
      const unreachable = new DatabaseSync(file);
      unreachable.prepare('UPDATE admission_runs SET state=?,version=? WHERE id=?').run(state, version, blocked.id);
      unreachable.close();
      const unreachableBefore = await readFile(file);
      await assert.rejects(Journal.open(root), code('ADMISSION_DATA_INVALID'));
      assert.deepEqual(await readFile(file), unreachableBefore);
    }
    const reachabilityRepair = new DatabaseSync(file);
    reachabilityRepair.prepare("UPDATE admission_runs SET state='queued',version=0 WHERE id=?").run(blocked.id);
    reachabilityRepair.close();
    const nearDb = new DatabaseSync(file);
    nearDb.prepare('UPDATE admission_runs SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER - 3, blocked.id);
    nearDb.close();
    journal = await Journal.open(root);
    assert.equal(journal.get(blocked.id)!.state, 'queued');
    const nearBefore = await readFile(file);
    assert.throws(() => journal!.claim(blocked.id, Number.MAX_SAFE_INTEGER - 3, 2), code('ADMISSION_DATA_INVALID'));
    assert.deepEqual(await readFile(file), nearBefore);
    journal.close(); journal = await Journal.open(root);
    assert.equal(journal.get(blocked.id)!.version, Number.MAX_SAFE_INTEGER - 3);
    journal.close(); journal = undefined;
    const sequenceDb = new DatabaseSync(file);
    sequenceDb.exec(`UPDATE sqlite_sequence SET seq=${Number.MAX_SAFE_INTEGER - 2} WHERE name='admission_runs'`);
    sequenceDb.close();
    journal = await Journal.open(root);
    assert.deepEqual(journal.get(queued.id), restored);
    const sequenceBefore = await readFile(file);
    assert.throws(() => journal!.enqueue(input('sequence-exhausted')), code('ADMISSION_DATA_INVALID'));
    assert.deepEqual(await readFile(file), sequenceBefore);
    journal.close(); journal = await Journal.open(root);
    assert.deepEqual(journal.get(queued.id), restored);
    journal.close(); journal = undefined;
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version=2;'); db.close();
    const before = await readFile(file); await assert.rejects(Journal.open(root), code('ADMISSION_SCHEMA_INCOMPATIBLE')); assert.deepEqual(await readFile(file), before);
    const exhausted = new DatabaseSync(file);
    exhausted.exec(`PRAGMA user_version=1; UPDATE admission_runs SET state='dispatching',receipt=NULL,version=${Number.MAX_SAFE_INTEGER - 2}`);
    exhausted.close();
    const exhaustedBefore = await readFile(file);
    await assert.rejects(Journal.open(root), code('ADMISSION_DATA_INVALID'));
    assert.deepEqual(await readFile(file), exhaustedBefore);
    const corrupt = new DatabaseSync(file); corrupt.exec("UPDATE admission_runs SET version=0,metadata='{}'"); corrupt.close();
    const corruptBefore = await readFile(file);
    await assert.rejects(Journal.open(root), code('ADMISSION_DATA_INVALID'));
    assert.deepEqual(await readFile(file), corruptBefore);
    for (const applicationId of [12345, 0]) {
      const foreign = new DatabaseSync(file);
      foreign.exec('DROP TABLE IF EXISTS admission_runs; DROP TABLE IF EXISTS admission_schema; PRAGMA user_version=0;');
      foreign.exec(`PRAGMA application_id=${applicationId};`);
      assert.ok(foreign.prepare('PRAGMA page_count').get()!.page_count as number > 0);
      foreign.close();
      const foreignBefore = await readFile(file);
      await assert.rejects(Journal.open(root), code('ADMISSION_SCHEMA_INCOMPATIBLE'));
      assert.deepEqual(await readFile(file), foreignBefore);
    }
  } finally { journal?.close(); assert.equal(resolve(temp), temp); await rm(temp, { recursive: true, force: true }); }
});
