import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { Engine, type Actor } from '../src/engine.js';
import { Policy } from '../src/policy.js';
import { bindingKey, Store } from '../src/store.js';
import type { AgentAdapter, CompactExecution, CompactTarget, SessionInfo, Snapshot, WireEvent } from '../src/types.js';

const actor: Actor = { userId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' };
const sessionId = 'native-session-compact-synthetic';
const applicationId = '444444444444444444', botId = '555555555555555555';
const compactDefinition = '@deepseek-ai/dsh-command-compact' as const;
type FixtureMode = 'native-error' | 'throw' | 'malformed' | 'success-zero' | 'noop' | 'negative-zero';

class CompactFixtureAdapter implements AgentAdapter {
  executions = 0; targetPreparations = 0; targetChecks = 0; snapshotCalls = 0; promptCalls = 0;
  running = false;
  inbox: { 'next-turn': unknown[]; 'next-step': unknown[] } = { 'next-turn': [], 'next-step': [] };
  cursorSequence: number[] = [];
  targetCurrentSequence: boolean[] = [];
  onPrepare?: () => void;
  constructor(readonly cwd: string, readonly mode: FixtureMode, readonly rawNativeText: string) {}
  async list(): Promise<SessionInfo[]> {
    return [{ sessionId, cwd: this.cwd, running: this.running, title: 'synthetic session', subagent: false, updatedAt: 1 }];
  }
  async create(): Promise<string> { throw new Error('not used'); }
  async snapshot(): Promise<Snapshot> {
    const cursor = this.cursorSequence[this.snapshotCalls] ?? 0; this.snapshotCalls++;
    return { cursor, values: { inbox: this.inbox } };
  }
  async events(): Promise<WireEvent[]> { return []; }
  async prompt(): Promise<void> { this.promptCalls++; }
  async prepareCompactTarget(targetSessionId: string, cwd: string): Promise<CompactTarget> {
    this.targetPreparations++; this.onPrepare?.();
    return { sessionId: targetSessionId, agentId: 'native-agent-synthetic', cwd, definitionId: compactDefinition };
  }
  isCompactTargetCurrent(): boolean {
    const current = this.targetCurrentSequence[this.targetChecks] ?? true; this.targetChecks++; return current;
  }
  async executeCompact(): Promise<CompactExecution | undefined> {
    this.executions++;
    if (this.mode === 'throw') throw new Error(this.rawNativeText);
    if (this.mode === 'native-error') return { commandId: 'native-command-synthetic', result: { kind: 'error', text: this.rawNativeText } };
    if (this.mode === 'malformed') return { commandId: 'native-command-synthetic', result: { kind: 'unexpected', text: this.rawNativeText } } as unknown as CompactExecution;
    if (this.mode === 'success-zero') return { commandId: 'native-command-synthetic', result: { kind: 'success', sourceEventSeq: 0 } };
    if (this.mode === 'negative-zero') return { commandId: 'native-command-synthetic', result: { kind: 'success', sourceEventSeq: -0 } };
    return { commandId: 'native-command-synthetic', result: { kind: 'success', text: 'No compactable history yet.' } };
  }
}

async function setup(t: { after(fn: () => unknown): void }, mode: FixtureMode) {
  const dir = await mkdtemp(join(tmpdir(), 'compact-engine-test-'));
  const config: Config = {
    token: 'synthetic.fixture.NOT-A-REAL-TOKEN', applicationId, guildId: actor.guildId,
    allowedUserIds: new Set([actor.userId]), allowedChannelIds: new Set([actor.channelId]),
    workspaces: { fixture: dir }, dshUrl: 'http://127.0.0.1:19387', dshToken: 'synthetic-dsh-token',
    pollIntervalMs: 5000, databasePath: join(dir, 'state.sqlite')
  };
  const policy = await Policy.create(config);
  const databasePath = config.databasePath;
  let store = new Store(databasePath, true);
  store.setSetting('restricted-storage-profile', 'single-operator-text-v1');
  const adapter = new CompactFixtureAdapter(dir, mode, `RAW_NATIVE_${mode}_DO_NOT_EXPOSE`);
  const newEngine = () => new Engine(adapter, store, policy, [], false, undefined, { applicationId, botId });
  let engine = newEngine();
  await engine.bind(actor, sessionId);
  t.after(async () => { try { store.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  return {
    adapter,
    config,
    engine: () => engine,
    store: () => store,
    reopen() {
      store.close();
      store = new Store(databasePath, true);
      store.setSetting('restricted-storage-profile', 'single-operator-text-v1');
      engine = newEngine();
    }
  };
}

for (const mode of ['native-error', 'throw', 'malformed'] as const) {
  test(`compact ${mode} remains durably unknown, is not replayed, and hides Native text`, async t => {
    const fixture = await setup(t, mode);
    const first = await fixture.engine().compact(actor, true);
    assert.equal(first.state, 'unknown');
    assert.equal(fixture.adapter.executions, 1);
    assert.ok(!JSON.stringify(first).includes(`RAW_NATIVE_${mode}_DO_NOT_EXPOSE`));
    assert.ok(!JSON.stringify(fixture.store().latestCompactIntent(sessionId)).includes(`RAW_NATIVE_${mode}_DO_NOT_EXPOSE`));

    await assert.rejects(fixture.engine().compact(actor, true), { code: 'COMPACT_UNKNOWN' });
    assert.equal(fixture.adapter.executions, 1);

    fixture.reopen();
    assert.equal(fixture.store().latestCompactIntent(sessionId)?.state, 'unknown');
    assert.ok(!JSON.stringify(fixture.store().latestCompactIntent(sessionId)).includes(`RAW_NATIVE_${mode}_DO_NOT_EXPOSE`));
    await assert.rejects(fixture.engine().compact(actor, true), { code: 'COMPACT_UNKNOWN' });
    assert.equal(fixture.adapter.executions, 1);
    assert.equal(fixture.store().binding(bindingKey(actor.guildId, actor.channelId, actor.userId)), sessionId);
  });
}

test('compact rejects missing confirmation and unauthorized actors before target preparation', async t => {
  const fixture = await setup(t, 'success-zero');
  await assert.rejects(fixture.engine().compact(actor, false), { code: 'COMPACT_CONFIRMATION_REQUIRED' });
  await assert.rejects(fixture.engine().compact({ ...actor, userId: '999999999999999999' }, true), { code: 'NOT_AUTHORIZED' });
  assert.equal(fixture.adapter.targetPreparations, 0);
  assert.equal(fixture.adapter.executions, 0);
  assert.equal(fixture.store().latestCompactIntent(sessionId), undefined);
});

test('compact rejects Native running, queued input, and an active Bridge Run before execution', async t => {
  const fixture = await setup(t, 'success-zero');
  fixture.adapter.running = true;
  await assert.rejects(fixture.engine().compact(actor, true), { code: 'SESSION_BUSY' });
  fixture.adapter.running = false;
  fixture.adapter.inbox['next-turn'] = [{ synthetic: true }];
  await assert.rejects(fixture.engine().compact(actor, true), { code: 'SESSION_BUSY' });
  fixture.adapter.inbox['next-turn'] = [];
  await fixture.engine().submit(actor, 'bridge-run-synthetic', 'synthetic prompt');
  assert.equal(fixture.adapter.promptCalls, 1);
  await assert.rejects(fixture.engine().compact(actor, true), { code: 'SESSION_BUSY' });
  assert.equal(fixture.adapter.executions, 0);
  assert.equal(fixture.store().latestCompactIntent(sessionId), undefined);
});

test('compact detects cursor and current-target changes before Native execution', async t => {
  const cursorFixture = await setup(t, 'success-zero');
  cursorFixture.adapter.cursorSequence = [0, 1];
  await assert.rejects(cursorFixture.engine().compact(actor, true), { code: 'SESSION_CHANGED' });
  assert.equal(cursorFixture.adapter.executions, 0);
  assert.equal(cursorFixture.store().latestCompactIntent(sessionId), undefined);

  const targetFixture = await setup(t, 'success-zero');
  targetFixture.adapter.targetCurrentSequence = [true, false];
  await assert.rejects(targetFixture.engine().compact(actor, true), { code: 'COMPACT_TARGET_CHANGED' });
  assert.equal(targetFixture.adapter.targetChecks, 2);
  assert.equal(targetFixture.adapter.executions, 0);
  assert.equal(targetFixture.store().latestCompactIntent(sessionId), undefined);
});

test('compact stops when Binding changes or actor authorization is revoked during target preparation', async t => {
  const bindingFixture = await setup(t, 'success-zero');
  bindingFixture.adapter.onPrepare = () => bindingFixture.store().unbind(bindingKey(actor.guildId, actor.channelId, actor.userId));
  await assert.rejects(bindingFixture.engine().compact(actor, true), { code: 'BINDING_CONFLICT' });
  assert.equal(bindingFixture.adapter.executions, 0);
  assert.equal(bindingFixture.store().latestCompactIntent(sessionId), undefined);

  const authFixture = await setup(t, 'success-zero');
  authFixture.adapter.onPrepare = () => { authFixture.config.allowedUserIds.delete(actor.userId); };
  await assert.rejects(authFixture.engine().compact(actor, true), { code: 'NOT_AUTHORIZED' });
  assert.equal(authFixture.adapter.executions, 0);
  assert.equal(authFixture.store().latestCompactIntent(sessionId), undefined);
});

test('compact accepts sourceEventSeq zero, records canonical no-op, and rejects negative zero', async t => {
  const zero = await setup(t, 'success-zero');
  const completed = await zero.engine().compact(actor, true);
  assert.equal(completed.state, 'completed'); assert.equal(completed.sourceEventSeq, 0);

  const noop = await setup(t, 'noop');
  const noChange = await noop.engine().compact(actor, true);
  assert.equal(noChange.state, 'noop'); assert.equal(noChange.sourceEventSeq, undefined);

  const negativeZero = await setup(t, 'negative-zero');
  const uncertain = await negativeZero.engine().compact(actor, true);
  assert.equal(uncertain.state, 'unknown'); assert.equal(uncertain.sourceEventSeq, undefined);
  await assert.rejects(negativeZero.engine().compact(actor, true), { code: 'COMPACT_UNKNOWN' });
  assert.equal(negativeZero.adapter.executions, 1);
});
