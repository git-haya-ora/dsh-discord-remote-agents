import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { loadTelegramConfig } from '../src/telegram-config.js';
import { TelegramApi, TelegramApiError } from '../src/telegram-api.js';
import { TelegramBot, telegramResult } from '../src/telegram.js';
import { Policy } from '../src/policy.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { AppError, safeError } from '../src/errors.js';
import type { AgentAdapter, SessionInfo, Snapshot, WireEvent } from '../src/types.js';
const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456';
class FakeApi extends TelegramApi {
  calls: { method: string; args: Record<string, unknown> | FormData }[] = [];
  updates: unknown[] = []; webhook = ''; failSend = false; botId = 123456;
  constructor() { super(TOKEN); }
  override async call(method: string, args: Record<string, unknown> | FormData = {}): Promise<unknown> {
    this.calls.push({ method, args });
    if (method === 'getMe') return { id: this.botId, is_bot: true, username: 'SafeAgentBot' };
    if (method === 'getWebhookInfo') return { url: this.webhook };
    if (method === 'getUpdates') return this.updates;
    if (this.failSend && ['sendMessage', 'sendDocument'].includes(method)) throw new AppError('TELEGRAM_OFFLINE', '接続失敗');
    return true;
  }
  messages(): Record<string, unknown>[] { return this.calls.filter(c => c.method === 'sendMessage').map(c => c.args as Record<string, unknown>); }
}
class FakeAdapter implements AgentAdapter {
  rows: SessionInfo[] = []; log: WireEvent[] = []; prompts: { sessionId: string; requestId: string; text: string }[] = [];
  async list(): Promise<SessionInfo[]> { return this.rows; }
  async create(cwd: string): Promise<string> { this.rows.push({ sessionId: 'new', cwd, running: false, title: '', subagent: false, updatedAt: 1 }); return 'new'; }
  async snapshot(): Promise<Snapshot> { return { cursor: this.log.at(-1)?.seq ?? 0, values: { inbox: { 'next-turn': [], 'next-step': [] } } }; }
  async events(_id: string, through: number, after: number): Promise<WireEvent[]> { return this.log.filter(e => e.seq > after && e.seq <= through); }
  async prompt(sessionId: string, requestId: string, text: string): Promise<void> { this.prompts.push({ sessionId, requestId, text }); }
}
function update(id: number, text: string, fromId = 111, type = 'private'): Record<string, unknown> {
  return { update_id: id, message: { message_id: id + 1, date: 1, from: { id: fromId, is_bot: false }, chat: { id: fromId, type }, text } };
}
async function setup(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'telegram-agents-test-')); const tgDir = join(dir, 'tg'); const dcDir = join(dir, 'dc');
  await mkdir(tgDir); await mkdir(dcDir);
  const config: Config = { token: TOKEN, applicationId: '123456', guildId: 'telegram', allowedUserIds: new Set(['111']), allowedChannelIds: new Set(['111']),
    workspaces: { project: tgDir }, dshUrl: 'http://127.0.0.1:19387', dshToken: 'DSH_SECRET', pollIntervalMs: 5000, databasePath: join(dir, 'bot.sqlite') };
  const dcConfig: Config = { ...config, token: 'DISCORD_SECRET', applicationId: '444444444444444444', guildId: '222222222222222222',
    allowedUserIds: new Set(['111111111111111111']), allowedChannelIds: new Set(['333333333333333333']), workspaces: { discord: dcDir } };
  const policy = Policy.combine([await Policy.create(dcConfig), await Policy.create(config)]); const store = new Store(config.databasePath);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const adapter = new FakeAdapter(); adapter.rows = [
    { sessionId: 'tg-session', cwd: tgDir, running: false, title: `title ${TOKEN} DISCORD_SECRET`, subagent: false, updatedAt: 1 },
    { sessionId: 'dc-session', cwd: dcDir, running: false, title: 'Discord only', subagent: false, updatedAt: 1 }
  ];
  const engine = new Engine(adapter, store, policy, [TOKEN, 'DSH_SECRET', 'DISCORD_SECRET']); const api = new FakeApi(); const bot = new TelegramBot(config, engine, api);
  await bot.initialize();
  return { dir, tgDir, dcDir, config, dcConfig, policy, store, adapter, engine, api, bot };
}
test('Telegram config requires native positive IDs, a safe token and loopback DSH; Discord secrets not needed', async t => {
  const { dir, tgDir } = await setup(t); const path = join(dir, 'telegram.json');
  const json = { allowedUserIds: ['111'], allowedChatIds: ['111'], allowedWorkspaces: { project: tgDir } };
  await writeFile(path, JSON.stringify(json)); const env = { TELEGRAM_CONFIG: path, TELEGRAM_BOT_TOKEN: TOKEN, DSH_TOKEN: 'secret' };
  const config = await loadTelegramConfig(env); assert.equal(config.guildId, 'telegram'); assert.equal(config.allowedChannelIds.has('111'), true);
  await assert.rejects(loadTelegramConfig({ ...env, TELEGRAM_BOT_TOKEN: 'bad/path' }), { code: 'CONFIG_INVALID' });
  await assert.rejects(loadTelegramConfig({ ...env, DSH_URL: 'http://example.com' }), { code: 'CONFIG_INVALID' });
  await writeFile(path, JSON.stringify({ ...json, allowedChatIds: ['-12345'] })); await assert.rejects(loadTelegramConfig(env), { code: 'CONFIG_INVALID' });
});
test('Telegram API uses HTTPS POST, no parse mode, protected plain text, and multipart document', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init: init! }); return new Response(JSON.stringify({ ok: true, result: true })); }) as typeof fetch;
  const api = new TelegramApi(TOKEN, fetcher); await api.sendText('111', '<b>not html</b>'); await api.sendDocument('111', 'long text', 'result.txt');
  assert.equal(seen[0]?.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`); assert.equal(seen[0]?.init.redirect, 'error');
  const args = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>; assert.equal(args.parse_mode, undefined); assert.equal(args.protect_content, true);
  const form = seen[1]?.init.body as FormData; assert.equal(form.get('chat_id'), '111'); assert.equal(await (form.get('document') as Blob).text(), 'long text');
});
test('Telegram API never exposes token URLs, server descriptions or malformed bodies; honors retry_after', async () => {
  const bad = new TelegramApi(TOKEN, (async () => { throw new Error(`failed https://api.telegram.org/bot${TOKEN}/getMe`); }) as typeof fetch);
  await assert.rejects(bad.call('getMe'), error => !safeError(error).includes(TOKEN));
  const unauthorized = new TelegramApi(TOKEN, (async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: TOKEN }), { status: 401 })) as typeof fetch);
  await assert.rejects(unauthorized.call('getMe'), { code: 'TELEGRAM_AUTH' });
  const limit = new TelegramApi(TOKEN, (async () => new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 90 } }), { status: 429 })) as typeof fetch);
  await assert.rejects(limit.call('getUpdates'), error => error instanceof TelegramApiError && error.retryAfterMs === 90000);
  const malformed = new TelegramApi(TOKEN, (async () => new Response('not JSON ' + TOKEN)) as typeof fetch);
  await assert.rejects(malformed.call('getMe'), error => !safeError(error).includes(TOKEN));
});
test('Telegram getMe verifies bot identity and existing webhook is not silently deleted', async t => {
  const { api, bot } = await setup(t); api.botId = 222;
  await assert.rejects(bot.initialize(), { code: 'TELEGRAM_PROTOCOL' }); api.botId = 123456; api.webhook = 'https://example.com/hook';
  await assert.rejects(bot.initialize(), { code: 'TELEGRAM_WEBHOOK' }); assert.equal(api.calls.some(c => c.method === 'deleteWebhook'), false);
});
test('Telegram only accepts original human private messages and matching /command@bot', async t => {
  const { bot, api, adapter } = await setup(t);
  await bot.handleUpdate(update(1, '/bind tg-session', 111, 'group')); await bot.handleUpdate(update(2, '/bind tg-session', 999));
  await bot.handleUpdate(update(3, '/bind@OtherBot tg-session'));
  const forwarded = update(4, '/prompt unwanted'); (forwarded.message as Record<string, unknown>).forward_origin = { type: 'user' }; await bot.handleUpdate(forwarded);
  await bot.handleUpdate({ update_id: 5, edited_message: (update(5, '/prompt unwanted').message) });
  await bot.handleUpdate(update(6, 'plain message is not instruction'));
  const mismatch = update(7, '/bind tg-session'); ((mismatch.message as Record<string, unknown>).chat as Record<string, unknown>).id = 222; await bot.handleUpdate(mismatch);
  assert.equal(adapter.prompts.length, 0); assert.equal(api.messages().length, 1); assert.match(String(api.messages()[0]?.text), /NOT_AUTHORIZED/);
  await bot.handleUpdate(update(8, '/bind@SafeAgentBot tg-session')); assert.match(String(api.messages().at(-1)?.text), /選択しました/);
});
test('whoami gives only caller IDs before authorization; no DSH information', async t => {
  const { bot, api, adapter } = await setup(t); await bot.handleUpdate(update(1, '/whoami', 999));
  assert.match(String(api.messages().at(-1)?.text), /User ID: 999\nChat ID: 999/); assert.equal(adapter.prompts.length, 0);
});
test('sessions, selection, multiline prompt and result use shared engine; duplicate updates never replay', async t => {
  const { bot, api, adapter, store, engine } = await setup(t);
  await bot.handleUpdate(update(1, '/sessions')); const listing = String(api.messages().at(-1)?.text);
  assert.match(listing, /tg-session/); assert.equal(listing.includes('dc-session'), false); assert.equal(listing.includes(TOKEN), false); assert.equal(listing.includes('DISCORD_SECRET'), false);
  await bot.handleUpdate(update(2, '/bind tg-session')); const command = update(3, '/prompt first line\nsecond line'); await bot.handleUpdate(command); await bot.handleUpdate(command);
  assert.equal(adapter.prompts.length, 1); assert.equal(adapter.prompts[0]?.text, 'first line\nsecond line'); assert.equal(adapter.prompts[0]?.requestId, 'telegram:tg-123456-3');
  const event = (seq: number, type: string, data: Record<string, unknown>, surfaceOp?: string): WireEvent => ({ seq, type, data, time: 1, ...(surfaceOp ? { surfaceOp } : {}) });
  adapter.log = [event(1, 'turn/start', { turn: 1 }), event(2, 'user/message', { role: 'user', source: { kind: 'user', rpcId: 'telegram:tg-123456-3' } }, 'append'),
    event(3, 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: `done ${TOKEN}` }, { type: 'reasoning', text: 'private' }] } }, 'append'),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
  await engine.tick(run => bot.notify(run)); assert.equal(store.get('tg-123456-3')?.state, 'succeeded'); assert.equal(store.get('tg-123456-3')?.notification, 'sent');
  assert.match(String(api.messages().at(-1)?.text), /done \[REDACTED\]/); assert.equal(String(api.messages().at(-1)?.text).includes('private'), false);
  await bot.handleUpdate(update(4, '/status')); assert.match(String(api.messages().at(-1)?.text), /完了/);
});
test('shared policy prevents cross-transport workspace and run disclosure, while SQLite fences shared sessions', async t => {
  const { bot, api, adapter, engine, dcConfig, tgDir } = await setup(t);
  const dc = { userId: '111111111111111111', guildId: dcConfig.guildId, channelId: '333333333333333333' };
  await bot.handleUpdate(update(1, '/bind dc-session')); assert.match(String(api.messages().at(-1)?.text), /WORKSPACE_FORBIDDEN/);
  assert.deepEqual((await engine.sessions(dc)).map(s => s.sessionId), ['dc-session']);
  await engine.bind(dc, 'dc-session'); await engine.submit(dc, 'discord-run', 'hello'); await bot.handleUpdate(update(2, '/result discord-run'));
  assert.match(String(api.messages().at(-1)?.text), /RUN_NOT_FOUND/);
  // Grant Discord the Telegram workspace to deliberately target the same native session.
  dcConfig.workspaces.shared = tgDir; const combined = Policy.combine([await Policy.create(dcConfig), await Policy.create({ ...dcConfig, guildId: 'telegram', allowedUserIds: new Set(['111']), allowedChannelIds: new Set(['111']) })]);
  const shared = new Engine(adapter, engine.store, combined); await shared.bind(dc, 'tg-session'); await shared.submit(dc, 'shared-dc-run', 'hello');
  const tg = { userId: '111', guildId: 'telegram', channelId: '111' }; await shared.bind(tg, 'tg-session');
  await assert.rejects(shared.submit(tg, 'shared-tg-run', 'hello'), { code: 'RUN_BUSY' }); assert.equal(adapter.prompts.length, 2);
});
test('reply failure never re-executes an admitted Telegram prompt; status remains discoverable', async t => {
  const { bot, api, adapter, store } = await setup(t); await bot.handleUpdate(update(1, '/bind tg-session')); api.failSend = true;
  const message = update(2, '/prompt hello'); await bot.handleUpdate(message); api.failSend = false; await bot.handleUpdate(message);
  assert.equal(adapter.prompts.length, 1); assert.equal(store.get('tg-123456-2')?.state, 'accepted');
  await bot.handleUpdate(update(3, '/status')); assert.match(String(api.messages().at(-1)?.text), /tg-123456-2/);
});
test('Telegram cursor and receipts survive restart; claimed but interrupted commands are not replayed', async t => {
  const { bot, api, engine, store, config, policy, adapter } = await setup(t);
  api.updates = [update(10, '/bind tg-session'), update(11, '/prompt once')]; await bot.pollOnce();
  assert.equal(store.setting('telegram:123456:offset'), '12'); assert.equal(adapter.prompts.length, 1);
  store.close(); const reopened = new Store(config.databasePath);
  try {
    const replacement = new TelegramBot(config, new Engine(adapter, reopened, policy), api); await replacement.initialize();
    api.updates = [update(11, '/prompt once')]; await replacement.pollOnce(); assert.equal(adapter.prompts.length, 1);
    const args = api.calls.filter(c => c.method === 'getUpdates').at(-1)?.args as Record<string, unknown>; assert.equal(args.offset, 12); assert.deepEqual(args.allowed_updates, ['message']);
    reopened.claimReceipt('telegram:123456:20'); await replacement.handleUpdate(update(20, '/prompt interrupted before admission')); assert.equal(adapter.prompts.length, 1);
    assert.equal(reopened.binding('telegram:111:111'), 'tg-session');
  } finally { reopened.close(); }
});
test('long Telegram result is one plain-text document and transport mismatch cannot send', async t => {
  const { bot, api, engine } = await setup(t); await bot.handleUpdate(update(1, '/bind tg-session')); const actor = { userId: '111', guildId: 'telegram', channelId: '111' };
  const run = await engine.submit(actor, 'tg-test', 'hello'); run.state = 'succeeded'; run.result = '🚀'.repeat(4000) + TOKEN;
  const payload = telegramResult(run); assert.ok(payload.text.length < 4096); assert.ok(payload.document);
  await bot.notify(run); const doc = api.calls.at(-1); assert.equal(doc?.method, 'sendDocument'); const form = doc?.args as FormData;
  assert.equal((await (form.get('document') as Blob).text()).includes(TOKEN), false); assert.equal(form.get('chat_id'), '111');
  await assert.rejects(bot.notify({ ...run, guildId: 'discord' }), { code: 'TRANSPORT_MISMATCH' });
});
test('new/unbind/help and notify remain explicit commands, not arbitrary text execution', async t => {
  const { bot, api, engine } = await setup(t); await bot.handleUpdate(update(1, '/new project')); assert.match(String(api.messages().at(-1)?.text), /new/);
  await bot.handleUpdate(update(2, '/unbind')); assert.equal(engine.binding({ userId: '111', guildId: 'telegram', channelId: '111' }), undefined);
  await bot.handleUpdate(update(3, '/help')); assert.match(String(api.messages().at(-1)?.text), /\/prompt/);
  await bot.handleUpdate(update(4, '/notify')); assert.match(String(api.messages().at(-1)?.text), /RUN_INVALID/);
});
test('stale offset is discarded before week-idle random IDs can skip a new command', async t => {
  const { bot, api, engine, store, config } = await setup(t);
  api.updates = [update(1000, '/bind tg-session')]; await bot.pollOnce();
  store.setSetting('telegram:123456:lastReceivedAt', String(Date.now() - 8 * 86400000));
  const replacement = new TelegramBot(config, engine, api); await replacement.initialize();
  api.updates = [update(2, '/prompt after idle')]; await replacement.pollOnce();
  const args = api.calls.filter(c => c.method === 'getUpdates').at(-1)?.args as Record<string, unknown>;
  assert.equal(args.offset, undefined); assert.equal(store.setting('telegram:123456:offset'), '3');
  assert.equal(store.get('tg-123456-2')?.state, 'accepted');
});
test('malformed polling batches cannot advance durable cursor or admit prompts', async t => {
  const { bot, api, adapter, store } = await setup(t);
  api.updates = [update(1, '/bind tg-session'), { update_id: -1 }];
  await assert.rejects(bot.pollOnce(), { code: 'TELEGRAM_PROTOCOL' });
  assert.equal(store.setting('telegram:123456:offset'), undefined); assert.equal(adapter.prompts.length, 0);
});
test('stop aborts real API long polling and settles the polling loop before closing storage', async t => {
  const { config, engine } = await setup(t); let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1);
    if (method === 'getUpdates') {
      entered(); return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    const result = method === 'getMe' ? { id: 123456, is_bot: true, username: 'SafeAgentBot' } : method === 'getWebhookInfo' ? { url: '' } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as typeof fetch;
  const bot = new TelegramBot(config, engine, new TelegramApi(TOKEN, fetcher));
  const running = bot.run(false); await waiting; bot.stop(); await running;
  assert.equal(engine.store.latest('111', 'telegram', '111'), undefined);
});
test('Telegram webhook/poller conflict is surfaced without silent takeover or retry loop', async () => {
  const api = new TelegramApi(TOKEN, (async () => new Response(JSON.stringify({ ok: false, error_code: 409, description: TOKEN }), { status: 409 })) as typeof fetch);
  await assert.rejects(api.call('getUpdates'), error => error instanceof TelegramApiError && error.code === 'TELEGRAM_CONFLICT' && !safeError(error).includes(TOKEN));
});
