import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, type Actor, type Notify } from '../src/engine.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { AppError } from '../src/errors.js';
import { DshRejected } from '../src/protocol.js';
import { digest, splitFinalOutput, MAX_FINAL_CODEPOINTS } from '../src/output.js';
import type { AgentAdapter, SessionInfo, Snapshot, WireEvent } from '../src/types.js';
const actor: Actor = { userId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' };
const event = (seq: number, type: string, data: Record<string, unknown>, surfaceOp?: unknown): WireEvent => ({ seq, type, data, time: 1, surfaceOp });
function completed(text: string): WireEvent[] {
  return [event(1, 'turn/start', { turn: 1 }), event(2, 'user/message', { source: { kind: 'user', rpcId: 'discord:run' } }, 'append'),
    event(3, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'INTERMEDIATE' }, { type: 'tool_use' }] } }, 'append'),
    event(4, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE' }, { type: 'text', text }] } }, 'append'),
    event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
}
class Adapter implements AgentAdapter {
  rows: SessionInfo[] = []; log: WireEvent[] = []; promptCalls = 0; reject = false;
  async list(): Promise<SessionInfo[]> { return this.rows; }
  async create(): Promise<string> { return 'session'; }
  async snapshot(): Promise<Snapshot> { return { cursor: this.log.at(-1)?.seq ?? 0, values: { inbox: { 'next-turn': [], 'next-step': [] } } }; }
  async events(_id: string, through: number, after: number): Promise<WireEvent[]> { return this.log.filter(e => e.seq > after && e.seq <= through); }
  async prompt(): Promise<void> { this.promptCalls++; if (this.reject) throw new DshRejected('DSH_REJECTED', 'test'); }
}
async function setup(t: { after(fn: () => unknown): void }, text = 'final') {
  const dir = await mkdtemp(join(tmpdir(), 'full-output-'));
  const path = join(dir, 'metadata.sqlite'); const stores: Store[] = [];
  const config = { token: 'placeholder', applicationId: '444444444444444444', guildId: actor.guildId, allowedUserIds: new Set([actor.userId]), allowedChannelIds: new Set([actor.channelId, '555555555555555555']), workspaces: { test: dir }, dshUrl: 'http://127.0.0.1:19387', dshToken: 'placeholder', pollIntervalMs: 5000, databasePath: path };
  const policy = await Policy.create(config); const adapter = new Adapter();
  adapter.rows = [{ sessionId: 'session', title: 'test', cwd: dir, running: false, subagent: false, updatedAt: 1 }];
  const open = () => { const store = new Store(path, true); store.setSetting('restricted-storage-profile', 'single-operator-text-v1'); stores.push(store); return { store, engine: new Engine(adapter, store, policy, ['SECRET'], true) }; };
  const { store, engine } = open(); await engine.bind(actor, 'session'); await engine.submit(actor, 'run', 'PROMPT_NEVER_STORE'); adapter.log = completed(text);
  t.after(async () => { for (const value of stores) value.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, engine, adapter, policy, config, path, open };
}
for (const [name, text] of [
  ['empty', ''], ['Japanese and emoji', '日本語😀\n'.repeat(900)], ['unclosed fence', '```typescript\n' + '😀x\n'.repeat(1700)],
  ['huge marker', '`'.repeat(3000) + '\n' + 'x'.repeat(5000)], ['fence at boundary', 'a'.repeat(1600) + '\n```js\n' + 'x'.repeat(4000) + '\n```\n'],
  ['CRLF fence', '~~~js\r\n' + 'a\r\n'.repeat(2000) + '~~~\r\n']
] as const) test(`exact body recovery and UTF16 boundary: ${name}`, () => {
  const plan = splitFinalOutput(text, '123456789012345678'); assert.equal(plan.complete, true);
  assert.equal(plan.parts.map(p => p.body).join(''), text); assert.equal(plan.digest, digest(text));
  for (const part of plan.parts) { assert.ok(part.content.length <= 2000); assert.ok(!/^[\uDC00-\uDFFF]/u.test(part.body)); assert.ok(!/[\uD800-\uDBFF]$/u.test(part.body)); }
});
test('malformed lone surrogates rejected rather than silently replaced by Discord', () => {
  for (const text of ['a\ud800b', '\udc00', 'a\ud800']) assert.throws(() => splitFinalOutput(text, 'run'), /MALFORMED_OUTPUT_UNICODE/);
});
test('100000 codepoints exact boundary and overflow explicitly marked; original digest retained', () => {
  const exact = splitFinalOutput('あ'.repeat(MAX_FINAL_CODEPOINTS), 'run'); assert.equal(exact.complete, true);
  const overflow = splitFinalOutput('あ'.repeat(MAX_FINAL_CODEPOINTS + 1), 'run'); assert.equal(overflow.complete, false);
  assert.match(overflow.parts.at(-1)!.content, /全文配信未完了/); assert.equal(overflow.parts.map(p => p.body).join('').length, MAX_FINAL_CODEPOINTS);
  assert.equal(overflow.digest, digest('あ'.repeat(MAX_FINAL_CODEPOINTS + 1)));
});
test('128 part cap handles emoji independently from codepoint cap; manual pages remain complete', () => {
  const text = '😀'.repeat(100000); const plan = splitFinalOutput(text, 'r'.repeat(256)); assert.equal(plan.parts.length, 128); assert.equal(plan.complete, false);
  assert.match(plan.parts.at(-1)!.content, /128 parts/); assert.ok(plan.parts.every(p => p.content.length <= 2000));
  const manual = splitFinalOutput(text, 'r'.repeat(256), false); assert.ok(manual.parts.length > 128); assert.equal(manual.parts.map(p => p.body).join(''), text);
});
test('automatic full final only, ordered receipts and result paging independent of delivery', async t => {
  const text = 'final 日本語😀\n'.repeat(400); const { engine, store, adapter } = await setup(t, text); const sent: string[] = [];
  await engine.tick(async (run, part) => { assert.equal(store.get(run.id)?.delivery?.parts[part!.index - 1]?.state, 'sending'); sent.push(part!.content); return { messageId: `message-${part!.index}` }; });
  const run = store.get('run')!; assert.equal(run.state, 'succeeded'); assert.equal(run.result, text); assert.equal(run.notification, 'sent');
  assert.ok(!sent.join('').includes('INTERMEDIATE')); assert.ok(!sent.join('').includes('PRIVATE')); assert.ok(sent.length > 1);
  assert.ok(run.delivery!.parts.every(p => p.state === 'sent' && p.messageId));
  assert.equal((await engine.resultPage(actor, 'run', 2)).content, splitFinalOutput(text, 'run', false).parts[1]!.content);
  await engine.tick(async () => assert.fail('sent replayed')); await engine.retryNotification(actor, 'run'); await engine.tick(async () => assert.fail('sent replayed')); assert.equal(adapter.promptCalls, 1);
});
test('native original and redacted delivery fingerprints remain distinct', async t => {
  const { engine, store } = await setup(t, 'final SECRET'); await engine.tick(async () => ({ messageId: 'message' }));
  const run = store.get('run')!; assert.equal(run.originalFinalDigest, digest('final SECRET')); assert.equal(run.bodyDigest, digest('final [REDACTED]'));
  assert.equal(run.delivery!.bodyDigest, digest('final SECRET')); assert.notEqual(run.delivery!.bodyDigest, run.delivery!.digest);
});
for (const stop of [1, 2, 3]) test(`restart after successful part ${stop} preserves sent IDs and holds uncertain tail`, async t => {
  const { engine, store, adapter, open } = await setup(t, 'final😀'.repeat(2000)); let calls = 0;
  await engine.tick(async (_run, part) => { calls++; if (part!.index === stop + 1) throw new AppError('TIMEOUT', 'private'); return { messageId: `sent-${part!.index}` }; });
  const before = store.get('run')!; assert.equal(before.delivery!.parts[stop - 1]!.state, 'sent'); assert.equal(before.delivery!.parts[stop]!.state, 'unknown');
  store.close(); const reopened = open(); await reopened.engine.tick(async () => assert.fail('unknown auto replayed'));
  await assert.rejects(reopened.engine.retryNotification(actor, 'run'), { code: 'DUPLICATE_RISK_CONFIRMATION_REQUIRED' });
  await reopened.engine.retryNotification(actor, 'run', stop + 1, true);
  await reopened.engine.tick(async (_run, part) => { assert.ok(part!.index > stop); return { messageId: `retried-${part!.index}` }; });
  assert.equal(reopened.store.get('run')?.notification, 'sent'); assert.equal(adapter.promptCalls, 1); assert.equal(calls, stop + 1);
});
test('crash after successful send before receipt save recovers unknown and never sends later parts', async t => {
  const { engine, store, open } = await setup(t, 'final'.repeat(2000));
  await assert.rejects(engine.tick(async () => { store.close(); return { messageId: 'success-not-saved' }; }));
  const reopened = open(); const run = reopened.store.get('run')!;
  assert.equal(run.delivery!.parts[0]!.state, 'unknown'); assert.equal(run.delivery!.parts[1]!.state, 'pending');
  await reopened.engine.tick(async () => assert.fail('crash replayed'));
});
test('429 obeys explicit wait and preserves order across restart', async t => {
  const { engine, store, open } = await setup(t, 'final'.repeat(800)); let calls = 0;
  const notify: Notify = async (_run, part) => { calls++; assert.equal(part!.index, 1); throw Object.assign(new AppError('DELIVERY_RATE_LIMIT', 'private'), { retryAfterMs: 60000 }); };
  await engine.tick(notify); const run = store.get('run')!; assert.equal(run.delivery!.parts[0]!.state, 'pending'); assert.ok(run.nextNotifyAt > Date.now() + 59000);
  await assert.rejects(engine.retryNotification(actor, 'run'), { code: 'DELIVERY_RATE_LIMIT' });
  await engine.tick(notify); assert.equal(calls, 1); store.close(); const reopened = open(); await reopened.engine.tick(notify); assert.equal(calls, 1);
  const ready = reopened.store.get('run')!; ready.nextNotifyAt = 0; ready.delivery!.parts[0]!.nextAttemptAt = 0; reopened.store.save(ready);
  await reopened.engine.tick(async (_run, part) => ({ messageId: `sent-${part!.index}` })); assert.equal(reopened.store.get('run')!.notification, 'sent');
});
for (const code of ['DELIVERY_BLOCKED', 'DM_FAILED']) test(`${code} blocked, no automatic replay/fallback, manual retry never prompt`, async t => {
  const { engine, store, adapter } = await setup(t, 'final'.repeat(800)); let calls = 0;
  await engine.tick(async () => { calls++; throw new AppError(code, 'private'); });
  assert.equal(store.get('run')!.delivery!.parts[0]!.state, 'blocked');
  assert.equal(engine.notificationPreferences(actor).blocked, 1); assert.ok(engine.notificationPreferences(actor).undeliveredParts > 0); assert.equal(store.get('run')!.state, 'succeeded');
  await engine.tick(async () => assert.fail('blocked replayed')); await engine.retryNotification(actor, 'run');
  await engine.tick(async (_run, part) => ({ messageId: `retry-${part!.index}` })); assert.equal(adapter.promptCalls, 1); assert.equal(calls, 1);
});
test('authorization loss blocks disclosure including following parts', async t => {
  const { engine, store, config } = await setup(t, 'final'.repeat(800)); let calls = 0;
  await engine.tick(async (_run, part) => { calls++; config.allowedUserIds.delete(actor.userId); return { messageId: `sent-${part!.index}` }; });
  assert.equal(calls, 1); assert.equal(store.get('run')!.delivery!.parts[1]!.state, 'blocked');
  await assert.rejects(engine.resultPage(actor, 'run'), { code: 'NOT_AUTHORIZED' });
});
test('result reauthorization after awaited Native body restore refuses revoked actor', async t => {
  const { engine, store, adapter, config, open } = await setup(t, 'PRIVATE_FINAL'); await engine.tick(async () => ({ messageId: 'sent' }));
  store.close(); const reopened = open(); const events = adapter.events.bind(adapter);
  adapter.events = async (id, through, after) => { const log = await events(id, through, after); config.allowedUserIds.clear(); return log; };
  await assert.rejects(reopened.engine.status(actor, 'run'), { code: 'NOT_AUTHORIZED' }); assert.equal(adapter.promptCalls, 1);
});
for (const operation of ['status', 'resultPage'] as const) test(`${operation} rechecks exact Native Session CWD after awaited body restore`, async t => {
  const { engine, store, adapter, open } = await setup(t, 'PRIVATE_FINAL'); await engine.tick(async () => ({ messageId: 'sent' }));
  store.close(); const reopened = open(); const events = adapter.events.bind(adapter);
  adapter.events = async (id, through, after) => { const log = await events(id, through, after); adapter.rows[0]!.cwd = join(tmpdir(), 'unapproved-cwd'); return log; };
  await assert.rejects(reopened.engine[operation](actor, 'run'), { code: 'WORKSPACE_FORBIDDEN' });
  assert.equal(adapter.promptCalls, 1); assert.equal(reopened.store.get('run')!.state, 'succeeded'); assert.equal(reopened.store.get('run')!.delivery!.parts[0]!.state, 'sent');
});
test('tampered pinned DM destination is blocked rather than disclosing to a different user', async t => {
  const { engine, store } = await setup(t); await engine.tick(async () => { throw new AppError('DELIVERY_BLOCKED', 'refusal'); });
  const run = store.get('run')!; run.delivery!.userId = '999999999999999999'; store.save(run);
  await engine.retryNotification(actor, 'run'); await engine.tick(async () => assert.fail('tampered destination sent'));
  assert.equal(store.get('run')!.delivery!.parts[0]!.state, 'blocked'); assert.equal(store.get('run')!.lastError, 'DELIVERY_BLOCKED');
});
test('tampered part index cannot skip or reorder final text', async t => {
  const { engine, store } = await setup(t, 'final'.repeat(900)); await engine.tick(async () => { throw new AppError('DELIVERY_BLOCKED', 'refusal'); });
  const run = store.get('run')!; run.delivery!.parts[0]!.index = 2; store.save(run);
  await engine.retryNotification(actor, 'run'); await engine.tick(async () => assert.fail('out of order body sent'));
  assert.equal(store.get('run')!.lastError, 'BODY_DIGEST_MISMATCH'); assert.equal(store.get('run')!.delivery!.parts[0]!.state, 'blocked');
});
test('Native access loss after a receipt blocks subsequent parts without replaying sent part', async t => {
  const { engine, store, adapter } = await setup(t, '日本語😀'.repeat(1600)); let sends = 0;
  await engine.tick(async () => { sends++; adapter.rows = []; return { messageId: 'first' }; });
  const run = store.get('run')!; assert.equal(sends, 1); assert.equal(run.state, 'succeeded');
  assert.equal(run.delivery!.parts[0]!.state, 'sent'); assert.equal(run.delivery!.parts[1]!.state, 'blocked');
  assert.equal(run.lastError, 'SESSION_NOT_FOUND'); assert.equal(adapter.promptCalls, 1);
});
test('restart history digest mismatch or wrong correlation cannot disclose replacement body', async t => {
  const { engine, store, adapter, open } = await setup(t, 'AUTHENTIC_FINAL'); await engine.tick(async () => ({ messageId: 'sent' })); store.close(); const reopened = open();
  adapter.log = completed('REPLACED_FINAL'); await assert.rejects(reopened.engine.resultPage(actor, 'run'), { code: 'BODY_DIGEST_MISMATCH' });
  adapter.log = completed('AUTHENTIC_FINAL'); adapter.log[1]!.data.source = { kind: 'user', rpcId: 'foreign' };
  await assert.rejects(reopened.engine.resultPage(actor, 'run'), { code: 'BODY_UNAVAILABLE' });
});
test('metadata SQLite excludes prompt/final/intermediate text; expired body unavailable', async t => {
  const { engine, store, path } = await setup(t, 'UNIQUE_FINAL_PLAINTEXT'); await engine.tick(async () => ({ messageId: 'sent' }));
  const run = store.get('run')!; run.bodyExpiresAt = 0; store.save(run); await assert.rejects(engine.resultPage(actor, 'run'), { code: 'BODY_EXPIRED' }); store.close();
  const bytes = (await readFile(path)).toString('utf8'); for (const secret of ['PROMPT_NEVER_STORE', 'UNIQUE_FINAL_PLAINTEXT', 'INTERMEDIATE', 'PRIVATE']) assert.ok(!bytes.includes(secret));
});
test('future preferences are pinned, origin requires confirmation, existing run unchanged', async t => {
  const { engine, store } = await setup(t); assert.equal(engine.notificationPreferences(actor).destination, 'dm');
  assert.throws(() => engine.setNotificationPreferences(actor, { destination: 'origin' }), { code: 'CONFIRMATION_REQUIRED' });
  assert.throws(() => engine.setNotificationPreferences(actor, { destination: 'dm', progress: true }), { code: 'PROGRESS_UNSUPPORTED' });
  engine.setNotificationPreferences(actor, { destination: 'origin', progress: false }, true); await engine.tick(async () => ({ messageId: 'sent' }));
  assert.equal(store.get('run')!.delivery!.destination, 'dm'); assert.equal(engine.notificationPreferences(actor).destination, 'origin');
});
test('binding uniqueness, version CAS, and run CAS reject cross-conversation/stale writers', async t => {
  const { engine, store } = await setup(t); const version = engine.bindingVersion(actor);
  await assert.rejects(engine.bind({ ...actor, channelId: '555555555555555555' }, 'session'), { code: 'SESSION_BOUND' });
  await engine.bind(actor, 'session'); await assert.rejects(engine.bind(actor, 'session', version), { code: 'BINDING_CONFLICT' });
  const a = store.get('run')!, b = store.get('run')!; store.save(a); assert.throws(() => store.save(b), { code: 'RUN_REVISION_CONFLICT' });
});
test('Binding and Run version overflow fail closed without changing selection or durable row', async t => {
  const { engine, store } = await setup(t); const key = `${actor.guildId}:${actor.channelId}:shared`;
  store.setSetting(`binding-version:${key}`, String(Number.MAX_SAFE_INTEGER));
  await assert.rejects(engine.bind(actor, 'session'), { code: 'BINDING_VERSION_EXHAUSTED' });
  assert.throws(() => engine.unbind(actor), { code: 'BINDING_VERSION_EXHAUSTED' }); assert.equal(engine.binding(actor), 'session');
  const run = { ...store.get('run')!, id: 'exhausted', state: 'failed' as const, notification: 'none' as const, revision: Number.MAX_SAFE_INTEGER };
  store.create(run); assert.throws(() => store.save(run), { code: 'RUN_VERSION_EXHAUSTED' }); assert.equal(store.get('exhausted')!.revision, Number.MAX_SAFE_INTEGER);
  store.setSetting(`binding-version:${key}`, 'NaN'); assert.throws(() => engine.bindingVersion(actor), { code: 'DB_CORRUPT' });
});
test('legacy restricted sent without a plan is never adopted or explicitly replayed after restart', async t => {
  const { engine, store, adapter, open } = await setup(t); await engine.tick(async () => ({ messageId: 'legacy-sent' }));
  const run = store.get('run')!; delete run.delivery; store.save(run); store.close(); const reopened = open();
  await reopened.engine.retryNotification(actor, 'run', undefined, true);
  assert.equal(reopened.store.get('run')!.notification, 'sent'); assert.equal(reopened.store.get('run')!.delivery, undefined);
  await reopened.engine.tick(async () => assert.fail('legacy sent replayed')); assert.equal(adapter.promptCalls, 1);
});
test('legacy unknown without part metadata cannot be adopted or auto retried', async t => {
  const { engine, store } = await setup(t); await engine.tick(async () => { throw new AppError('TIMEOUT', 'private'); });
  const run = store.get('run')!; delete run.delivery; store.save(run);
  await engine.tick(async () => assert.fail('legacy unknown replayed')); await assert.rejects(engine.retryNotification(actor, 'run'), { code: 'NOTIFICATION_UNKNOWN' });
});
