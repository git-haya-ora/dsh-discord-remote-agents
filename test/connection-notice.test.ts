import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResponseLike } from 'discord.js';
import { DiscordBot } from '../src/bot.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { Policy } from '../src/policy.js';
import { connectionNotice } from '../src/connection-notice.js';
import type { Config } from '../src/config.js';
import type { AgentAdapter, SessionInfo, Run } from '../src/types.js';
const userId = '111111111111111111', guildId = '222222222222222222', channelId = '333333333333333333';
async function fixture(t: { after(fn: () => unknown): void }, dm = false, channels = false) {
  const config: Config = { token: 'synthetic-fixture-secret', applicationId: '444444444444444444', guildId,
    allowedUserIds: new Set([userId]), allowedChannelIds: new Set([channelId]), workspaces: { project: process.cwd() },
    dshUrl: '', dshToken: '', pollIntervalMs: 5000, databasePath: '', connectionNotifications: { dm, channels } };
  let prompts = 0, lists = 0;
  const sessions: SessionInfo[] = [{ sessionId: 'selected-session', title: 'Selected @everyone 😀', cwd: process.cwd(), updatedAt: 1, running: false, subagent: false,
    lastUsedModel: { provider: 'fixture-provider', model: 'used-model', reasoningEffort: 'low' }, nextModel: { provider: 'fixture-provider', model: 'next-model', reasoningEffort: 'max' } }];
  const adapter = { async list() { lists++; return sessions; }, async prompt() { prompts++; throw Error('No prompt allowed'); } } as unknown as AgentAdapter;
  const store = new Store(':memory:', true), policy = await Policy.create(config), engine = new Engine(adapter, store, policy, [config.token], true);
  const bot = new DiscordBot(config, engine, undefined, true), actor = { userId, guildId, channelId };
  Object.defineProperty(bot.client, 'isReady', { value: () => true });
  const messages: {kind: string; options: any}[] = [];
  const send = (kind: string) => async (options: any) => { messages.push({ kind, options }); return { id: '555555555555555555' }; };
  Object.defineProperty(bot.client.users, 'fetch', { configurable: true, value: async () => ({ send: send('dm') }) });
  Object.defineProperty(bot.client.channels, 'fetch', { configurable: true, value: async () => ({ guildId, isSendable: () => true, send: send('channel') }) });
  t.after(async () => { await bot.stop(); store.close(); });
  return { config, engine, bot, actor, sessions, messages, prompts: () => prompts, lists: () => lists };
}
for (const [dm, channels] of [[false,false], [true,false], [false,true], [true,true]]) test(`connection notices honor explicit destinations dm=${dm} channels=${channels} without duplication`, async t => {
  const f = await fixture(t, dm, channels); await f.engine.bind(f.actor, 'selected-session');
  const result = await f.bot.notifyConnected(); await f.bot.notifyConnected();
  assert.equal(result.sent, Number(dm) + Number(channels)); assert.equal(result.failed, 0);
  assert.deepEqual(f.messages.map(m => m.kind), [...(dm ? ['dm'] : []), ...(channels ? ['channel'] : [])]);
  for (const { options } of f.messages) {
    assert.match(options.content, /Discord接続成功/u); assert.match(options.content, /プロジェクト: project/u);
    assert.match(options.content, /selected-session/u); assert.match(options.content, /used-model/u); assert.match(options.content, /次回設定モデル:.*next-model/u);
    assert.ok(!options.content.includes(process.cwd())); assert.ok(options.content.length <= 2000);
    assert.deepEqual(options.allowedMentions, { parse: [] }); assert.equal(options.flags, 4); assert.equal(options.enforceNonce, true);
  }
  assert.equal(new Set(f.messages.map(m => m.options.nonce)).size, f.messages.length); assert.equal(f.prompts(), 0);
});
for (const status of [503, 429]) test(`Discord SDK does not retry notice-route POST ${status} behind the durable fence`, async t => {
  const f = await fixture(t, true); let calls = 0;
  f.bot.client.rest.setToken('synthetic-test-token');
  f.bot.client.rest.options.makeRequest = async () => {
    calls++; const body = { message: 'synthetic', retry_after: 0.01, global: false };
    return { status, statusText: 'Synthetic', ok: false, body: null, bodyUsed: false,
      // Node's runtime Headers is compatible; the project deliberately omits DOM.Iterable typings.
      headers: new Headers({ 'content-type': 'application/json', 'retry-after': '0.01' }) as unknown as ResponseLike['headers'],
      json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  let rejection: unknown;
  await assert.rejects(f.bot.client.rest.post(`/channels/${channelId}/messages`, { body: { content: 'synthetic' } }), (error: unknown) => { rejection = error; return true; });
  if (status === 429) {
    Object.defineProperty(f.bot.client.users, 'fetch', { value: async () => { throw rejection; } });
    const run = { id: 'fixture-run', userId, guildId, channelId } as Run;
    await assert.rejects(f.bot.notify(run, { index: 1, content: 'synthetic' }), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'DELIVERY_RATE_LIMIT');
      assert.equal((error as { retryAfterMs: number }).retryAfterMs, Math.ceil((rejection as { retryAfter: number }).retryAfter)); return true;
    });
  }
  assert.equal(calls, 1); assert.equal(f.bot.client.rest.options.retries, 0); assert.equal(f.prompts(), 0);
});
test('unselected means no selection, never the newest Native Session; no history or prompt fetch', async t => {
  const f = await fixture(t, true); await f.bot.notifyConnected();
  assert.match(f.messages[0]!.options.content, /Session: 未選択/u); assert.doesNotMatch(f.messages[0]!.options.content, /selected-session|used-model/u);
  assert.equal(f.lists(), 0); assert.equal(f.prompts(), 0);
});
test('metadata titles redact known secrets and absolute paths; only the selected Session is disclosed', async t => {
  const f = await fixture(t, true);
  f.sessions[0]!.title = `${process.cwd()} ${f.config.token}`;
  f.sessions.push({ ...f.sessions[0]!, sessionId: 'unselected-newest', title: 'NEVER_DISCLOSE_OTHER_SESSION', updatedAt: 999999 });
  await f.engine.bind(f.actor, 'selected-session'); await f.bot.notifyConnected();
  const content = f.messages[0]!.options.content;
  assert.ok(!content.includes(process.cwd())); assert.ok(!content.includes(f.config.token)); assert.ok(!content.includes('NEVER_DISCLOSE_OTHER_SESSION')); assert.match(content, /selected-session/u);
});
for (const path of [String.raw`C:\Users\USER\My Projects\PRIVATE_SUFFIX`, 'C:/Users/USER/My Projects/PRIVATE_SUFFIX',
  String.raw`\\fixture-server\My Share\PRIVATE_SUFFIX`, String.raw`\Users\USER\My Projects\PRIVATE_SUFFIX`,
  String.raw`作業先=\Users\USER\My Projects\PRIVATE_SUFFIX`, '/home/fixture/My Projects/PRIVATE_SUFFIX',
  '"/home/fixture/My Projects/PRIVATE_SUFFIX"', '作業先=(/home/fixture/My Projects/PRIVATE_SUFFIX)',
  'workspace,/home/fixture/private/PRIVATE_SUFFIX', 'workspace;/home/fixture/private/PRIVATE_SUFFIX',
  '作業先/home/fixture/private/PRIVATE_SUFFIX']) {
  test(`metadata hides entire fields containing arbitrary spaced paths: ${JSON.stringify(path)}`, async t => {
    const f = await fixture(t, true); await f.engine.bind(f.actor, 'selected-session');
    f.sessions[0]!.title = `Before ${path} AFTER_PRIVATE_SUFFIX`;
    f.sessions[0]!.lastUsedModel = { provider: path, model: path, reasoningEffort: path };
    f.sessions[0]!.nextModel = { provider: path, model: path, reasoningEffort: path };
    await f.bot.notifyConnected(); const content = f.messages[0]!.options.content;
    assert.doesNotMatch(content, /PRIVATE_SUFFIX|My Projects|My Share|fixture-server|Before|AFTER_PRIVATE/u);
    assert.match(content, /Session: \[パス非表示\]/u); assert.match(content, /Session ID: selected-session/u);
    assert.equal(f.prompts(), 0);
  });
}
test('configured paths with suffixes are fully hidden but ordinary model namespaces survive', async t => {
  const f = await fixture(t, true); await f.engine.bind(f.actor, 'selected-session');
  f.sessions[0]!.title = `${process.cwd()}/PRIVATE_SUFFIX with spaces`;
  f.sessions[0]!.lastUsedModel = { provider: 'fixture-provider', model: 'organization/model-name' };
  await f.bot.notifyConnected(); const content = f.messages[0]!.options.content;
  assert.doesNotMatch(content, /PRIVATE_SUFFIX|with spaces/u); assert.match(content, /organization\/model-name/u);
});
test('uncertainty is durable before a send and only receipt metadata, never message bodies, is retained', async t => {
  const f = await fixture(t, true); const writes: any[] = [];
  const original = f.engine.store.setSetting.bind(f.engine.store);
  f.engine.store.setSetting = (key, value) => { writes.push(JSON.parse(value)); original(key, value); };
  Object.defineProperty(f.bot.client.users, 'fetch', { value: async () => ({ send: async () => {
    assert.deepEqual(writes.at(-1), { state: 'unknown' }); return { id: '555555555555555555' };
  } }) });
  assert.deepEqual(await f.bot.notifyConnected(), { sent: 1, failed: 0 });
  assert.deepEqual(writes, [{ state: 'unknown' }, { state: 'sent', messageId: '555555555555555555' }]);
});
test('missing last-used model is not inferred from next model or treated as currently running', async t => {
  const f = await fixture(t, true); delete f.sessions[0]!.lastUsedModel; await f.engine.bind(f.actor, 'selected-session'); await f.bot.notifyConnected();
  assert.match(f.messages[0]!.options.content, /使用モデル（直近のリクエスト）: 未取得/u); assert.match(f.messages[0]!.options.content, /次回設定モデル:.*next-model/u);
});
test('DM ambiguity is never retried or redirected and is not a Native execution', async t => {
  const f = await fixture(t, true); let attempts = 0;
  Object.defineProperty(f.bot.client.users, 'fetch', { value: async () => ({ send: async () => { attempts++; throw Error('synthetic-private-error'); } }) });
  assert.deepEqual(await f.bot.notifyConnected(), { sent: 0, failed: 1 }); await f.bot.notifyConnected();
  assert.equal(attempts, 1); assert.equal(f.messages.length, 0); assert.equal(f.prompts(), 0);
});
test('actor revoked during destination lookup cannot receive connection or Session metadata', async t => {
  const f = await fixture(t, true);
  Object.defineProperty(f.bot.client.users, 'fetch', { value: async () => { f.config.allowedUserIds.clear(); return { send: async () => { throw Error('Must not send'); } }; } });
  assert.deepEqual(await f.bot.notifyConnected(), { sent: 0, failed: 1 }); assert.equal(f.messages.length, 0);
});
test('wrong-guild channel cannot receive metadata and is not replaced with DM', async t => {
  const f = await fixture(t, false, true);
  Object.defineProperty(f.bot.client.channels, 'fetch', { value: async () => ({ guildId: 'other', isSendable: () => true, send: async () => { throw Error('Must not send'); } }) });
  assert.deepEqual(await f.bot.notifyConnected(), { sent: 0, failed: 1 }); assert.equal(f.messages.length, 0);
});
test('official Native model projection is copied narrowly and invalid values are omitted', async () => {
  const { NativeSessionAdapter } = await import(new URL('../../packages/discord-plugin/native-adapter.js', import.meta.url).href);
  const values = { title: 'fixture', modelSelection: { lastUsed: { provider: 'fixture', model: 'used', reasoningEffort: 'low', privateExtra: 'never-copy' }, next: { provider: 'fixture', model: 'next' } } };
  const adapter = new NativeSessionAdapter({ async list() { return { items: [{ sessionId: 's', running: false, updatedAt: 1, projections: { values } }] }; }, create() {}, projections() {}, page() {}, prompt() { throw Error('No Native prompt allowed'); } });
  const [session] = await adapter.list(); assert.deepEqual(session.lastUsedModel, { provider: 'fixture', model: 'used', reasoningEffort: 'low' }); assert.deepEqual(session.nextModel, { provider: 'fixture', model: 'next' });
  values.modelSelection.lastUsed.provider = ''; assert.equal((await adapter.list())[0].lastUsedModel, undefined);
});
test('binding ABA or authorization changes after building metadata invalidate its disclosure', async t => {
  const f = await fixture(t, true); await f.engine.bind(f.actor, 'selected-session');
  const built = await connectionNotice(f.engine, f.config, [f.actor]); f.engine.unbind(f.actor); await f.engine.bind(f.actor, 'selected-session');
  assert.throws(() => built.assertCurrent(), { code: 'BINDING_CONFLICT' });
  const current = await connectionNotice(f.engine, f.config, [f.actor]); f.config.allowedChannelIds.clear(); assert.throws(() => current.assertCurrent(), { code: 'NOT_AUTHORIZED' });
});
