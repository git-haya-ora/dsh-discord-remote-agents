import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The JavaScript plugin source intentionally has no declaration file; this is a runtime-contract test.
import { NativeSessionAdapter } from '../../packages/discord-plugin/native-adapter.js';

function fixture(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const controller = {
    async list(...args: unknown[]) { calls.push({ method: 'list', args }); return { items: [{ sessionId: 'native-session', cwd: '/synthetic/project', running: false, updatedAt: 1, projections: { values: { title: 'synthetic' } } }] }; },
    async create(...args: unknown[]) { calls.push({ method: 'create', args }); return { sessionId: 'created' }; },
    async projections(...args: unknown[]) { calls.push({ method: 'projections', args }); return { asOfSeq: -1, values: { inbox: { 'next-turn': [], 'next-step': [] } } }; },
    async page(...args: unknown[]) { calls.push({ method: 'page', args }); return { records: [], hasMore: false }; },
    async prompt(...args: unknown[]) { calls.push({ method: 'prompt', args }); return { accepted: true }; },
    async modelCatalog(...args: unknown[]) { calls.push({ method: 'modelCatalog', args }); return {
      default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }, routableProviders: ['provider-a'],
      groups: [{ id: 'provider-a', name: 'Provider A', models: [{ id: 'model-a', name: 'Model A', description: 'ignored', reasoning: {
        efforts: [{ id: 'low', name: 'Low', description: 'ignored' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }] }],
      failures: [{ id: 'provider-b', name: 'Provider B', message: 'PRIVATE_RAW_PROVIDER_ERROR /synthetic/private' }]
    }; },
    async rename(...args: unknown[]) { calls.push({ method: 'rename', args }); return { title: 'Normalized title', seq: 9 }; },
    ...overrides
  };
  return { adapter: new NativeSessionAdapter(controller, undefined), calls, controller };
}

test('model catalog filters untrusted details and provider failure message before DTO crosses plugin boundary', async () => {
  const { adapter, calls } = fixture();
  const catalog = await adapter.modelCatalog();
  assert.deepEqual(catalog, { default: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }, routableProviders: ['provider-a'],
    groups: [{ id: 'provider-a', name: 'Provider A', models: [{ id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }] }], failedProviders: 1 });
  assert.equal(JSON.stringify(catalog).includes('PRIVATE_RAW_PROVIDER_ERROR'), false);
  assert.equal(JSON.stringify(catalog).includes('/synthetic/private'), false);
  assert.deepEqual(calls.map(call => call.method), ['modelCatalog']);
  assert.deepEqual(calls[0]!.args, []);
});

test('Native profile probe is read-only, exact-session-scoped and accepts only modern empty records envelope', async () => {
  const { adapter, calls } = fixture();
  await adapter.verifySession('native-session');
  await adapter.verifySession('native-session');
  assert.deepEqual(calls.map(call => call.method), ['list', 'page']);
  assert.deepEqual(calls[1]!.args[0], { address: { kind: 'session', sessionId: 'native-session' }, throughSeq: -1, maxMessages: 1 });
  assert.equal(calls.some(call => ['create', 'prompt', 'rename'].includes(call.method)), false);
});

test('Native profile probe rejects legacy events envelope without fallback or mutation', async () => {
  const { adapter, calls } = fixture({ async page(...args: unknown[]) { calls.push({ method: 'page', args }); return { events: [] }; } });
  await assert.rejects(adapter.verifySession('native-session'), { code: 'DSH_PROTOCOL' });
  assert.deepEqual(calls.map(call => call.method), ['list', 'page']);
  assert.equal(calls.some(call => ['create', 'prompt', 'rename'].includes(call.method)), false);
});

test('Native title method forwards one exact request and returns validated readback metadata', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.rename({ sessionId: 'native-session', title: 'new title' });
  assert.deepEqual(result, { title: 'Normalized title', seq: 9 });
  assert.deepEqual(calls[0]!.args, [{ sessionId: 'native-session', title: 'new title' }]);
  assert.equal(calls[0]!.args.length, 1);
});

test('context metrics use only exact live Session and selected projection keys', () => {
  const { adapter, calls } = fixture();
  const session = { header: { id: 'full-native-session-id', cwd: '/synthetic/workspace' } };
  const serviceCalls: Array<{ method: string; args: unknown[] }> = [];
  let live: typeof session | undefined = session;
  const sessions = { get(id: string) { serviceCalls.push({ method: 'sessions.get', args: [id] }); return id === session.header.id ? live : undefined; } };
  const sessionProjections = { snapshot(candidate: unknown, keys: Iterable<string>) {
    serviceCalls.push({ method: 'sessionProjections.snapshot', args: [candidate, [...keys]] });
    return { asOfSeq: 12, values: {
      contextPressure: { pressureTokens: 101, projectedTokens: 203, contextWindow: 8192, nestedSecret: 'PRIVATE_CONTEXT_SECRET' },
      contextBreakdown: { systemTokens: 11, toolsTokens: 22, messageTokens: 33, rawPrompt: 'PRIVATE_PROMPT' },
      tokenUsage: { inputTokens: 999999 }, unrequested: { secret: 'PRIVATE_OTHER_VIEW' }
    } };
  } };
  assert.equal(adapter.attachContextMetricServices(sessions, sessionProjections), true);
  assert.deepEqual(adapter.contextMetrics(session.header.id, session.header.cwd), {
    pressureTokens: 101, projectedTokens: 203, contextWindow: 8192,
    systemTokens: 11, toolsTokens: 22, messageTokens: 33, asOfSeq: 12
  });
  assert.deepEqual(serviceCalls, [
    { method: 'sessions.get', args: ['full-native-session-id'] },
    { method: 'sessionProjections.snapshot', args: [session, ['contextPressure', 'contextBreakdown']] }
  ]);
  assert.equal(JSON.stringify(adapter.contextMetrics(session.header.id, session.header.cwd)).includes('PRIVATE_'), false);
  live = undefined;
  assert.equal(adapter.contextMetrics(session.header.id, session.header.cwd), undefined);
  assert.equal(serviceCalls.filter(call => call.method === 'sessionProjections.snapshot').length, 2);
  assert.deepEqual(calls, []);
});

test('context metrics live miss uses exact full ID once and never cold-resolves or queries another service', () => {
  const { adapter, calls } = fixture();
  const serviceCalls: Array<{ method: string; args: unknown[] }> = [];
  let projectionCalls = 0;
  const sessions = { get(id: string) { serviceCalls.push({ method: 'sessions.get', args: [id] }); return undefined; } };
  const projections = { snapshot(...args: unknown[]) { projectionCalls++; serviceCalls.push({ method: 'snapshot', args }); return undefined; } };
  adapter.attachContextMetricServices(sessions, projections);
  assert.equal(adapter.contextMetrics('full-native-session-id', '/synthetic/workspace'), undefined);
  assert.deepEqual(serviceCalls, [{ method: 'sessions.get', args: ['full-native-session-id'] }]);
  assert.equal(projectionCalls, 0);
  assert.deepEqual(calls, []);
});

test('missing optional context services do not break Native list or canonical Compact', async () => {
  const { adapter, calls } = compactFixture();
  assert.equal(adapter.contextMetrics('native-session', '/synthetic/project'), undefined);
  const rows = await adapter.list();
  assert.equal(rows[0]?.sessionId, 'native-session');
  const target = await adapter.prepareCompactTarget('native-session', '/synthetic/project');
  await adapter.executeCompact(target, new AbortController().signal);
  assert.equal(calls.some(call => call.method === 'commands.execute'), true);
  assert.equal(calls.some(call => call.method === 'create'), false);
});

test('context metrics strictly filters nested extras and accepts only finite safe integer scalars', () => {
  const { adapter, calls } = fixture();
  const session = { header: { id: 'full-native-session-id', cwd: '/synthetic/workspace' } };
  let snapshotCalls = 0;
  const sessions = { get(id: string) { assert.equal(id, session.header.id); return session; } };
  const projections = { snapshot(candidate: unknown, keys: Iterable<string>) {
    snapshotCalls++; assert.strictEqual(candidate, session); assert.deepEqual([...keys], ['contextPressure', 'contextBreakdown']);
    return { asOfSeq: 4, privateExtra: 'PRIVATE_TOP_LEVEL', values: {
      contextPressure: { pressureTokens: 0, projectedTokens: 3, contextWindow: 8192, untrusted: { prompt: 'PRIVATE_NESTED' } },
      contextBreakdown: { systemTokens: true, toolsTokens: Number.NaN, messageTokens: -1, tokenUsage: 999999 },
      unrequested: { shadowClaim: 'PRIVATE_SHADOW' }
    } };
  } };
  adapter.attachContextMetricServices(sessions, projections);
  const result = adapter.contextMetrics(session.header.id, session.header.cwd);
  assert.deepEqual(result, { pressureTokens: 0, projectedTokens: 3, contextWindow: 8192, asOfSeq: 4 });
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(snapshotCalls, 1);
  assert.deepEqual(calls, []);
});

test('context metrics reject malformed-only values without coercion or shadow fallback', () => {
  const { adapter } = fixture();
  const session = { header: { id: 'full-native-session-id', cwd: '/synthetic/workspace' } };
  adapter.attachContextMetricServices({ get: () => session }, { snapshot: () => ({ asOfSeq: '99', values: {
    contextPressure: { pressureTokens: '100', projectedTokens: -1, contextWindow: 0 },
    contextBreakdown: { systemTokens: 1.5, toolsTokens: false, messageTokens: Number.POSITIVE_INFINITY },
    shadowClaim: { pressureTokens: 200 }
  } }) });
  assert.equal(adapter.contextMetrics(session.header.id, session.header.cwd), undefined);
});

test('context projection withdrawal/reprovide ABA discards the old sample without retry', () => {
  const { adapter } = fixture();
  const session = { header: { id: 'full-native-session-id', cwd: '/synthetic/workspace' } };
  let liveGets = 0, snapshots = 0;
  const sessions = { get() { liveGets++; return session; } };
  const projections = { snapshot() {
    snapshots++;
    if (snapshots === 1) { adapter.attachContextMetricServices(undefined, undefined); adapter.attachContextMetricServices(sessions, projections); }
    return { asOfSeq: 1, values: { contextPressure: { pressureTokens: 10 } } };
  } };
  adapter.attachContextMetricServices(sessions, projections);
  assert.equal(adapter.contextMetrics(session.header.id, session.header.cwd), undefined);
  assert.equal(liveGets, 1); assert.equal(snapshots, 1);
  assert.deepEqual(adapter.contextMetrics(session.header.id, session.header.cwd), { pressureTokens: 10, asOfSeq: 1 });
  assert.equal(liveGets, 2); assert.equal(snapshots, 2);
});

test('context projection fails closed for mismatched full ID or workspace', () => {
  const { adapter } = fixture();
  let snapshots = 0;
  const projections = { snapshot() { snapshots++; return { values: { contextPressure: { pressureTokens: 1 } } }; } };
  adapter.attachContextMetricServices({ get: () => ({ header: { id: 'other-id', cwd: '/synthetic/workspace' } }) }, projections);
  assert.equal(adapter.contextMetrics('full-native-session-id', '/synthetic/workspace'), undefined);
  adapter.attachContextMetricServices({ get: () => ({ header: { id: 'full-native-session-id', cwd: '/synthetic/other' } }) }, projections);
  assert.equal(adapter.contextMetrics('full-native-session-id', '/synthetic/workspace'), undefined);
  assert.equal(snapshots, 0);
});

function compactFixture(options: {
  definitionId?: string;
  agentId?: string;
  headerId?: string;
  cwd?: string;
  origin?: string;
  wrongRegistryAgent?: boolean;
  execution?: unknown;
} = {}) {
  const { calls, controller } = fixture();
  const session = { header: {
    id: options.headerId ?? 'native-session', cwd: options.cwd ?? '/synthetic/project',
    ...(options.origin ? { origin: options.origin } : {})
  } };
  const agent = { id: options.agentId ?? 'native-session', session };
  let registryAgent: unknown = options.wrongRegistryAgent ? { id: 'replacement' } : agent;
  const agents = {
    get(id: string) { calls.push({ method: 'agents.get', args: [id] }); return id === 'native-session' ? registryAgent : undefined; }
  };
  const commands = {
    find(candidate: unknown, name: string) {
      calls.push({ method: 'commands.find', args: [candidate, name] });
      return { definitionId: options.definitionId ?? '@deepseek-ai/dsh-command-compact' };
    },
    execute(candidate: unknown, line: string, attachments: unknown[], signal: AbortSignal) {
      calls.push({ method: 'commands.execute', args: [candidate, line, attachments, signal] });
      return options.execution ?? { commandId: 'compact-command', result: { kind: 'success', sourceEventSeq: 10 } };
    }
  };
  const methods = controller as unknown as Record<string, (...args: unknown[]) => unknown>;
  methods.resolveAgent = async (...args: unknown[]) => {
    calls.push({ method: 'resolveAgent', args });
    return { agent };
  };
  const adapter = new NativeSessionAdapter(controller, undefined, undefined, commands, agents);
  return { adapter, calls, agent, commands, agents, setRegistryAgent: (value: unknown) => { registryAgent = value; } };
}

test('Compact resolves the exact ordinary Agent and invokes only the canonical Native command', async () => {
  const { adapter, calls, agent } = compactFixture();
  const target = await adapter.prepareCompactTarget('native-session', '/synthetic/project');
  assert.equal(adapter.isCompactTargetCurrent(target), true);
  const result = await adapter.executeCompact(target, new AbortController().signal);
  assert.deepEqual(result, { commandId: 'compact-command', result: { kind: 'success', sourceEventSeq: 10 } });
  const resolve = calls.find(call => call.method === 'resolveAgent');
  const find = calls.find(call => call.method === 'commands.find');
  const execute = calls.find(call => call.method === 'commands.execute');
  assert.deepEqual(resolve?.args, ['native-session']);
  assert.equal(find?.args[0], agent);
  assert.equal(find?.args[1], 'compact');
  assert.equal(execute?.args[0], agent);
  assert.equal(execute?.args[1], '/compact');
  assert.deepEqual(execute?.args[2], []);
  assert.equal(execute?.args[3] instanceof AbortSignal, true);
});

test('Compact fails closed for wrong definition, subagent, mismatched Session identity/cwd, or replaced registry Agent', async () => {
  const invalid = [
    { definitionId: 'compact' }, { origin: 'subagent' }, { agentId: 'other-session' },
    { headerId: 'other-session' }, { cwd: '/synthetic/other' }, { wrongRegistryAgent: true }
  ];
  for (const options of invalid) {
    const { adapter, calls } = compactFixture(options);
    await assert.rejects(adapter.prepareCompactTarget('native-session', '/synthetic/project'), { code: 'COMPACT_UNAVAILABLE' });
    assert.equal(calls.some(call => call.method === 'commands.execute'), false);
  }
});

test('Compact rejects a target after the current registry Agent changes without dispatching', async () => {
  const { adapter, calls, setRegistryAgent } = compactFixture();
  const target = await adapter.prepareCompactTarget('native-session', '/synthetic/project');
  setRegistryAgent({ id: 'replacement' });
  assert.equal(adapter.isCompactTargetCurrent(target), false);
  await assert.rejects(adapter.executeCompact(target, new AbortController().signal), { code: 'COMPACT_TARGET_CHANGED' });
  assert.equal(calls.some(call => call.method === 'commands.execute'), false);
});

test('Compact target generation rejects withdrawal/reprovide of identical services and permits a fresh target', async () => {
  const { adapter, calls, commands, agents } = compactFixture();
  const beforeWithdraw = await adapter.prepareCompactTarget('native-session', '/synthetic/project');
  assert.equal(adapter.isCompactTargetCurrent(beforeWithdraw), true);
  assert.equal(adapter.attachCompactServices(undefined, undefined), false);
  assert.equal(adapter.attachCompactServices(commands, agents), true);
  assert.equal(adapter.isCompactTargetCurrent(beforeWithdraw), false);
  await assert.rejects(adapter.executeCompact(beforeWithdraw, new AbortController().signal), { code: 'COMPACT_TARGET_CHANGED' });
  assert.equal(calls.some(call => call.method === 'commands.execute'), false);

  const afterReprovide = await adapter.prepareCompactTarget('native-session', '/synthetic/project');
  assert.equal(adapter.isCompactTargetCurrent(afterReprovide), true);
  await adapter.executeCompact(afterReprovide, new AbortController().signal);
  assert.equal(calls.filter(call => call.method === 'commands.execute').length, 1);
});
