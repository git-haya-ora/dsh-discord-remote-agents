import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import type { Actor, Engine } from '../src/engine.js';
import type { CompactTarget } from '../src/types.js';
const { DiscordHost, validateBot } = await import(new URL('../../packages/discord-plugin/host-runtime.js', import.meta.url).href) as typeof import('../packages/discord-plugin/host-runtime.js');
const { apply: applyDiscordPlugin, inject: requiredDiscordServices } = await import(new URL('../../packages/discord-plugin/index.js', import.meta.url).href) as { apply(ctx: unknown, config?: unknown): void; inject: string[] };
const { Context } = await import('@deepseek-ai/cordis');
const guildId = '222222222222222222', applicationId = '444444444444444444';
const syntheticToken = 'synthetic.fixture.NOT-A-REAL-TOKEN';
async function setup(t: { after(fn: () => unknown): void }, prepareRoot?: () => Promise<void>, noticeFailure = false, noticeGate?: Promise<{ sent: number; failed: number }>) {
  const root = await mkdtemp(join(tmpdir(), 'restricted-host-fixture-'));
  const store = new Store(':memory:', true), secrets = new Map<string, string>();
  let creates = 0, receiverCreates = 0, receiverStops = 0, failRetire = false;
  let currentEngine: Engine | undefined; let noticeCalls = 0;
  const commandRequests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const discordCommands = new Map<string, unknown>([['unrelated', { name: 'unrelated' }]]);
  let registrationFailure = false;
  const ctx = { effect() {}, connection: { fetch: { register() { return () => {}; } } }, sessionController: {
    async list() { return { items: [] }; }, async create() {}, async page() {}, async projections() {}, async prompt() {}
  } };
  const host = new DiscordHost(ctx, { dataRoot: root }, {
    prepareRoot: prepareRoot ?? (async () => {}), openStore: () => store,
    secretStore: {
      async create(value: string) { const ref = String(++creates).padStart(64, '0'); secrets.set(ref, value); return ref; },
      async read(ref: string) { const value = secrets.get(ref); if (!value) throw new Error('Secret missing'); return value; },
      async retire(ref: string) { if (failRetire) throw new Error(syntheticToken); secrets.delete(ref); }
    },
    protectedPayloadStore: {
      async estimate() { return []; }, async createWithRef() {}, async createManyWithRefs() {}, async read() { return { text: '' }; },
      async readMany() { return []; }, async stats() { return { bytes: 0, files: [] }; }, async delete() {}, async deleteMany(refs: string[]) { return refs.map(ref => ({ ref, deleted: false, bytes: 0 })); }
    },
    fetcher: async (url: string, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('user-agent'), 'DiscordBot (https://github.com/git-haya-ora/dsh-discord-remote-agents, 0.2.0-restricted.8)');
      if (url.endsWith('/commands')) {
        const body = JSON.parse(String(init?.body)) as { name?: string };
        commandRequests.push({ url, method: init?.method, body });
        if (registrationFailure) throw new Error('synthetic offline');
        if (init?.method === 'PUT') discordCommands.clear();
        if (typeof body.name === 'string') discordCommands.set(body.name, body);
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify(url.endsWith('/users/@me') ? { id: applicationId, username: 'fixture', bot: true } : { id: applicationId, bot: { id: applicationId } }), { status: 200 });
    },
    createBot: (_config: unknown, engine: Engine) => { currentEngine = engine; receiverCreates++; let ready = false; return { client: { isReady: () => ready }, async start() { ready = true; }, async notifyConnected() { noticeCalls++; assert.equal(host.status().state, 'connected'); return noticeGate ?? { sent: noticeFailure ? 0 : 1, failed: noticeFailure ? 1 : 0 }; }, async stop() { ready = false; receiverStops++; } }; }
  });
  const settings = { guildId, applicationId, allowedUserIds: ['111111111111111111'], allowedChannelIds: ['333333333333333333'], workspaces: { fixture: root }, autoStart: false };
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }); });
  return { host, ctx, store, secrets, settings, commandRequests, discordCommands, failRegistration: () => { registrationFailure = true; }, noticeCalls: () => noticeCalls, engine: () => { assert.ok(currentEngine); return currentEngine; }, counts: () => ({ creates, receiverCreates, receiverStops }), failRetirement: () => { failRetire = true; } };
}
test('explicit command registration upserts only /agent in the configured Guild', async t => {
  const f = await setup(t);
  assert.equal((await f.host.dispatch({ operation: 'save', expectedRevision: 0, settings: f.settings, token: syntheticToken })).ok, true);
  assert.equal(f.commandRequests.length, 0); // Saving never registers or starts the receiver.
  assert.equal((await f.host.dispatch({ operation: 'registerCommands', expectedRevision: 1, confirmation: false })).ok, false);
  assert.equal((await f.host.dispatch({ operation: 'registerCommands', expectedRevision: 0, confirmation: true })).ok, false);
  assert.equal(f.commandRequests.length, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await f.host.dispatch({ operation: 'registerCommands', expectedRevision: 1, confirmation: true })).ok, true);
    const request = f.commandRequests[attempt]!;
    assert.equal(request.url, `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`);
    assert.equal(request.method, 'POST');
    const definition = request.body as { name: string; dm_permission: boolean; options: Array<{ name: string }> };
    assert.equal(definition.name, 'agent');
    assert.equal(definition.dm_permission, false);
    for (const name of ['help', 'sessions', 'new', 'bind', 'prompt', 'status', 'result']) assert.ok(definition.options.some(option => option.name === name));
    assert.equal(f.discordCommands.has('unrelated'), true);
    assert.equal(f.discordCommands.size, 2);
  }
  assert.equal(f.counts().receiverCreates, 0);
});

test('uncertain command registration is not automatically retried or connected', async t => {
  const f = await setup(t);
  assert.equal((await f.host.dispatch({ operation: 'save', expectedRevision: 0, settings: f.settings, token: syntheticToken })).ok, true);
  f.failRegistration();
  const result = await f.host.dispatch({ operation: 'registerCommands', expectedRevision: 1, confirmation: true });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /COMMAND_REGISTRATION_UNKNOWN/u);
  assert.equal(f.commandRequests.length, 1);
  assert.equal(f.counts().receiverCreates, 0);
});

test('Native Compact services are optional; their absence preserves base Host startup', async t => {
  const f = await setup(t);
  assert.equal((await f.host.dispatch({ operation: 'save', expectedRevision: 0, settings: f.settings, token: syntheticToken })).ok, true);
  const started = await f.host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true });
  assert.equal(started.ok, true);
  assert.equal(f.host.status().state, 'connected');
  assert.equal(f.host.status().capabilities.text, true);
  assert.equal(f.counts().receiverCreates, 1);
});

test('service reprovide keeps current Engine usable while stop/restart fences retained Engines', async t => {
  const f = await setup(t);
  const host = f.host as typeof f.host & {
    attachCompactServices(commands: unknown, agents: unknown): boolean;
    attachContextMetricServices(sessions: unknown, sessionProjections: unknown): boolean;
    compactAbort: AbortController;
    adapter: { prepareCompactTarget(sessionId: string, cwd: string): Promise<CompactTarget>; isCompactTargetCurrent(target: CompactTarget): boolean };
  };
  const sessionId = 'native-session-host-lifecycle-synthetic';
  const actor: Actor = { userId: '111111111111111111', guildId, channelId: '333333333333333333' };
  const agent = { id: sessionId, session: { header: { id: sessionId, cwd: f.settings.workspaces.fixture } } };
  const liveSession = { header: { id: sessionId, cwd: f.settings.workspaces.fixture } };
  const projectionCalls: unknown[][] = [];
  const sessions = { get(id: string) { return id === sessionId ? liveSession : undefined; } };
  const sessionProjections = { snapshot(candidate: unknown, keys: Iterable<string>) {
    projectionCalls.push([candidate, [...keys]]);
    return { asOfSeq: projectionCalls.length, values: { contextPressure: { pressureTokens: 9, projectedTokens: 12 } } };
  } };
  let compactExecutions = 0;
  Object.assign(f.ctx.sessionController, {
    resolveAgent: async () => ({ agent }),
    list: async () => ({ items: [{ sessionId, cwd: f.settings.workspaces.fixture, running: false, updatedAt: 1, projections: { values: { title: 'synthetic' } } }] }),
    page: async () => ({ records: [], hasMore: false }),
    projections: async () => ({ asOfSeq: 0, values: { inbox: { 'next-turn': [], 'next-step': [] } } })
  });
  const commands = {
    find() { return { definitionId: '@deepseek-ai/dsh-command-compact' }; },
    execute() { compactExecutions++; return { commandId: 'synthetic-compact-command', result: { kind: 'success', sourceEventSeq: 0 } }; }
  };
  const agents = { get(id: string) { return id === sessionId ? agent : undefined; } };
  assert.equal(host.attachCompactServices(commands, agents), true);
  assert.equal((await f.host.dispatch({ operation: 'save', expectedRevision: 0, settings: f.settings, token: syntheticToken })).ok, true);
  assert.equal((await f.host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true })).ok, true);

  const adapter = host.adapter;
  await f.engine().bind(actor, sessionId);
  const retainedEngine = f.engine();
  assert.deepEqual(await retainedEngine.contextMetrics(actor), { sessionId });
  assert.equal(projectionCalls.length, 0);
  assert.equal(host.attachContextMetricServices(sessions, sessionProjections), true);
  const firstMetrics = await retainedEngine.contextMetrics(actor);
  assert.deepEqual(firstMetrics, { sessionId, metrics: { pressureTokens: 9, projectedTokens: 12, asOfSeq: 1 } });
  assert.deepEqual(projectionCalls[0], [liveSession, ['contextPressure', 'contextBreakdown']]);
  const assertRetainedEngineFenced = async (expectedExecutions: number, expectedIntents: number) => {
    const outcome = await retainedEngine.compact(actor, true).then(
      value => ({ state: value.state }),
      error => ({ code: error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN' })
    );
    assert.deepEqual(outcome, { code: 'COMPACT_UNAVAILABLE' });
    assert.equal(compactExecutions, expectedExecutions);
    assert.equal(f.store.compactIntents().length, expectedIntents);
  };
  const beforeWithdrawal = await adapter.prepareCompactTarget(sessionId, f.settings.workspaces.fixture);
  assert.equal(adapter.isCompactTargetCurrent(beforeWithdrawal), true);
  assert.equal(host.attachCompactServices(undefined, undefined), false);
  assert.equal(adapter.isCompactTargetCurrent(beforeWithdrawal), false);
  assert.equal(host.attachCompactServices(commands, agents), true);
  const afterReprovide = await adapter.prepareCompactTarget(sessionId, f.settings.workspaces.fixture);
  assert.equal(adapter.isCompactTargetCurrent(beforeWithdrawal), false);
  assert.equal(adapter.isCompactTargetCurrent(afterReprovide), true);
  const reprovideOutcome = await retainedEngine.compact(actor, true).then(
    value => ({ state: value.state }),
    error => ({ code: error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN' })
  );
  assert.deepEqual(reprovideOutcome, { state: 'completed' });
  assert.equal(compactExecutions, 1);
  assert.equal(f.store.compactIntents().length, 1);
  assert.deepEqual(await retainedEngine.contextMetrics(actor), { sessionId, metrics: { pressureTokens: 9, projectedTokens: 12, asOfSeq: 2 } });
  const beforeStop = afterReprovide;
  const firstSignal = host.compactAbort.signal;
  assert.equal(adapter.isCompactTargetCurrent(beforeStop), true);
  assert.equal((await f.host.dispatch({ operation: 'stop', expectedRevision: 1 })).ok, true);
  assert.equal(firstSignal.aborted, true);
  assert.equal(adapter.isCompactTargetCurrent(beforeStop), false);
  await assertRetainedEngineFenced(1, 1);
  const projectionCallsAfterStop = projectionCalls.length;
  await assert.rejects(retainedEngine.contextMetrics(actor), { code: 'CONTEXT_METRICS_UNAVAILABLE' });
  assert.equal(projectionCalls.length, projectionCallsAfterStop);

  const stoppedSignal = host.compactAbort.signal;
  assert.equal(stoppedSignal.aborted, false);
  assert.equal((await f.host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true })).ok, true);
  const restartedSignal = host.compactAbort.signal;
  assert.notStrictEqual(restartedSignal, stoppedSignal);
  assert.equal(restartedSignal.aborted, false);
  const afterRestart = await adapter.prepareCompactTarget(sessionId, f.settings.workspaces.fixture);
  assert.equal(adapter.isCompactTargetCurrent(beforeStop), false);
  assert.equal(adapter.isCompactTargetCurrent(afterRestart), true);
  await assertRetainedEngineFenced(1, 1);
  const restartedEngine = f.engine();
  assert.deepEqual(await restartedEngine.contextMetrics(actor), { sessionId, metrics: { pressureTokens: 9, projectedTokens: 12, asOfSeq: 3 } });
  assert.equal(projectionCalls.length, 3);

  const currentResult = await restartedEngine.compact(actor, true);
  assert.equal(currentResult.state, 'completed');
  assert.equal(compactExecutions, 2);
  assert.equal(f.store.compactIntents().length, 2);

  await f.host.dispose();
  assert.equal(restartedSignal.aborted, true);
  assert.equal(adapter.isCompactTargetCurrent(afterRestart), false);
  await assert.rejects(restartedEngine.contextMetrics(actor), { code: 'CONTEXT_METRICS_UNAVAILABLE' });
  assert.equal(projectionCalls.length, 3);
});

test('Cordis optional services attach, withdraw, reprovide, and dispose through the actual Host child fiber', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compact-cordis-wiring-synthetic-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const context = new Context();
  const connection = { fetch: { register() { return () => {}; } } };
  const sessionController = { async list() {}, async create() {}, async projections() {}, async page() {}, async prompt() {} };
  const commands = { find() {}, execute() {} }, agents = { get() {} };
  const sessions = { get() {} }, sessionProjections = { snapshot() {} };
  const disposers: Array<() => void | Promise<void>> = [
    await context.provide('connection', connection), await context.provide('sessionController', sessionController),
    await context.provide('commands', commands), await context.provide('agents', agents),
    await context.provide('sessions', sessions), await context.provide('sessionProjections', sessionProjections)
  ];
  const attachCalls: Array<[unknown, unknown]> = [];
  const metricAttachCalls: Array<[unknown, unknown]> = [];
  const hostPrototype = DiscordHost.prototype as typeof DiscordHost.prototype & {
    attachCompactServices(commands: unknown, agents: unknown): boolean;
    attachContextMetricServices(sessions: unknown, sessionProjections: unknown): boolean;
  };
  const originalAttach = hostPrototype.attachCompactServices;
  const originalMetricsAttach = hostPrototype.attachContextMetricServices;
  const originalBoot = DiscordHost.prototype.boot;
  hostPrototype.attachCompactServices = function (nextCommands: unknown, nextAgents: unknown) {
    attachCalls.push([nextCommands, nextAgents]);
    return originalAttach.call(this, nextCommands, nextAgents);
  };
  hostPrototype.attachContextMetricServices = function (nextSessions: unknown, nextProjections: unknown) {
    metricAttachCalls.push([nextSessions, nextProjections]);
    return originalMetricsAttach.call(this, nextSessions, nextProjections);
  };
  DiscordHost.prototype.boot = async function () {};
  let pluginFiber: Awaited<ReturnType<typeof context.plugin>> | undefined;
  try {
    pluginFiber = await context.plugin({ name: 'synthetic-discord-host', inject: requiredDiscordServices, apply: applyDiscordPlugin }, { dataRoot: root });
    assert.equal(attachCalls.length, 1);
    assert.strictEqual(attachCalls[0]![0], commands); assert.strictEqual(attachCalls[0]![1], agents);
    assert.equal(metricAttachCalls.length, 1);
    assert.strictEqual(metricAttachCalls[0]![0], sessions); assert.strictEqual(metricAttachCalls[0]![1], sessionProjections);

    await disposers[3]!();
    assert.deepEqual(attachCalls.at(-1), [undefined, undefined]);
    disposers[3] = await context.provide('agents', agents);
    assert.strictEqual(attachCalls.at(-1)?.[0], commands); assert.strictEqual(attachCalls.at(-1)?.[1], agents);

    await disposers[2]!();
    assert.deepEqual(attachCalls.at(-1), [undefined, undefined]);
    disposers[2] = await context.provide('commands', commands);
    assert.strictEqual(attachCalls.at(-1)?.[0], commands); assert.strictEqual(attachCalls.at(-1)?.[1], agents);

    await disposers[5]!();
    assert.deepEqual(metricAttachCalls.at(-1), [undefined, undefined]);
    disposers[5] = await context.provide('sessionProjections', sessionProjections);
    assert.strictEqual(metricAttachCalls.at(-1)?.[0], sessions); assert.strictEqual(metricAttachCalls.at(-1)?.[1], sessionProjections);
    await disposers[4]!();
    assert.deepEqual(metricAttachCalls.at(-1), [undefined, undefined]);
    disposers[4] = await context.provide('sessions', sessions);
    assert.strictEqual(metricAttachCalls.at(-1)?.[0], sessions); assert.strictEqual(metricAttachCalls.at(-1)?.[1], sessionProjections);
    assert.deepEqual(requiredDiscordServices, ['connection', 'sessionController']);
  } finally {
    if (pluginFiber) await pluginFiber.dispose();
    for (const dispose of disposers.reverse()) await dispose();
    hostPrototype.attachCompactServices = originalAttach;
    hostPrototype.attachContextMetricServices = originalMetricsAttach;
    DiscordHost.prototype.boot = originalBoot;
  }
  assert.deepEqual(attachCalls.at(-1), [undefined, undefined]);
  assert.deepEqual(metricAttachCalls.at(-1), [undefined, undefined]);
});

test('slow notice delivery does not block connected management status', { timeout: 5000 }, async t => {
  let release!: (value: { sent: number; failed: number }) => void;
  const gate = new Promise<{ sent: number; failed: number }>(resolve => { release = resolve; });
  const f = await setup(t, undefined, false, gate);
  assert.equal((await f.host.dispatch({ operation: 'save', expectedRevision: 0, settings: f.settings, token: syntheticToken })).ok, true);
  assert.equal((await f.host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true })).ok, true);
  assert.equal((await f.host.dispatch({ operation: 'status' })).ok, true); assert.equal(f.host.status().state, 'connected');
  release({ sent: 0, failed: 1 }); await gate; await Promise.resolve(); await Promise.resolve();
  assert.equal(f.host.status().lastError, 'CONNECTION_NOTICE_UNCONFIRMED'); assert.equal(f.counts().receiverCreates, 1);
});
test('connection-notice failure preserves a successful receiver and never triggers reconnect', async t => {
  const f = await setup(t, undefined, true);
  const settings = { ...f.settings, connectionNotifications: { dm: true, channels: true } };
  assert.equal((await f.host.dispatch({ operation: 'save', expectedRevision: 0, settings, token: syntheticToken })).ok, true);
  assert.equal((await f.host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true })).ok, true);
  assert.equal(f.host.status().state, 'connected'); assert.equal(f.host.status().lastError, 'CONNECTION_NOTICE_UNCONFIRMED');
  await f.host.dispatch({ operation: 'status' }); assert.equal(f.noticeCalls(), 1); assert.equal(f.counts().receiverCreates, 1); assert.equal(f.counts().receiverStops, 0);
});
test('malformed connection notice flags fail before token validation or persistence', async t => {
  const f = await setup(t);
  for (const flags of [null, [], { dm: true }, { dm: true, channels: 'true' }, { dm: true, channels: false, other: true }]) {
    assert.equal((await f.host.dispatch({ operation: 'save', expectedRevision: 0, settings: { ...f.settings, connectionNotifications: flags }, token: syntheticToken })).ok, false);
  }
  assert.equal(f.counts().creates, 0); assert.equal(f.host.status().revision, 0);
});
test('connect without folders, then explicitly register an existing folder without restarting or changing tokens', async t => {
  const { host, settings, counts, secrets, engine: getEngine, store } = await setup(t);
  const empty = { ...settings, workspaces: {} };
  assert.equal((await host.dispatch({ operation: 'save', expectedRevision: 0, settings: empty, token: syntheticToken })).ok, true);
  assert.equal((await host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true })).ok, true);
  const engine = getEngine();
  const actor = { userId: settings.allowedUserIds[0]!, guildId, channelId: settings.allowedChannelIds[0]! };
  const add = engine.registerWorkspace!;
  assert.equal(host.status().state, 'connected');
  assert.equal(await engine.policy.allowsCwd(settings.workspaces.fixture, guildId), false);
  await assert.rejects(add(actor, 'project', settings.workspaces.fixture, false));
  await assert.rejects(add({ ...actor, userId: '999999999999999999' }, 'project', settings.workspaces.fixture, true));
  await assert.rejects(add(actor, 'project', join(settings.workspaces.fixture, 'nonexistent'), true));
  assert.equal(host.status().revision, 1);
  await add(actor, 'project', settings.workspaces.fixture, true);
  assert.equal(host.status().revision, 2);
  assert.equal(host.status().settings!.workspaces.project, settings.workspaces.fixture);
  assert.equal(await engine.policy.allowsCwd(settings.workspaces.fixture, guildId), true);
  assert.equal(engine.policy.workspace('project', guildId), settings.workspaces.fixture);
  assert.equal(engine.binding(actor), undefined); assert.equal(store.allRuns().length, 0);
  assert.equal(host.status().state, 'connected'); assert.equal(secrets.size, 1);
  assert.deepEqual(counts(), { creates: 1, receiverCreates: 1, receiverStops: 0 });
  await assert.rejects(add(actor, 'project', settings.workspaces.fixture, true));
  assert.equal(host.status().revision, 2);
  assert.deepEqual(await host.dispatch({ operation: 'save', expectedRevision: 1, settings: empty }), { ok: false, code: 'REVISION_CONFLICT' });
  assert.ok(!JSON.stringify(host.status()).includes(syntheticToken));
});

test('failed workspace persistence never grants directory access', async t => {
  const { host, settings, store, engine: getEngine } = await setup(t);
  await host.dispatch({ operation: 'save', expectedRevision: 0, settings: { ...settings, workspaces: {} }, token: syntheticToken });
  await host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true });
  const actor = { userId: settings.allowedUserIds[0]!, guildId, channelId: settings.allowedChannelIds[0]! };
  const compare = store.compareSetting.bind(store);
  store.compareSetting = () => false;
  await assert.rejects(getEngine().registerWorkspace!(actor, 'project', settings.workspaces.fixture, true));
  store.compareSetting = compare;
  assert.equal(host.status().revision, 1);
  assert.equal(await getEngine().policy.allowsCwd(settings.workspaces.fixture, guildId), false);
});

test('workspace storage read failure releases management ownership for a later explicit attempt', async t => {
  const { host, settings, store, engine: getEngine } = await setup(t);
  await host.dispatch({ operation: 'save', expectedRevision: 0, settings: { ...settings, workspaces: {} }, token: syntheticToken });
  await host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true });
  const actor = { userId: settings.allowedUserIds[0]!, guildId, channelId: settings.allowedChannelIds[0]! };
  const read = store.setting.bind(store);
  store.setting = () => { throw new Error('synthetic storage failure'); };
  await assert.rejects(getEngine().registerWorkspace!(actor, 'project', settings.workspaces.fixture, true));
  store.setting = read;
  assert.equal(await getEngine().policy.allowsCwd(settings.workspaces.fixture, guildId), false);
  await getEngine().registerWorkspace!(actor, 'project', settings.workspaces.fixture, true);
  assert.equal(host.status().revision, 2);
});

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
test('dispose during asynchronous Native capability list prevents stale Bot construction/start', { timeout: 5000 }, async t => {
  const f = await setup(t);
  assert.equal((await f.host.dispatch({ operation: 'save', expectedRevision: 0, settings: f.settings, token: syntheticToken })).ok, true);
  let entered!: () => void, release!: () => void;
  const listed = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.ctx.sessionController.list = async () => { entered(); await gate; return { items: [] }; };
  const start = f.host.dispatch({ operation: 'start', expectedRevision: 1, confirmation: true });
  await listed;
  await f.host.dispose();
  assert.deepEqual(await start, { ok: false, code: 'RECEIVER_NOT_READY' });
  assert.equal(f.host.status().state, 'disposed'); assert.equal(f.host.status().capabilities.text, false);
  assert.deepEqual(f.counts(), { creates: 1, receiverCreates: 0, receiverStops: 0 });
  release(); await gate; await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.counts(), { creates: 1, receiverCreates: 0, receiverStops: 0 });
});
test('official Bot/current Application schema allows missing optional bot, rejects identity mismatch and human user', async () => {
  const fetcher = (user: Record<string, unknown>, app: Record<string, unknown>) => (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith('/users/@me') ? user : app), { status: 200 })) as typeof fetch;
  const user = { id: applicationId, username: 'fixture', bot: true };
  assert.equal((await validateBot(syntheticToken, fetcher(user, { id: applicationId }))).applicationId, applicationId);
  await assert.rejects(validateBot(syntheticToken, fetcher(user, { id: applicationId, bot: { id: guildId } })), { code: 'DISCORD_RESPONSE_INVALID' });
  await assert.rejects(validateBot(syntheticToken, fetcher({ ...user, bot: false }, { id: applicationId })), { code: 'DISCORD_RESPONSE_INVALID' });
});
