import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { validateLocalUrl } from '../src/config.js';
import { Policy } from '../src/policy.js';
import { Store } from '../src/store.js';
import { Engine, type Actor } from '../src/engine.js';
import { DshRejected } from '../src/dsh.js';
import { AppError, safeError } from '../src/errors.js';
import { redact, assistantText, tail } from '../src/output.js';
import { resultPayload } from '../src/bot.js';
import { command } from '../src/commands.js';
import type { AgentAdapter, SessionInfo, Snapshot, WireEvent } from '../src/types.js';
const actor: Actor = { userId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' };
const event = (seq: number, type: string, data: Record<string, unknown>, surfaceOp?: unknown): WireEvent => ({ seq, type, data, time: 1, surfaceOp });
function completed(requestId: string, start = 0, kind = 'completed'): WireEvent[] {
  return [event(start, 'turn/start', { turn: 1 }), event(start + 1, 'user/message', { role: 'user', source: { kind: 'user', rpcId: requestId }, content: [] }, 'append'),
    event(start + 2, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done SECRET_TOKEN' }, { type: 'reasoning', text: 'private reasoning' }] } }, 'append'),
    event(start + 3, 'turn/end', { turn: 1, reason: { kind } })];
}
class FakeAdapter implements AgentAdapter {
  rows: SessionInfo[] = [];
  log: WireEvent[] = []; promptCalls = 0; createCalls = 0;
  promptError: Error | undefined; readError: Error | undefined;
  inbox: Record<string, unknown> = { 'next-turn': [], 'next-step': [] };
  async list(): Promise<SessionInfo[]> { return this.rows; }
  async create(cwd: string): Promise<string> { this.createCalls++; this.rows.push({ sessionId: 'new', cwd, running: false, title: 'new', subagent: false, updatedAt: 1 }); return 'new'; }
  async snapshot(): Promise<Snapshot> { if (this.readError) throw this.readError; return { cursor: this.log.at(-1)?.seq ?? -1, values: { inbox: this.inbox } }; }
  async events(_id: string, through: number, after: number): Promise<WireEvent[]> { if (this.readError) throw this.readError; return this.log.filter(e => e.seq > after && e.seq <= through); }
  async prompt(): Promise<void> { this.promptCalls++; if (this.promptError) throw this.promptError; }
}
async function setup(t: { after: (fn: () => unknown) => void }, metadataOnly = false) {
  const dir = await mkdtemp(join(tmpdir(), 'discord-agents-test-'));
  const config: Config = { token: 'discordsecret', applicationId: '444444444444444444', guildId: actor.guildId,
    allowedUserIds: new Set([actor.userId, '555555555555555555']), allowedChannelIds: new Set([actor.channelId, '666666666666666666']),
    workspaces: { test: dir }, dshUrl: 'http://127.0.0.1:19387', dshToken: 'SECRET_TOKEN', pollIntervalMs: 5000, databasePath: join(dir, 'bot.sqlite') };
  const policy = await Policy.create(config); const store = new Store(config.databasePath, metadataOnly);
  if (metadataOnly) store.setSetting('restricted-storage-profile', 'single-operator-text-v1');
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const adapter = new FakeAdapter(); adapter.rows = [{ sessionId: 'old', cwd: dir, running: false, title: 'existing', updatedAt: 1, subagent: false }];
  const engine = new Engine(adapter, store, policy, [config.dshToken]); await engine.bind(actor, 'old');
  return { dir, config, policy, store, adapter, engine };
}
test('loopback URL only, no token/userinfo/path/TLS/nonlocal host', () => {
  for (const url of ['https://127.0.0.1:19387', 'http://192.168.1.2:19387', 'http://user:x@localhost:123', 'http://localhost:123/?token=secret', 'http://localhost:123/path']) assert.throws(() => validateLocalUrl(url));
  assert.equal(validateLocalUrl('http://127.0.0.1:19387/'), 'http://127.0.0.1:19387');
});
test('deny DM, other users, guilds and channels; exact cwd not descendants', async t => {
  const { engine, policy, dir, adapter } = await setup(t);
  for (const who of [{ ...actor, userId: '999' }, { ...actor, guildId: '999' }, { ...actor, channelId: '999' }]) {
    await assert.rejects(engine.submit(who, '1', 'hello'), { code: 'NOT_AUTHORIZED' });
  }
  assert.throws(() => policy.authorize(actor.userId, null, null), { code: 'NOT_AUTHORIZED' });
  assert.equal(adapter.promptCalls, 0); assert.equal(await policy.allowsCwd(join(dir, 'nested')), false);
  assert.equal(await policy.allowsCwd(dir), true);
});
test('existing selection and one durable prompt; duplicate interaction not resent', async t => {
  const { engine, adapter, store } = await setup(t);
  const run = await engine.submit(actor, '1', 'hello'); assert.equal(run.state, 'accepted');
  assert.equal(store.get('1')?.lastSeq, -1); assert.equal(store.get('1')?.requestId, 'discord:1');
  await engine.submit(actor, '1', 'hello'); assert.equal(adapter.promptCalls, 1);
   await assert.rejects(engine.submit(actor, '1', 'again'), { code: 'REQUEST_CONFLICT' });
   assert.equal(adapter.promptCalls, 1);
  await assert.rejects(engine.submit(actor, '2', 'parallel'), { code: 'RUN_BUSY' });
});
test('concurrent submissions are fenced by unique session index', async t => {
  const { engine, adapter } = await setup(t);
  const results = await Promise.allSettled([engine.submit(actor, '1', 'one'), engine.submit(actor, '2', 'two')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(adapter.promptCalls, 1);
});
test('accepted is not completed; correlate turn, hide reasoning, redact token, DM outbox', async t => {
  const { engine, adapter, store } = await setup(t); await engine.submit(actor, '1', 'hello');
  adapter.log = completed('discord:1').slice(0, 3);
  let deliveries = 0; await engine.tick(async () => { deliveries++; });
  assert.equal(store.get('1')?.state, 'running'); assert.equal(deliveries, 0);
  adapter.log = completed('discord:1'); await engine.tick(async run => {
    deliveries++; assert.equal(run.result, 'done [REDACTED]'); assert.equal(run.state, 'succeeded');
  });
  assert.equal(deliveries, 1); assert.equal(store.get('1')?.notification, 'sent');
  await engine.tick(async () => { deliveries++; }); assert.equal(deliveries, 1);
});
test('lost prompt response remains unknown, locks session, never resends, reconciles exact rpcId', async t => {
  const { engine, adapter, store } = await setup(t); adapter.promptError = new AppError('DSH_OFFLINE', 'offline');
  const run = await engine.submit(actor, '1', 'hello'); assert.equal(run.state, 'unknown');
  await assert.rejects(engine.submit(actor, '2', 'new'), { code: 'RUN_BUSY' });
  await engine.tick(async () => {}); assert.equal(store.get('1')?.state, 'unknown');
  adapter.log = completed('discord:1'); await engine.tick(async () => {});
  assert.equal(store.get('1')?.state, 'succeeded'); assert.equal(adapter.promptCalls, 1);
});
test('foreign turn does not count as our completion; mixed same-turn result is withheld', async t => {
  const { engine, adapter, store } = await setup(t); await engine.submit(actor, '1', 'hello');
  adapter.log = completed('foreign'); await engine.tick(async () => assert.fail('not ours'));
  assert.equal(store.get('1')?.state, 'accepted'); assert.equal(store.get('1')?.output, '');
  const ours = completed('discord:1', 4).map(e => ({ ...e, data: { ...e.data, ...(e.type.startsWith('turn/') || e.type === 'assistant/message' ? { turn: 2 } : {}) } }));
  ours.splice(2, 0, event(6, 'user/message', { source: { kind: 'user', rpcId: 'other' } }, 'append'));
  ours[3]!.seq = 7; ours[4]!.seq = 8; adapter.log.push(...ours);
  await engine.tick(async run => { assert.equal(run.state, 'interrupted'); assert.equal(run.output, ''); assert.match(run.result, /混在/); });
});
test('turn candidate persists across polls before matching user event', async t => {
  const { engine, adapter, store } = await setup(t); await engine.submit(actor, '1', 'hello');
  adapter.log = completed('discord:1').slice(0, 1); await engine.tick(async () => {});
  assert.equal(store.get('1')?.turn, 1); assert.equal(store.get('1')?.admitted, false);
  adapter.log = completed('discord:1'); await engine.tick(async () => {}); assert.equal(store.get('1')?.state, 'succeeded');
});
test('run target pinned after rebind; ownership enforced; allowed cwd rechecked before result', async t => {
  const { engine, adapter, store, dir } = await setup(t); await engine.submit(actor, '1', 'hello');
  adapter.rows.push({ sessionId: 'second', cwd: dir, running: false, title: 'second', subagent: false, updatedAt: 2 });
  await engine.bind(actor, 'second'); assert.equal(store.get('1')?.sessionId, 'old');
  await assert.rejects(engine.status({ ...actor, userId: '555555555555555555' }, '1'), { code: 'RUN_NOT_FOUND' });
  adapter.rows[0]!.cwd = tmpdir(); await assert.rejects(engine.status(actor, '1'), { code: 'WORKSPACE_FORBIDDEN' });
  adapter.log = completed('discord:1'); await engine.tick(async () => assert.fail('forbidden disclosure'));
  assert.equal(store.get('1')?.state, 'accepted'); assert.equal(store.get('1')?.lastSeq, -1);
});
test('busy GUI/inbox prevents submission; forbidden sessions and subagents excluded', async t => {
  const { engine, adapter, dir } = await setup(t); adapter.rows[0]!.running = true;
  await assert.rejects(engine.submit(actor, '1', 'hello'), { code: 'SESSION_BUSY' }); adapter.rows[0]!.running = false;
  adapter.inbox['next-turn'] = [{}]; await assert.rejects(engine.submit(actor, '1', 'hello'), { code: 'SESSION_BUSY' });
  adapter.rows.push({ sessionId: 'child', cwd: dir, running: false, subagent: true, title: 'child', updatedAt: 1 });
  adapter.rows.push({ sessionId: 'forbidden', cwd: tmpdir(), running: false, subagent: false, title: 'outside', updatedAt: 1 });
  assert.deepEqual((await engine.sessions()).map(s => s.sessionId), ['old']);
  await assert.rejects(engine.bind(actor, 'child'), { code: 'SESSION_NOT_FOUND' }); assert.equal(adapter.promptCalls, 0);
});
test('explicit rejection fails, network failure does not advance cursor, cancel/error are not success', async t => {
  const { engine, adapter, store } = await setup(t); adapter.promptError = new DshRejected('DSH_AUTH', 'invalid');
  assert.equal((await engine.submit(actor, '1', 'hello')).state, 'failed'); adapter.promptError = undefined;
  await engine.submit(actor, '2', 'hello'); adapter.readError = new AppError('DSH_OFFLINE', 'offline');
  await engine.tick(async () => {}); assert.equal(store.get('2')?.lastSeq, -1); adapter.readError = undefined;
  adapter.log = completed('discord:2', 0, 'aborted'); await engine.tick(async () => {}); assert.equal(store.get('2')?.state, 'interrupted');
});
test('DM failure retained, manual retry, revoked user receives no notification', async t => {
  const { engine, adapter, store, config } = await setup(t); await engine.submit(actor, '1', 'hello'); adapter.log = completed('discord:1');
  await engine.tick(async () => { throw new AppError('DM_FAILED', 'blocked'); });
  assert.equal(store.get('1')?.notification, 'pending'); assert.equal(store.get('1')?.notifyAttempts, 1);
  await engine.retryNotification(actor, '1'); config.allowedUserIds.delete(actor.userId);
  await engine.tick(async () => assert.fail('revoked')); assert.equal(store.get('1')?.notification, 'pending');
  config.allowedUserIds.add(actor.userId); await engine.tick(async () => {}); assert.equal(store.get('1')?.notification, 'sent');
});
test('restart recovery marks dispatching unknown without prompt replay; SQLite excludes second process', async t => {
  const { engine, adapter, store, config } = await setup(t); const run = await engine.submit(actor, '1', 'hello'); run.state = 'dispatching'; store.save(run);
  assert.throws(() => new Store(config.databasePath), { code: 'DB_UNAVAILABLE' });
  new Engine(adapter, store, engine.policy); assert.equal(store.get('1')?.state, 'unknown'); assert.equal(adapter.promptCalls, 1);
});
test('new accepts only configured workspace alias', async t => {
  const { engine, adapter } = await setup(t); await assert.rejects(engine.create(actor, '../../bad'), { code: 'WORKSPACE_FORBIDDEN' });
  assert.equal(adapter.createCalls, 0); assert.equal(await engine.create(actor, 'test'), 'new'); assert.equal(engine.binding(actor), 'new');
});
test('no raw errors/analysis in output, safe Unicode preview, long result attachment, slash payload valid', async t => {
  assert.doesNotMatch(safeError(new Error('token SECRET')), /SECRET/);
  assert.equal(assistantText({ message: { role: 'assistant', content: [{ type: 'reasoning', text: 'secret' }, { type: 'text', text: 'okay' }] } }), 'okay');
  assert.equal(redact('a SECRET_TOKEN b', ['SECRET_TOKEN']), 'a [REDACTED] b'); assert.equal(tail('😀😀😀', 3), '…😀');
  const { engine } = await setup(t); const run = await engine.submit(actor, '1', 'hello'); run.output = '😀'.repeat(5000);
  const payload = resultPayload(run); assert.ok(payload.content.length <= 2000); assert.equal(payload.files.length, 1);
  assert.equal(command.toJSON().name, 'agent');
});
test('durable rows survive actual close/reopen; no resend during restart recovery', async t => {
  const { engine, adapter, store, config, policy } = await setup(t);
  const run = await engine.submit(actor, '1', 'hello'); run.state = 'dispatching'; store.save(run); store.close();
  const reopened = new Store(config.databasePath);
  try {
    const restored = new Engine(adapter, reopened, policy, [config.dshToken]);
    assert.equal(restored.binding(actor), 'old'); assert.equal(reopened.get('1')?.state, 'unknown');
    adapter.log = completed('discord:1'); await restored.tick(async () => {});
    assert.equal(reopened.get('1')?.state, 'succeeded'); assert.equal(adapter.promptCalls, 1);
  } finally { reopened.close(); }
});
test('cached status metadata remains available offline but result access stays fail-closed', async t => {
  const { engine, adapter } = await setup(t); await engine.submit(actor, '1', 'hello');
  adapter.rows = [];
  assert.equal((await engine.status(actor, '1', false))?.state, 'accepted');
  await assert.rejects(engine.status(actor, '1'), { code: 'SESSION_NOT_FOUND' });
});
test('restricted metadata disk excludes bodies, rehydrates only correlated terminal history, never replays unknown notify', async t => {
  const { engine, adapter, store, config, policy } = await setup(t, true);
  await engine.submit(actor, 'metadata-1', 'unique_prompt_DO_NOT_STORE');
  adapter.log = completed('discord:metadata-1');
  adapter.log[2]!.data = { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'unique_assistant_DO_NOT_STORE' }] } };
  await engine.tick(async () => { throw new AppError('NOTIFICATION_UNKNOWN', 'uncertain delivery'); });
  assert.equal(store.get('metadata-1')?.notification, 'unknown'); store.close();
  const disk = (await readFile(config.databasePath)).toString('utf8');
  assert.ok(!disk.includes('unique_prompt_DO_NOT_STORE')); assert.ok(!disk.includes('unique_assistant_DO_NOT_STORE'));
  const reopened = new Store(config.databasePath, true);
  try {
    const restored = new Engine(adapter, reopened, policy, [config.dshToken], true);
    assert.equal(reopened.get('metadata-1')?.bodyMissing, true);
    adapter.log = completed('another-request');
    await assert.rejects(restored.status(actor, 'metadata-1'), { code: 'BODY_UNAVAILABLE' });
    assert.equal(reopened.get('metadata-1')?.bodyMissing, true);
    adapter.log = completed('discord:metadata-1');
    await assert.rejects(restored.status(actor, 'metadata-1'), { code: 'BODY_DIGEST_MISMATCH' });
    assert.equal((await restored.status(actor, 'metadata-1', true, false))?.state, 'succeeded');
    adapter.log[2]!.data = { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'unique_assistant_DO_NOT_STORE' }] } };
    assert.equal((await restored.status(actor, 'metadata-1'))?.result, 'unique_assistant_DO_NOT_STORE');
    await restored.tick(async () => assert.fail('unknown notification must not replay'));
    await assert.rejects(restored.retryNotification(actor, 'metadata-1'), { code: 'DUPLICATE_RISK_CONFIRMATION_REQUIRED' });
    assert.equal(adapter.promptCalls, 1);
  } finally { reopened.close(); }
});
test('restricted notification attempt survives close/reopen during send and cannot replay', async t => {
  const { engine, adapter, store, config, policy } = await setup(t, true);
  await engine.submit(actor, 'crash-notify', 'hello'); adapter.log = completed('discord:crash-notify');
  let resume!: () => void; let reached!: () => void;
  const duringNotify = new Promise<void>(done => { reached = done; });
  const hold = new Promise<void>(done => { resume = done; });
  let sends = 0;
  const interrupted = engine.tick(async run => {
    sends++;
    assert.equal(run.notification, 'unknown'); assert.equal(run.notifyAttempts, 1);
    // Close/reopen interruption simulation, not evidence of an actual OS crash.
    store.close(); reached(); await hold;
  });
  const stoppedWriter = assert.rejects(interrupted);
  await duringNotify;
  const reopened = new Store(config.databasePath, true);
  try {
    const persisted = reopened.get('crash-notify')!;
    assert.equal(persisted.notification, 'unknown'); assert.equal(persisted.notifyAttempts, 1);
    assert.equal(persisted.lastError, 'NOTIFICATION_UNKNOWN');
    const restored = new Engine(adapter, reopened, policy, [config.dshToken], true);
    await restored.tick(async () => { sends++; assert.fail('crash-uncertain notification replayed'); });
    await assert.rejects(restored.retryNotification(actor, 'crash-notify'), { code: 'DUPLICATE_RISK_CONFIRMATION_REQUIRED' });
    assert.equal(sends, 1); assert.equal(adapter.promptCalls, 1);
  } finally { reopened.close(); resume(); await stoppedWriter; }
});
test('restricted definitive refusal remains blocked through unavailable preflight without network', async t => {
  const { engine, adapter, store } = await setup(t, true);
  await engine.submit(actor, 'preflight-notify', 'hello'); adapter.log = completed('discord:preflight-notify');
  await engine.tick(async () => { throw new AppError('DM_FAILED', 'definitive refusal'); });
  const run = store.get('preflight-notify')!; run.notifyAttempts = 7; run.nextNotifyAt = 0; store.save(run);
  adapter.rows = [];
  await engine.tick(async () => assert.fail('preflight failure must not invoke notify'));
  assert.equal(store.get('preflight-notify')?.notification, 'none');
  assert.equal(store.get('preflight-notify')?.delivery?.parts[0]?.state, 'blocked');
  assert.equal(adapter.promptCalls, 1);
});
test('restricted definitive notification refusal remains eligible for explicit retry', async t => {
  const { engine, adapter, store } = await setup(t, true);
  await engine.submit(actor, 'refused-notify', 'hello'); adapter.log = completed('discord:refused-notify');
  await engine.tick(async () => { throw new AppError('DM_FAILED', 'definitive refusal'); });
  assert.equal(store.get('refused-notify')?.notification, 'none');
  assert.equal(store.get('refused-notify')?.delivery?.parts[0]?.state, 'blocked');
  await engine.tick(async () => assert.fail('definitive refusal must not automatically replay'));
  assert.equal(store.get('refused-notify')?.notifyAttempts, 1);
  await engine.retryNotification(actor, 'refused-notify');
  await engine.tick(async run => { assert.equal(run.notification, 'unknown'); return { messageId: '111111111111111111' }; });
  assert.equal(store.get('refused-notify')?.notification, 'sent'); assert.equal(adapter.promptCalls, 1);
});
test('restricted store rejects existing legacy and unrelated DB bytes unchanged before schema writes', async t => {
  const { store, config } = await setup(t); store.close();
  const before = await readFile(config.databasePath);
  assert.throws(() => new Store(config.databasePath, true), { code: 'PROFILE_CONFLICT' });
  assert.deepEqual(await readFile(config.databasePath), before);
  const { DatabaseSync } = await import('node:sqlite');
  const unrelatedPath = join(config.workspaces.test!, 'unrelated.sqlite');
  const unrelated = new DatabaseSync(unrelatedPath); unrelated.exec('CREATE TABLE untouched (value TEXT); INSERT INTO untouched VALUES (\'sentinel\');'); unrelated.close();
  const unrelatedBefore = await readFile(unrelatedPath);
  assert.throws(() => new Store(unrelatedPath, true), { code: 'PROFILE_CONFLICT' });
  assert.deepEqual(await readFile(unrelatedPath), unrelatedBefore);
});
