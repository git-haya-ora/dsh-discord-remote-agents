import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatInputCommandInteraction } from 'discord.js';
import { handleAgentCommand } from '../src/command-handler.js';
import { Engine, type Actor } from '../src/engine.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { AppError } from '../src/errors.js';
import type { Config } from '../src/config.js';
import type { AgentAdapter, ModelCatalog, SessionInfo, SessionRenameValue, Snapshot, WireEvent } from '../src/types.js';
const actor: Actor = { userId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' };
function interaction(sub: string, values: Record<string, string | number | boolean> = {}, group: string | null = null, changes: Partial<Actor> = {}): ChatInputCommandInteraction {
  return { commandName: 'agent', id: 'extended-run', user: { id: changes.userId ?? actor.userId, bot: false }, guildId: changes.guildId ?? actor.guildId, channelId: changes.channelId ?? actor.channelId,
    options: { data: [{ name: sub, type: 1, options: Object.entries(values).map(([name, value]) => ({ name, value, type: typeof value === 'string' ? 3 : typeof value === 'number' ? 4 : 5 })) }], getSubcommand: () => sub, getSubcommandGroup: () => group, getString: (name: string) => typeof values[name] === 'string' ? values[name] : null,
      getBoolean: (name: string) => typeof values[name] === 'boolean' ? values[name] : null, getInteger: (name: string) => typeof values[name] === 'number' ? values[name] : null }
  } as unknown as ChatInputCommandInteraction;
}
class Adapter implements AgentAdapter {
  rows: SessionInfo[] = [{ sessionId: 'native-session', title: '日本語😀', cwd: process.cwd(), running: false, subagent: false, updatedAt: 1 }];
  listCalls = 0; creates = 0; prompts = 0; catalogCalls = 0; renameCalls: Array<{ sessionId: string; title: string }> = []; log: WireEvent[] = []; revoke: (() => void) | undefined;
  inbox: Record<string, unknown> = { 'next-turn': [], 'next-step': [] };
  catalog: ModelCatalog = { default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'medium' }, routableProviders: ['provider-a'],
    groups: [{ id: 'provider-a', name: 'Provider A', models: [{ id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } }] }], failedProviders: 1 };
  async list(): Promise<SessionInfo[]> { this.listCalls++; this.revoke?.(); return this.rows; }
  async create(): Promise<string> { this.creates++; return 'new'; }
  async prompt(): Promise<void> { this.prompts++; }
  async modelCatalog(): Promise<ModelCatalog> { this.catalogCalls++; return this.catalog; }
  async rename(request: { sessionId: string; title: string }): Promise<SessionRenameValue> {
    this.renameCalls.push(request); const row = this.rows.find(value => value.sessionId === request.sessionId);
    if (!row) throw new AppError('SESSION_NOT_FOUND', 'not found'); row.title = request.title;
    const seq = (this.log.at(-1)?.seq ?? -1) + 1; this.log.push({ seq, time: 1, type: 'session/title', data: { title: request.title } });
    return { title: request.title, seq };
  }
  async snapshot(): Promise<Snapshot> { return { cursor: this.log.at(-1)?.seq ?? -1, values: { inbox: this.inbox, title: this.rows[0]?.title } }; }
  async events(_id: string, through: number, after: number): Promise<WireEvent[]> { return this.log.filter(event => event.seq > after && event.seq <= through); }
  async history(): Promise<Array<{ seq: number; role: 'assistant'; text: string; reasoning?: string; tool?: string }>> { return [{ seq: 0, role: 'assistant', text: '安全😀'.repeat(300), reasoning: 'PRIVATE_REASONING', tool: 'PRIVATE_TOOL' }]; }
}
async function setup(t: { after(fn: () => unknown): void }) {
  const config: Config = { token: 'placeholder', applicationId: '444444444444444444', guildId: actor.guildId, allowedUserIds: new Set([actor.userId]), allowedChannelIds: new Set([actor.channelId]),
    workspaces: { test: process.cwd() }, dshUrl: 'http://127.0.0.1:19387', dshToken: 'placeholder', pollIntervalMs: 5000, databasePath: ':memory:' };
  const store = new Store(':memory:', true); store.setSetting('restricted-storage-profile', 'single-operator-text-v1');
  const adapter = new Adapter(); const engine = new Engine(adapter, store, await Policy.create(config), ['PRIVATE_SECRET'], true); await engine.bind(actor, 'native-session');
  t.after(() => store.close()); return { engine, store, adapter, config };
}
for (const setting of ['model', 'effort', 'title']) test(`unsupported new ${setting} refuses BEFORE Native create or prompt`, async t => {
  const { engine, adapter, config } = await setup(t);
  await assert.rejects(handleAgentCommand(interaction('new', { workspace: 'test', [setting]: 'unsupported' }), engine, config, true));
  assert.equal(adapter.creates, 0); assert.equal(adapter.prompts, 0);
});
test('default help is bounded and does not advertise unregistered history as usable', async t => {
  const { engine, config } = await setup(t); const response = await handleAgentCommand(interaction('help'), engine, config, true);
  assert.ok(response.content.length <= 2000); assert.match(response.content, /history.*未登録/u);
});
test('wrong channel/user/guild and unsupported context produce no Native effects', async t => {
  const { engine, adapter, config } = await setup(t); const before = adapter.listCalls;
  for (const changes of [{ userId: '999999999999999999' }, { channelId: '999999999999999999' }, { guildId: '999999999999999999' }])
    await assert.rejects(handleAgentCommand(interaction('new', { workspace: 'test' }, null, changes), engine, config, true), { code: 'NOT_AUTHORIZED' });
  await assert.rejects(handleAgentCommand(interaction('context'), engine, config, true), { code: 'UNKNOWN_COMMAND' });
  assert.equal(adapter.listCalls, before); assert.equal(adapter.creates, 0); assert.equal(adapter.prompts, 0);
});
test('command origin preferences require scoped consent and affect only future Run', async t => {
  const { engine, adapter, store, config } = await setup(t); await engine.submit(actor, 'earlier', 'earlier prompt');
  await assert.rejects(handleAgentCommand(interaction('set', { destination: 'origin' }, 'notifications'), engine, config, true), { code: 'CONFIRMATION_REQUIRED' });
  await handleAgentCommand(interaction('set', { destination: 'origin', 'confirm-origin': true }, 'notifications'), engine, config, true);
  assert.equal(engine.notificationPreferences(actor).destination, 'origin'); assert.equal(store.get('earlier')!.notificationPreferences!.destination, 'dm');
  assert.equal(adapter.prompts, 1); assert.equal(adapter.creates, 0);
});
test('session emoji titles and workspace aliases remain within response UTF16 budget; no paths', async t => {
  const { engine, adapter, config } = await setup(t);
  adapter.rows = Array.from({ length: 12 }, (_, n) => ({ ...adapter.rows[0]!, sessionId: `session-${n}`, title: '😀'.repeat(500), updatedAt: 12 - n }));
  const sessions = await handleAgentCommand(interaction('sessions', { page: 2 }), engine, config, true); assert.ok(sessions.content.length <= 2000); assert.ok(!sessions.content.includes(process.cwd()));
  config.workspaces = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`${n}😀${'*'.repeat(80)}`, process.cwd()]));
  for (const page of [1, 2]) { const response = await handleAgentCommand(interaction('workspaces', { page }), engine, config, true); assert.ok(response.content.length <= 2000); assert.ok(!response.content.includes(process.cwd())); }
});
test('/agent models displays filtered per-model Native reasoning metadata without provider failure details', async t => {
  const { engine, adapter, config } = await setup(t);
  const response = await handleAgentCommand(interaction('models', { query: 'low', page: 1 }), engine, config, true);
  assert.match(response.content, /Native model catalog（read-only/u);
  assert.match(response.content, /Model A/u); assert.match(response.content, /Low \(low\)/u);
  assert.match(response.content, /Host既定（Session設定とは別）/u);
  assert.match(response.content, /取得できないprovider: 1（詳細は非表示）/u);
  assert.ok(response.content.length <= 2000); assert.equal(adapter.catalogCalls, 1);
});

test('/agent settings title requires no-CAS confirmation, serializes and readbacks the exact bound Session', async t => {
  const { engine, adapter, config } = await setup(t); const beforeLists = adapter.listCalls;
  await assert.rejects(handleAgentCommand(interaction('title', { value: 'renamed' }, 'settings'), engine, config, true), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(adapter.listCalls, beforeLists); assert.equal(adapter.renameCalls.length, 0);
  const response = await handleAgentCommand(interaction('title', { value: 'renamed', 'confirm-no-cas': true }, 'settings'), engine, config, true);
  assert.deepEqual(adapter.renameCalls, [{ sessionId: 'native-session', title: 'renamed' }]);
  assert.equal(adapter.rows[0]!.title, 'renamed'); assert.match(response.content, /readback確認/u); assert.match(response.content, /Native title CASはありません/u);
});

test('title mutation fails closed on unknown queue or tracked busy Run', async t => {
  const { engine, adapter, config, store } = await setup(t); adapter.inbox = {};
  await assert.rejects(handleAgentCommand(interaction('title', { value: 'must-not-change', 'confirm-no-cas': true }, 'settings'), engine, config, true), { code: 'SESSION_STATE_UNKNOWN' });
  assert.equal(adapter.renameCalls.length, 0); adapter.inbox = { 'next-turn': [], 'next-step': [] };
  await engine.submit(actor, 'active-title-run', 'prompt');
  await assert.rejects(handleAgentCommand(interaction('title', { value: 'must-not-change', 'confirm-no-cas': true }, 'settings'), engine, config, true), { code: 'SESSION_BUSY' });
  assert.equal(adapter.renameCalls.length, 0); assert.equal(store.get('active-title-run')!.state, 'accepted');
});

test('unsupported stale history command fetches no Native private events or projected text', async t => {
  const { engine, adapter, config } = await setup(t); const before = adapter.listCalls;
  adapter.history = async () => assert.fail('unsupported history must not fetch');
  adapter.events = async () => assert.fail('unsupported history must not fetch raw Native events');
  await assert.rejects(handleAgentCommand(interaction('history'), engine, config, true));
  assert.equal(adapter.listCalls, before); assert.equal(adapter.prompts, 0); assert.equal(adapter.creates, 0);
});
test('sessions authorization is rechecked after awaited Native list', async t => {
  const { engine, adapter, config } = await setup(t); adapter.revoke = () => config.allowedUserIds.clear();
  await assert.rejects(handleAgentCommand(interaction('sessions'), engine, config, true), { code: 'NOT_AUTHORIZED' });
});
test('metadata status remains succeeded with body unavailable; blocked backlog visible without disclosure', async t => {
  const { engine, adapter, config, store } = await setup(t); await engine.submit(actor, 'extended-run', 'prompt');
  adapter.log = [
    { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 0, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'discord:extended-run' } } },
    { seq: 2, time: 0, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_FINAL' }] } } },
    { seq: 3, time: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
  ];
  await engine.tick(async () => { throw new AppError('DELIVERY_BLOCKED', 'private raw failure'); });
  const run = store.get('extended-run')!; run.result = ''; run.output = ''; run.bodyMissing = true; store.save(run); adapter.log = [];
  const status = await handleAgentCommand(interaction('status', { run: 'extended-run' }), engine, config, true);
  assert.match(status.content, /状態: 完了/); assert.match(status.content, /blocked/); assert.ok(!status.content.includes('PRIVATE_FINAL'));
  await assert.rejects(handleAgentCommand(interaction('result', { run: 'extended-run' }), engine, config, true), { code: 'BODY_UNAVAILABLE' });
  const show = await handleAgentCommand(interaction('show', {}, 'notifications'), engine, config, true); assert.match(show.content, /blocked/); assert.match(show.content, /1/);
  const diagnose = await handleAgentCommand(interaction('diagnose'), engine, config, true); assert.match(diagnose.content, /1 blocked/); assert.ok(!diagnose.content.includes('private raw failure'));
  assert.equal(store.get('extended-run')!.state, 'succeeded'); assert.equal(adapter.prompts, 1);
});
