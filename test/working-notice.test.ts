import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { Engine, type Actor } from '../src/engine.js';
import { DiscordBot } from '../src/bot.js';
import { Policy } from '../src/policy.js';
import { Store } from '../src/store.js';
import type { AgentAdapter, SessionInfo, Snapshot, WireEvent } from '../src/types.js';

const actor: Actor = { userId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' };
const wire = (seq: number, type: string, data: Record<string, unknown>, surfaceOp?: unknown): WireEvent => ({ seq, type, data, time: seq + 1, surfaceOp });
function runStart(requestId: string, start = 1, turn = 7): WireEvent[] {
  return [wire(start, 'turn/start', { turn }), wire(start + 1, 'step/start', { turn, step: 1 }),
    wire(start + 2, 'user/message', { role: 'user', source: { kind: 'user', rpcId: requestId }, content: [] }, 'append')];
}
class Adapter implements AgentAdapter {
  readonly rows: SessionInfo[] = [{ sessionId: 'native-session', cwd: '', running: false, title: 'synthetic', subagent: false, updatedAt: 1 }];
  readonly log: WireEvent[] = []; promptCalls = 0; readError: Error | undefined;
  async list(): Promise<SessionInfo[]> { return this.rows; }
  async create(): Promise<string> { return 'unused'; }
  async prompt(): Promise<void> { this.promptCalls++; }
  async snapshot(): Promise<Snapshot> { if (this.readError) throw this.readError; return { cursor: this.log.at(-1)?.seq ?? 0, values: { inbox: { 'next-turn': [], 'next-step': [] } } }; }
  async events(_sessionId: string, throughSeq: number, afterSeq: number): Promise<WireEvent[]> {
    if (this.readError) throw this.readError;
    return this.log.filter(event => event.seq > afterSeq && event.seq <= throughSeq);
  }
}
async function setup(t: { after(fn: () => unknown): void }, databasePath = ':memory:') {
  const dir = await mkdtemp(join(tmpdir(), 'working-notice-test-'));
  const config: Config = { token: 'synthetic-discord-token', applicationId: '444444444444444444', guildId: actor.guildId,
    allowedUserIds: new Set([actor.userId]), allowedChannelIds: new Set([actor.channelId]), workspaces: { test: dir },
    dshUrl: 'http://127.0.0.1:19387', dshToken: 'synthetic-dsh-token', pollIntervalMs: 5000, databasePath };
  const policy = await Policy.create(config); const store = new Store(databasePath, true);
  store.setSetting('restricted-storage-profile', 'single-operator-text-v1');
  const adapter = new Adapter(); adapter.rows[0]!.cwd = dir;
  const engine = new Engine(adapter, store, policy, [config.dshToken]); await engine.bind(actor, 'native-session');
  await engine.submit(actor, 'working-run', 'synthetic request');
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, config, policy, store, adapter, engine };
}

for (const [name, events] of [
  ['acceptance without Native events', []],
  ['turn/start without a step or matching user append', [wire(1, 'turn/start', { turn: 7 })]],
  ['matching user append without step/start', [wire(1, 'turn/start', { turn: 7 }), wire(2, 'user/message', { source: { kind: 'user', rpcId: 'discord:working-run' } }, 'append')]],
  ['preparation failure before matching user append', [wire(1, 'turn/start', { turn: 7 }), wire(2, 'step/start', { turn: 7, step: 1 }),
    wire(3, 'step/end', { turn: 7, step: 1, reason: { kind: 'error' } }), wire(4, 'turn/end', { turn: 7, reason: { kind: 'error' } })]],
  ['stale step from an earlier turn', [...runStart('discord:foreign', 1, 7).slice(0, 2), wire(3, 'turn/end', { turn: 7, reason: { kind: 'error' } }),
    wire(4, 'turn/start', { turn: 8 }), wire(5, 'user/message', { source: { kind: 'user', rpcId: 'discord:working-run' } }, 'append')]],
  ['foreign rpcId', [...runStart('discord:foreign'), wire(4, 'turn/end', { turn: 7, reason: { kind: 'completed' } })]]
] as const) {
  test(`does not send work-start notice on ${name}`, async t => {
    const { engine, adapter, store } = await setup(t); adapter.log.push(...events);
    let sends = 0; await engine.tick(async () => {}, async () => { sends++; return { messageId: '55555555555555555' }; });
    assert.equal(sends, 0); assert.equal(store.get('working-run')?.workNotice, undefined);
  });
}

test('sends only after exact user append inside matching active step, with durable no-replay receipt', async t => {
  const { engine, adapter, store } = await setup(t); adapter.log.push(...runStart('discord:working-run'));
  let sends = 0; await engine.tick(async () => {}, async run => {
    sends++; assert.equal(run.workStartedSeq, 3); assert.equal(run.startStep?.turn, 7); assert.equal(run.startStep?.step, 1);
    assert.equal(store.get('working-run')?.workNotice, 'unknown'); return { messageId: '55555555555555555' };
  });
  assert.equal(sends, 1); assert.equal(store.get('working-run')?.workNotice, 'sent');
  await engine.tick(async () => {}, async () => { sends++; return { messageId: '55555555555555556' }; });
  assert.equal(sends, 1); assert.equal(store.get('working-run')?.workNoticeMessageId, '55555555555555555');
});

test('matching step checkpoint survives a poll boundary and user event adds no invented turn or step fields', async t => {
  const { engine, adapter, store } = await setup(t);
  adapter.log.push(wire(1, 'turn/start', { turn: 7 }), wire(2, 'step/start', { turn: 7, step: 1 }));
  let sends = 0; await engine.tick(async () => {}, async () => { sends++; return { messageId: '55555555555555555' }; });
  assert.equal(sends, 0); assert.equal(store.get('working-run')?.lastSeq, 2);
  adapter.log.push(wire(3, 'user/message', { role: 'user', source: { kind: 'user', rpcId: 'discord:working-run' }, content: [] }, 'append'));
  await engine.tick(async () => {}, async run => { sends++; assert.equal(run.workStartedSeq, 3); return { messageId: '55555555555555555' }; });
  assert.equal(sends, 1); assert.equal(store.get('working-run')?.workNotice, 'sent');
});

test('ambiguous send persists unknown and never auto-replays', async t => {
  const { engine, adapter, store } = await setup(t); adapter.log.push(...runStart('discord:working-run')); let sends = 0;
  await engine.tick(async () => {}, async () => { sends++; throw new AppError('NOTIFICATION_UNKNOWN', 'synthetic timeout'); });
  assert.equal(store.get('working-run')?.workNotice, 'unknown');
  await engine.tick(async () => {}, async () => { sends++; return { messageId: '55555555555555556' }; });
  assert.equal(sends, 1); assert.equal(store.get('working-run')?.workNotice, 'unknown');
});

test('clean same-poll terminal suppresses stale start notice while delivering terminal result', async t => {
  const { engine, adapter, store } = await setup(t); adapter.log.push(...runStart('discord:working-run'),
    wire(4, 'assistant/message', { turn: 7, message: { role: 'assistant', content: [{ type: 'text', text: 'complete' }] } }, 'append'),
    wire(5, 'turn/end', { turn: 7, reason: { kind: 'completed' } }));
  let starts = 0, finals = 0; await engine.tick(async () => { finals++; return { messageId: '55555555555555556' }; }, async () => { starts++; return { messageId: '55555555555555555' }; });
  assert.equal(starts, 0); assert.equal(finals, 1); assert.equal(store.get('working-run')?.workNotice, 'suppressed');
  assert.equal(store.get('working-run')?.state, 'succeeded');
});

test('complete Native read is required before resuming a persisted ready notice', async t => {
  const { engine, adapter, store } = await setup(t); adapter.log.push(...runStart('discord:working-run'));
  await engine.tick(async () => {}); assert.equal(store.get('working-run')?.workNotice, 'ready');
  adapter.readError = new AppError('DSH_OFFLINE', 'synthetic read failure'); let sends = 0;
  await engine.tick(async () => {}, async () => { sends++; return { messageId: '55555555555555555' }; });
  assert.equal(sends, 0); assert.equal(store.get('working-run')?.workNotice, 'ready');
  adapter.readError = undefined;
  await engine.tick(async () => {}, async () => { sends++; return { messageId: '55555555555555555' }; });
  assert.equal(sends, 1); assert.equal(store.get('working-run')?.workNotice, 'sent');
});

test('whole-batch contamination suppresses start; same-poll terminal suppresses stale start but still sends final', async t => {
  const { engine, adapter, store } = await setup(t); adapter.log.push(...runStart('discord:working-run'),
    wire(4, 'user/message', { source: { kind: 'user', rpcId: 'desktop-other' } }, 'append'),
    wire(5, 'assistant/message', { turn: 7, message: { role: 'assistant', content: [{ type: 'text', text: 'must-not-leak' }] } }, 'append'),
    wire(6, 'turn/end', { turn: 7, reason: { kind: 'completed' } }));
  let starts = 0, finals = 0; await engine.tick(async () => { finals++; return { messageId: '55555555555555556' }; }, async () => { starts++; return { messageId: '55555555555555555' }; });
  assert.equal(starts, 0); assert.equal(finals, 1); assert.equal(store.get('working-run')?.workNotice, 'suppressed');
  assert.equal(store.get('working-run')?.state, 'interrupted'); assert.equal(store.get('working-run')?.output, '');
});

test('same-turn foreign input after previously sent notice never resets its marker or replays', async t => {
  const { engine, adapter, store } = await setup(t); adapter.log.push(...runStart('discord:working-run'));
  let starts = 0; await engine.tick(async () => {}, async () => { starts++; return { messageId: '55555555555555555' }; });
  adapter.log.push(wire(4, 'user/message', { source: { kind: 'user', rpcId: 'desktop-other' } }, 'append'),
    wire(5, 'turn/end', { turn: 7, reason: { kind: 'completed' } }));
  await engine.tick(async () => {}, async () => { starts++; return { messageId: '55555555555555556' }; });
  assert.equal(starts, 1); assert.equal(store.get('working-run')?.workNotice, 'sent');
  assert.equal(store.get('working-run')?.state, 'interrupted');
});

test('restart/replay retains sent and unknown markers and never auto-resends', async t => {
  const dbDir = await mkdtemp(join(tmpdir(), 'working-notice-restart-')); const databasePath = join(dbDir, 'bridge.sqlite');
  t.after(() => rm(dbDir, { recursive: true, force: true }));
  const created = await setup(t, databasePath); created.adapter.log.push(...runStart('discord:working-run'));
  let starts = 0; await created.engine.tick(async () => {}, async () => { starts++; return { messageId: '55555555555555555' }; });
  created.store.close();
  const reopened = new Store(databasePath, true); const restored = new Engine(created.adapter, reopened, created.policy, [created.config.dshToken]);
  await restored.tick(async () => {}, async () => { starts++; return { messageId: '55555555555555556' }; });
  assert.equal(starts, 1); assert.equal(reopened.get('working-run')?.workNotice, 'sent');
  const uncertain = reopened.get('working-run')!; uncertain.workNotice = 'unknown'; uncertain.workNoticeError = 'NOTIFICATION_UNKNOWN'; reopened.save(uncertain); reopened.close();
  const reopenedUnknown = new Store(databasePath, true); const restoredUnknown = new Engine(created.adapter, reopenedUnknown, created.policy, [created.config.dshToken]);
  await restoredUnknown.tick(async () => {}, async () => { starts++; return { messageId: '55555555555555557' }; });
  assert.equal(starts, 1); assert.equal(reopenedUnknown.get('working-run')?.workNotice, 'unknown'); reopenedUnknown.close();
});

test('actual tick stop aborts a blocked working-notice lookup and ignores its late result', async t => {
  const { config, engine, adapter, store } = await setup(t); adapter.log.push(...runStart('discord:working-run'));
  const bot = new DiscordBot(config, engine, undefined, true); Object.defineProperty(bot.client, 'isReady', { value: () => true });
  let release!: (value: { id: string; send(options: unknown): Promise<{ id: string }> }) => void;
  let started!: () => void; const lookupStarted = new Promise<void>(resolve => { started = resolve; });
  const lookup = new Promise<{ id: string; send(options: unknown): Promise<{ id: string }> }>(resolve => { release = resolve; });
  let sends = 0, destroys = 0;
  Object.defineProperty(bot.client.users, 'fetch', { configurable: true, value: () => { started(); return lookup; } });
  Object.defineProperty(bot.client, 'destroy', { configurable: true, value: async () => { destroys++; } });
  t.after(() => bot.stop());
  (bot as unknown as { tick(): void }).tick(); await lookupStarted;
  let deadline: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([bot.stop().then(() => true), new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 250); })]);
  if (deadline) clearTimeout(deadline);
  assert.equal(stopped, true); assert.equal(destroys, 1); assert.equal(store.get('working-run')?.workNotice, 'blocked');
  release({ id: actor.userId, send: async () => { sends++; return { id: '55555555555555555' }; } });
  await Promise.resolve(); (bot as unknown as { tick(): void }).tick();
  assert.equal(sends, 0); assert.equal(store.get('working-run')?.workNotice, 'blocked');
});

test('actual tick stop returns during working-notice send and retains unknown without retry', async t => {
  const { config, engine, adapter, store } = await setup(t); adapter.log.push(...runStart('discord:working-run'));
  const bot = new DiscordBot(config, engine, undefined, true); Object.defineProperty(bot.client, 'isReady', { value: () => true });
  let release!: (value: { id: string }) => void; let started!: () => void;
  const sendStarted = new Promise<void>(resolve => { started = resolve; });
  const blockedSend = new Promise<{ id: string }>(resolve => { release = resolve; });
  let sends = 0, destroys = 0;
  Object.defineProperty(bot.client.users, 'fetch', { configurable: true, value: async () => ({ id: actor.userId, send: () => { sends++; started(); return blockedSend; } }) });
  Object.defineProperty(bot.client, 'destroy', { configurable: true, value: async () => { destroys++; } });
  t.after(() => bot.stop());
  (bot as unknown as { tick(): void }).tick(); await sendStarted;
  assert.equal(store.get('working-run')?.workNotice, 'unknown');
  let deadline: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([bot.stop().then(() => true), new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 250); })]);
  if (deadline) clearTimeout(deadline);
  assert.equal(stopped, true); assert.equal(destroys, 1); assert.equal(store.get('working-run')?.workNotice, 'unknown');
  release({ id: '55555555555555555' }); await Promise.resolve(); (bot as unknown as { tick(): void }).tick();
  assert.equal(sends, 1); assert.equal(store.get('working-run')?.workNotice, 'unknown');
});
