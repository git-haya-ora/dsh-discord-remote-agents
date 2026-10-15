import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
const { DiscordHost, validateBot } = await import(new URL('../../packages/discord-plugin/host-runtime.js', import.meta.url).href) as typeof import('../packages/discord-plugin/host-runtime.js');
const guildId = '222222222222222222', applicationId = '444444444444444444';
const syntheticToken = 'synthetic.fixture.NOT-A-REAL-TOKEN';
async function setup(t: { after(fn: () => unknown): void }, prepareRoot?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'restricted-host-fixture-'));
  const store = new Store(':memory:', true), secrets = new Map<string, string>();
  let creates = 0, receiverCreates = 0, receiverStops = 0, failRetire = false;
  const ctx = { effect() {}, connection: { rpc: { handle() { return () => {}; } } }, sessionController: {
    async list() { return { items: [] }; }, async create() {}, async page() {}, async projections() {}, async prompt() {}
  } };
  const host = new DiscordHost(ctx, { dataRoot: root }, {
    prepareRoot: prepareRoot ?? (async () => {}), openStore: () => store,
    secretStore: {
      async create(value: string) { const ref = String(++creates).padStart(64, '0'); secrets.set(ref, value); return ref; },
      async read(ref: string) { const value = secrets.get(ref); if (!value) throw new Error('Secret missing'); return value; },
      async retire(ref: string) { if (failRetire) throw new Error(syntheticToken); secrets.delete(ref); }
    },
    fetcher: async (url: string) => new Response(JSON.stringify(url.endsWith('/users/@me') ? { id: applicationId, username: 'fixture', bot: true } : { id: applicationId, bot: { id: applicationId } }), { status: 200 }),
    createBot: () => { receiverCreates++; let ready = false; return { client: { isReady: () => ready }, async start() { ready = true; }, async stop() { ready = false; receiverStops++; } }; }
  });
  const settings = { guildId, applicationId, allowedUserIds: ['111111111111111111'], allowedChannelIds: ['333333333333333333'], workspaces: { fixture: root }, autoStart: false };
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }); });
  return { host, store, secrets, settings, counts: () => ({ creates, receiverCreates, receiverStops }), failRetirement: () => { failRetire = true; } };
}
test('management strict DTO, confirmation and revision fail before secret access', async t => {
  const { host, settings, counts } = await setup(t);
  for (const input of [{ operation: 'status', token: syntheticToken }, { operation: 'start', expectedRevision: 0 }, { operation: 'reconnect', expectedRevision: 0, confirmation: false }, { operation: 'save', expectedRevision: -1, settings, token: syntheticToken }]) {
    const reply = await host.dispatch(input); assert.equal(reply.ok, false); assert.ok(!JSON.stringify(reply).includes(syntheticToken));
  }
  assert.deepEqual(counts(), { creates: 0, receiverCreates: 0, receiverStops: 0 });
});
test('save validates Bot, CAS protects writes, status never exposes token/ref, controls one receiver', async t => {
  const { host, settings, secrets, counts } = await setup(t);
  let reply = await host.dispatch({ operation: 'save', expectedRevision: 0, settings, token: syntheticToken });
  assert.equal(reply.ok, true); assert.equal(host.status().revision, 1); assert.equal(host.status().state, 'stopped');
  const serialized = JSON.stringify(host.status()); assert.ok(!serialized.includes(syntheticToken)); for (const ref of secrets.keys()) assert.ok(!serialized.includes(ref));
  assert.deepEqual(await host.dispatch({ operation: 'save', expectedRevision: 0, settings, token: syntheticToken }), { ok: false, code: 'REVISION_CONFLICT' });
  assert.equal(counts().creates, 1);
  reply = await host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true }); assert.equal(reply.ok, true);
  await host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true }); assert.equal(counts().receiverCreates, 1);
  assert.equal(host.status().capabilities.atomicAcceptance, false); assert.equal(host.status().capabilities.text, true);
  await host.dispatch({ operation: 'deleteSecret', expectedRevision: 1, confirmation: true });
  assert.equal(host.status().tokenConfigured, false); assert.equal(host.status().revision, 2); assert.equal(secrets.size, 0); assert.equal(counts().receiverStops, 1);
  await host.dispose(); assert.deepEqual(await host.dispatch({ operation: 'start', expectedRevision: 2, confirmation: true }), { ok: false, code: 'DISPOSED' });
});
test('rotation persists pending encrypted retirement instead of exposing upstream exception', async t => {
  const { host, settings, secrets, failRetirement } = await setup(t);
  await host.dispatch({ operation: 'save', expectedRevision: 0, settings, token: syntheticToken }); failRetirement();
  const reply = await host.dispatch({ operation: 'save', expectedRevision: 1, settings, token: `${syntheticToken}.rotation` });
  assert.equal(reply.ok, true); assert.equal(host.status().lastError, 'SECRET_RETIRE_PENDING'); assert.equal(secrets.size, 2);
  assert.ok(!JSON.stringify(reply).includes(syntheticToken));
});
test('boot takes mutation ownership before delayed initialize; concurrent start/save fail closed', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const { host, settings, counts } = await setup(t, () => gate);
  const boot = host.boot();
  assert.deepEqual(await host.dispatch({ operation: 'start', expectedRevision: 0, confirmation: true }), { ok: false, code: 'MANAGEMENT_BUSY' });
  assert.deepEqual(await host.dispatch({ operation: 'save', expectedRevision: 0, settings, token: syntheticToken }), { ok: false, code: 'MANAGEMENT_BUSY' });
  const status = await host.dispatch({ operation: 'status' }); assert.equal(status.ok, true);
  release(); await boot; assert.equal(counts().receiverCreates, 0);
});
test('official Bot/current Application schema allows missing optional bot, rejects identity mismatch and human user', async () => {
  const fetcher = (user: Record<string, unknown>, app: Record<string, unknown>) => (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith('/users/@me') ? user : app), { status: 200 })) as typeof fetch;
  const user = { id: applicationId, username: 'fixture', bot: true };
  assert.equal((await validateBot(syntheticToken, fetcher(user, { id: applicationId }))).applicationId, applicationId);
  await assert.rejects(validateBot(syntheticToken, fetcher(user, { id: applicationId, bot: { id: guildId } })), { code: 'DISCORD_RESPONSE_INVALID' });
  await assert.rejects(validateBot(syntheticToken, fetcher({ ...user, bot: false }, { id: applicationId })), { code: 'DISCORD_RESPONSE_INVALID' });
});
