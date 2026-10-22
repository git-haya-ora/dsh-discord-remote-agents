import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Engine, type Actor } from '../src/engine.js';
import { Store, PROTECTED_OUTPUT_RETENTION_MS, MAX_PROTECTED_STORAGE_BYTES } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { AppError } from '../src/errors.js';
import { DshRejected } from '../src/protocol.js';
const { describePayload } = await import(new URL('../../packages/discord-plugin/protected-payloads.js', import.meta.url).href) as typeof import('../packages/discord-plugin/protected-payloads.js');
import type { AgentAdapter, BridgeOutputContext, ProtectedPayloadStore, SessionInfo, Snapshot, WireEvent } from '../src/types.js';
import type { Config } from '../src/config.js';
type OutputInput = { kind: 'bridge-output'; context: BridgeOutputContext; text: string };
type OutputExpected = { kind: 'bridge-output'; digest: string; context: BridgeOutputContext };

const actor: Actor = { userId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' };
const privateOutput = 'PRIVATE_OUTPUT_SENTINEL: synthetic durable response 日本語 😀';
const event = (seq: number, type: string, data: Record<string, unknown>, surfaceOp?: unknown): WireEvent => ({ seq, type, data, time: 1, surfaceOp });

class SyntheticPayloadStore implements ProtectedPayloadStore {
  readonly values = new Map<string, { input: { kind: 'bridge-output'; context: BridgeOutputContext; text: string }; cipherBytes: number }>();
  failAfterWrites: number | undefined;
  failStatsCall: number | undefined;
  statsCalls = 0;
  createCalls = 0;
  onStats?: () => void | Promise<void>;
  onRead?: () => void | Promise<void>;
  constructor(readonly quotaInventory?: { bytes: number; files: Array<{ ref: string; bytes: number }> }) {}
  async estimate(inputs: readonly { kind: 'bridge-output'; context: BridgeOutputContext; text: string }[]) {
    return inputs.map(input => { const value = describePayload(input); return { ...value, cipherBytes: value.byteLength + 256 }; });
  }
  async createWithRef(ref: string, input: { kind: 'bridge-output'; context: BridgeOutputContext; text: string }, reserveBytes: number): Promise<void> {
    await this.createManyWithRefs([{ ref, input, reserveBytes }]);
  }
  async createManyWithRefs(inputs: readonly { ref: string; input: { kind: 'bridge-output'; context: BridgeOutputContext; text: string }; reserveBytes: number }[]): Promise<void> {
    this.createCalls++;
    let written = 0;
    for (const entry of inputs) {
      const found = this.values.get(entry.ref);
      if (found) {
        if (describePayload(found.input).digest !== describePayload(entry.input).digest || found.cipherBytes !== entry.reserveBytes) throw Object.assign(new Error('PROTECTED_PAYLOAD_MISMATCH'), { code: 'PROTECTED_PAYLOAD_MISMATCH' });
      } else {
        if (entry.reserveBytes < describePayload(entry.input).byteLength) throw Object.assign(new Error('PROTECTED_PAYLOAD_QUOTA'), { code: 'PROTECTED_PAYLOAD_QUOTA' });
        this.values.set(entry.ref, { input: structuredClone(entry.input), cipherBytes: entry.reserveBytes }); written++;
      }
      if (this.failAfterWrites !== undefined && written >= this.failAfterWrites) { this.failAfterWrites = undefined; throw new Error('SYNTHETIC_CRASH_AFTER_PARTIAL_WRITE'); }
    }
  }
  async read(ref: string, expected: { kind: 'bridge-output'; digest: string; context: BridgeOutputContext }): Promise<{ text: string }> {
    return (await this.readMany([{ ref, expected }]))[0]!;
  }
  async readMany(inputs: readonly { ref: string; expected: { kind: 'bridge-output'; digest: string; context: BridgeOutputContext } }[]): Promise<readonly { text: string }[]> {
    await this.onRead?.();
    return inputs.map(({ ref, expected }) => {
      const found = this.values.get(ref);
      if (!found || describePayload(found.input).digest !== expected.digest || JSON.stringify(found.input.context) !== JSON.stringify(expected.context)) throw Object.assign(new Error('PROTECTED_PAYLOAD_MISMATCH'), { code: 'PROTECTED_PAYLOAD_MISMATCH' });
      return { text: found.input.text };
    });
  }
  async stats(): Promise<{ bytes: number; files: Array<{ ref: string; bytes: number }> }> {
    this.statsCalls++;
    await this.onStats?.();
    if (this.failStatsCall === this.statsCalls) throw Object.assign(new Error('SYNTHETIC_STATS_FAILURE'), { code: 'PROTECTED_PAYLOAD_FAILURE' });
    if (this.quotaInventory) return structuredClone(this.quotaInventory);
    const files = [...this.values].map(([ref, value]) => ({ ref, bytes: value.cipherBytes }));
    return { bytes: files.reduce((sum, item) => sum + item.bytes, 0), files };
  }
  async delete(ref: string): Promise<void> { await this.deleteMany([ref]); }
  async deleteMany(refs: readonly string[]): Promise<readonly { ref: string; deleted: boolean; bytes: number }[]> {
    return refs.map(ref => { const value = this.values.get(ref); if (!value) return { ref, deleted: false, bytes: 0 }; this.values.delete(ref); return { ref, deleted: true, bytes: value.cipherBytes }; });
  }
}

class SyntheticAdapter implements AgentAdapter {
  readonly session: SessionInfo;
  log: WireEvent[] = [];
  promptCalls = 0;
  promptFailure?: Error;
  failEventReads = false;
  listCalls = 0;
  gateListCall?: number;
  onList?: (call: number) => void | Promise<void>;
  inbox: Record<string, unknown> = { 'next-turn': [], 'next-step': [] };
  constructor(cwd: string) { this.session = { sessionId: 'native-session-synthetic', cwd, running: false, title: 'synthetic', subagent: false, updatedAt: 1 }; }
  async list(): Promise<SessionInfo[]> { const call = ++this.listCalls; await this.onList?.(call); return [this.session]; }
  async create(): Promise<string> { return this.session.sessionId; }
  async snapshot(): Promise<Snapshot> { return { cursor: this.log.at(-1)?.seq ?? 0, values: { inbox: this.inbox } }; }
  async events(_sessionId: string, through: number, after: number): Promise<WireEvent[]> {
    if (this.failEventReads) throw new AppError('DSH_OFFLINE', 'synthetic native event history unavailable');
    return this.log.filter(item => item.seq > after && item.seq <= through);
  }
  async prompt(): Promise<void> { this.promptCalls++; if (this.promptFailure) throw this.promptFailure; }
  complete(requestId: string, output = privateOutput): void {
    this.log = [
      event(1, 'turn/start', { turn: 7 }),
      event(2, 'step/start', { turn: 7, step: 0 }),
      event(3, 'user/message', { role: 'user', source: { kind: 'user', rpcId: requestId }, content: [] }, 'append'),
      event(4, 'assistant/message', { turn: 7, message: { role: 'assistant', content: [{ type: 'text', text: output }] } }, 'append'),
      event(5, 'turn/end', { turn: 7, reason: { kind: 'completed' } })
    ];
  }
}

async function setup(t: { after(fn: () => unknown): void }, payload = new SyntheticPayloadStore(), dbPath?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'discord-protected-output-test-'));
  const config: Config = { token: 'synthetic', applicationId: '444444444444444444', guildId: actor.guildId,
    allowedUserIds: new Set([actor.userId]), allowedChannelIds: new Set([actor.channelId]), workspaces: { test: dir },
    dshUrl: 'http://127.0.0.1:19387', dshToken: 'SYNTHETIC_SECRET', pollIntervalMs: 5000, databasePath: dbPath ?? join(dir, 'bot.sqlite') };
  const policy = await Policy.create(config), store = new Store(config.databasePath, true);
  store.setSetting('restricted-storage-profile', 'single-operator-text-v1');
  const adapter = new SyntheticAdapter(dir);
  const engine = new Engine(adapter, store, policy, [config.dshToken], true, payload, { applicationId: config.applicationId, botId: '555555555555555555' }, true);
  await engine.bind(actor, adapter.session.sessionId);
  let closed = false; const closeStore = () => { if (!closed) { store.close(); closed = true; } };
  t.after(() => { closeStore(); return rm(dir, { recursive: true, force: true }); });
  return { dir, config, store, adapter, engine, payload, closeStore };
}

async function completedRun(f: Awaited<ReturnType<typeof setup>>, id = 'protected-run') {
  const run = await f.engine.submit(actor, id, 'synthetic prompt, no real user data');
  assert.equal(run.state, 'accepted');
  f.adapter.complete(run.requestId);
  const deliveries: string[] = [];
  await f.engine.tick(async (_run, part) => { if (part) deliveries.push(part.content); return { messageId: `synthetic-message-${deliveries.length}` }; });
  return { run: f.store.get(id)!, deliveries };
}

function gateFinalStatusSession(f: Awaited<ReturnType<typeof setup>>): { reached: Promise<void>; release(): void } {
  let targetCall = -1, signal!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.payload.onRead = () => { targetCall = f.adapter.listCalls + 2; };
  f.adapter.onList = async call => { if (call === targetCall) { signal(); await gate; } };
  return { reached, release };
}

test('protected quota await rechecks the original binding generation including A-B-A before prompt', async t => {
  const f = await setup(t), original = f.engine.binding(actor)!, version = f.engine.bindingVersion(actor);
  f.payload.onStats = async () => {
    delete f.payload.onStats; f.engine.unbind(actor); await f.engine.bind(actor, original);
  };
  await assert.rejects(f.engine.submit(actor, 'binding-aba', 'synthetic prompt'), { code: 'BINDING_CONFLICT' });
  assert.equal(f.engine.binding(actor), original); assert.equal(f.engine.bindingVersion(actor), version + 2);
  assert.equal(f.adapter.promptCalls, 0); assert.equal(f.store.get('binding-aba'), undefined);
});

test('protected quota await rechecks changed Native queue before prompt', async t => {
  const f = await setup(t);
  f.payload.onStats = () => { delete f.payload.onStats; f.adapter.inbox = { 'next-turn': [{ id: 'synthetic-pending' }], 'next-step': [] }; };
  await assert.rejects(f.engine.submit(actor, 'queue-race', 'synthetic prompt'), { code: 'SESSION_BUSY' });
  assert.equal(f.adapter.promptCalls, 0); assert.equal(f.store.get('queue-race'), undefined);
});

test('protected output commits only after exact readback, avoids SQLite plaintext, survives Native-history loss and retires exact refs after resolution TTL', async t => {
  const f = await setup(t);
  const { run, deliveries } = await completedRun(f);
  assert.equal(run.state, 'succeeded'); assert.equal(run.protectedOutput?.state, 'published');
  assert.equal(run.protectedOutput?.items[0]?.context.ownerId, actor.userId);
  assert.equal(run.protectedOutput?.items[0]?.context.bindingMode, 'shared');
  assert.equal(run.protectedOutput?.items[0]?.context.bindingId, `${actor.guildId}:${actor.channelId}:shared`);
  assert.equal(run.notification, 'sent'); assert.equal(run.bodyResolvedAt !== undefined, true);
  const expectedPart = `Run ${run.id} | part 1/1\n${privateOutput}`;
  assert.deepEqual(deliveries, [expectedPart]); assert.ok(f.payload.values.size > 0);
  const databaseNames = (await readdir(f.dir)).filter(name => name === 'bot.sqlite' || name.startsWith('bot.sqlite-'));
  assert.ok(databaseNames.includes('bot.sqlite'));
  for (const name of databaseNames) {
    const database = await readFile(join(f.dir, name));
    assert.equal(database.includes(Buffer.from(privateOutput)), false, `${name} must not contain plaintext output`);
    assert.equal(database.includes(Buffer.from('synthetic prompt, no real user data')), false, `${name} must not contain plaintext prompt`);
  }
  f.adapter.failEventReads = true;
  assert.equal((await f.engine.resultPage(actor, run.id, 1)).content, expectedPart);
  const latest = f.store.get(run.id)!; assert.ok(latest.bodyExpiresAt);
  const systemNow = Date.now; f.payload.onRead = () => { Date.now = () => latest.bodyExpiresAt!; };
  Date.now = () => latest.bodyExpiresAt! - 1;
  try { await assert.rejects(f.engine.resultPage(actor, run.id, 1), { code: 'BODY_EXPIRED' }); }
  finally { Date.now = systemNow; delete f.payload.onRead; }
  const now = Date.now; Date.now = () => latest.bodyExpiresAt!;
  try {
    await f.engine.tick(async () => assert.fail('resolved output must not be sent again'));
    await assert.rejects(f.engine.resultPage(actor, run.id, 1), { code: 'BODY_EXPIRED' });
  } finally { Date.now = now; }
  const retired = f.store.get(run.id)!;
  assert.equal(retired.protectedOutput?.state, 'retired'); assert.equal(retired.bodyMissing, true);
  assert.equal(f.payload.values.size, 0);
});

test('hydrated Engine.status cannot return a body after post-restore Session authorization stalls past TTL', async t => {
  const f = await setup(t), { run } = await completedRun(f, 'status-post-restore-expiry');
  const gate = gateFinalStatusSession(f), status = f.engine.status(actor, run.id), expiresAt = run.bodyExpiresAt!;
  await gate.reached;
  const systemNow = Date.now; Date.now = () => expiresAt;
  try {
    await f.engine.tick(async () => assert.fail('sent output must not be replayed'));
    assert.equal(f.store.get(run.id)?.protectedOutput?.state, 'retired'); assert.equal(f.payload.values.size, 0);
    gate.release(); await assert.rejects(status, { code: 'BODY_EXPIRED' });
  } finally { gate.release(); Date.now = systemNow; delete f.payload.onRead; delete f.adapter.onList; }
});

test('Engine.resultPage cannot format a body after post-restore Session authorization stalls past TTL', async t => {
  const f = await setup(t), { run } = await completedRun(f, 'result-post-restore-expiry');
  const gate = gateFinalStatusSession(f), page = f.engine.resultPage(actor, run.id), expiresAt = run.bodyExpiresAt!;
  await gate.reached;
  const systemNow = Date.now; Date.now = () => expiresAt;
  try {
    await f.engine.tick(async () => assert.fail('sent output must not be replayed'));
    assert.equal(f.store.get(run.id)?.protectedOutput?.state, 'retired'); assert.equal(f.payload.values.size, 0);
    gate.release(); await assert.rejects(page, { code: 'BODY_EXPIRED' });
  } finally { gate.release(); Date.now = systemNow; delete f.payload.onRead; delete f.adapter.onList; }
});

test('published output restores after Store/Engine restart without Native history and rejects a different deployment identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-protected-published-restart-'));
  const payload = new SyntheticPayloadStore(); const first = await setup(t, payload, join(dir, 'admission.sqlite'));
  const { run } = await completedRun(first, 'published-restart'); first.adapter.failEventReads = true; first.closeStore();
  const reopened = new Store(first.config.databasePath, true), policy = await Policy.create(first.config);
  const wrongDeployment = new Engine(first.adapter, reopened, policy, [first.config.dshToken], true, payload,
    { applicationId: '666666666666666666', botId: '555555555555555555' }, true);
  const wrongBot = new Engine(first.adapter, reopened, policy, [first.config.dshToken], true, payload,
    { applicationId: first.config.applicationId, botId: '777777777777777777' }, true);
  const restored = new Engine(first.adapter, reopened, policy, [first.config.dshToken], true, payload,
    { applicationId: first.config.applicationId, botId: '555555555555555555' }, true);
  t.after(() => { reopened.close(); return rm(dir, { recursive: true, force: true }); });
  await assert.rejects(wrongDeployment.resultPage(actor, run.id, 1), { code: 'PROTECTED_OUTPUT_CONFLICT' });
  await assert.rejects(wrongBot.resultPage(actor, run.id, 1), { code: 'PROTECTED_OUTPUT_CONFLICT' });
  const page = await restored.resultPage(actor, run.id, 1);
  assert.equal(page.content, `Run ${run.id} | part 1/1\n${privateOutput}`); assert.equal(first.adapter.failEventReads, true);
  assert.equal(reopened.get(run.id)?.protectedOutput?.state, 'published');
});

test('Host-shared binding protects definitive Bridge rejection without claiming Native admission', async t => {
  const f = await setup(t); f.adapter.promptFailure = new DshRejected('DSH_REJECTED', 'synthetic refusal');
  const run = await f.engine.submit(actor, 'shared-rejection', 'synthetic prompt');
  assert.equal(run.state, 'failed'); assert.equal(run.admitted, false); assert.equal(run.protectedOutput?.state, 'published');
  const context = run.protectedOutput!.items[0]!.context;
  assert.equal(context.completionSource, 'bridge-rejection'); assert.equal(context.observedTurn, null);
  assert.equal(context.ownerId, actor.userId); assert.equal(context.bindingMode, 'shared');
  delete f.adapter.promptFailure;
  await f.engine.tick(async (_run, part) => ({ messageId: `rejection-${part?.index ?? 0}` }));
  const delivered = f.store.get(run.id)!;
  assert.equal(delivered.notification, 'sent'); assert.equal(delivered.bodyResolvedAt !== undefined, true);
  assert.equal(f.adapter.promptCalls, 1);
});

test('unknown/unsent Discord receipt retains protected body and is never automatically replayed or expired', async t => {
  const f = await setup(t); const run = await f.engine.submit(actor, 'unknown-run', 'synthetic prompt');
  f.adapter.complete(run.requestId); let sends = 0;
  await f.engine.tick(async () => { sends++; throw new AppError('NETWORK_UNKNOWN', 'synthetic uncertain receipt'); });
  assert.equal(f.store.get(run.id)?.notification, 'unknown'); assert.equal(f.store.get(run.id)?.bodyResolvedAt, undefined);
  const count = f.payload.values.size; assert.ok(count > 0);
  for (let i = 0; i < 2; i++) await f.engine.tick(async () => { sends++; });
  const now = Date.now, future = now() + PROTECTED_OUTPUT_RETENTION_MS * 2; Date.now = () => future;
  try { await f.engine.tick(async () => { sends++; }); } finally { Date.now = now; }
  assert.equal(sends, 1); assert.equal(f.payload.values.size, count);
  assert.equal(f.store.get(run.id)?.protectedOutput?.state, 'published');
});

test('prepared partial write is pinned and resumed after Store/Engine restart without replaying prompt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-protected-restart-'));
  const dbPath = join(dir, 'admission.sqlite'); const payload = new SyntheticPayloadStore();
  const first = await setup(t, payload, dbPath); first.payload.failAfterWrites = 1;
  const run = await first.engine.submit(actor, 'restart-run', 'synthetic prompt'); first.adapter.complete(run.requestId);
  await first.engine.tick(async () => assert.fail('unpublished output cannot be sent'));
  assert.equal(first.store.protectedIntent(run.id)?.state, 'prepared'); assert.equal(first.payload.values.size, 1);
  const adapter = first.adapter, config = first.config; first.closeStore();
  const reopened = new Store(dbPath, true); const policy = await Policy.create(config);
  const engine = new Engine(adapter, reopened, policy, [config.dshToken], true, payload,
    { applicationId: config.applicationId, botId: '555555555555555555' }, true);
  t.after(() => { reopened.close(); return rm(dir, { recursive: true, force: true }); });
  assert.ok(engine.protectedOutputBlocked);
  await engine.tick(async (_run, part) => ({ messageId: `recovered-${part?.index ?? 0}` }));
  const recovered = reopened.get(run.id)!;
  assert.equal(adapter.promptCalls, 1); assert.equal(recovered.protectedOutput?.state, 'published');
  assert.equal(recovered.notification, 'sent', `fault=${engine.protectedOutputBlocked ?? 'clear'} lastError=${recovered.lastError}`); assert.equal(recovered.bodyResolvedAt !== undefined, true);
  assert.equal(reopened.protectedIntent(run.id)?.state, 'published');
});

test('post-commit inventory fault never rewrites published terminal row from stale active snapshot', async t => {
  const payload = new SyntheticPayloadStore(); const f = await setup(t, payload);
  const run = await f.engine.submit(actor, 'post-commit-run', 'synthetic prompt'); f.adapter.complete(run.requestId);
  payload.failStatsCall = 8; // submit, tick admission/reconcile, reserve, pre/post-write, then post-commit check
  await f.engine.tick(async () => assert.fail('faulted output is not delivered'));
  const stored = f.store.get(run.id)!;
  assert.equal(stored.state, 'succeeded'); assert.equal(stored.protectedOutput?.state, 'published');
  assert.equal(stored.notification, 'pending'); assert.ok(f.engine.protectedOutputBlocked);
});

test('over-quota existing protected inventory blocks admission before Native prompt', async t => {
  const files = Array.from({ length: 1025 }, (_, index) => ({ ref: index.toString(16).padStart(64, '0'), bytes: 131072 }));
  const payload = new SyntheticPayloadStore({ files, bytes: files.reduce((sum, item) => sum + item.bytes, 0) });
  const f = await setup(t, payload);
  await assert.rejects(f.engine.submit(actor, 'quota-run', 'synthetic prompt'), { code: 'PROTECTED_OUTPUT_QUOTA' });
  assert.equal(f.adapter.promptCalls, 0);
  assert.ok(payload.quotaInventory!.bytes > MAX_PROTECTED_STORAGE_BYTES);
});
