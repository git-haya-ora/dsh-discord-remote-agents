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
  return { adapter, calls, agent, setRegistryAgent: (value: unknown) => { registryAgent = value; } };
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
