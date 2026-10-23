import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store, bindingKey } from '../src/store.js';
import type { CompactMaintenanceIntent } from '../src/types.js';

const owner = '111111111111111111', guild = '222222222222222222', channel = '333333333333333333';
const sessionId = 'native-session-synthetic', bindingId = bindingKey(guild, channel, 'shared');
const intent = (id = 'a'.repeat(64), bindingVersion = 1): CompactMaintenanceIntent => ({
  schemaVersion: 1, intentId: id, sessionId, agentId: 'native-agent-synthetic', applicationId: '444444444444444444', botId: '555555555555555555',
  ownerId: owner, guildId: guild, channelId: channel, bindingMode: 'shared', bindingId, bindingVersion,
  workspaceDigest: createHash('sha256').update('synthetic-workspace').digest('hex'),
  definitionId: '@deepseek-ai/dsh-command-compact', state: 'unknown', dispatchedAt: 1_700_000_000_000
});
function open(path: string): Store {
  const store = new Store(path, true); store.setSetting('restricted-storage-profile', 'single-operator-text-v1');
  store.bind(bindingId, sessionId); return store;
}

test('compact unknown intent survives restart and blocks automatic replay until actual canonical outcome', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'compact-intent-test-')), path = join(dir, 'state.sqlite');
  let store = open(path); t.after(async () => { try { store.close(); } catch {} await rm(dir, { recursive: true, force: true }); });
  const first = intent('a'.repeat(64), store.bindingVersion(bindingId)); store.reserveCompactIntent(first);
  assert.deepEqual(store.latestCompactIntent(sessionId), first);
  store.close(); store = new Store(path, true);
  assert.equal(store.latestCompactIntent(sessionId)?.state, 'unknown');
  assert.throws(() => store.reserveCompactIntent(intent('b'.repeat(64), store.bindingVersion(bindingId))), { code: 'COMPACT_UNKNOWN' });
  const completed = store.recordCompactOutcome(first.intentId, { state: 'completed', commandId: 'native-command-synthetic', sourceEventSeq: 0, outcomeAt: first.dispatchedAt + 1 });
  assert.equal(completed.state, 'completed'); assert.equal(completed.sourceEventSeq, 0);
  assert.equal(store.latestCompactIntent(sessionId)?.commandId, 'native-command-synthetic');
});

test('compact intent rejects stale Binding and malformed/noncanonical outcome without altering unknown state', () => {
  const store = open(':memory:');
  try {
    const value = intent('c'.repeat(64), store.bindingVersion(bindingId));
    store.unbind(bindingId, value.bindingVersion);
    assert.throws(() => store.reserveCompactIntent(value), { code: 'BINDING_CONFLICT' });
    store.bind(bindingId, sessionId);
    const fresh = intent('d'.repeat(64), store.bindingVersion(bindingId)); store.reserveCompactIntent(fresh);
    assert.throws(() => store.recordCompactOutcome(fresh.intentId, { state: 'completed', commandId: 'bad', sourceEventSeq: -1, outcomeAt: fresh.dispatchedAt + 1 }), { code: 'COMPACT_INTENT_INVALID' });
    assert.equal(store.compactIntent(fresh.intentId)?.state, 'unknown');
    assert.throws(() => store.recordCompactOutcome(fresh.intentId, { state: 'completed', commandId: 'bad', sourceEventSeq: -0, outcomeAt: fresh.dispatchedAt + 1 }), { code: 'COMPACT_INTENT_INVALID' });
    assert.equal(store.compactIntent(fresh.intentId)?.state, 'unknown');
    assert.throws(() => store.recordCompactOutcome(fresh.intentId, { state: 'completed', commandId: 'bad', sourceEventSeq: 0, outcomeAt: fresh.dispatchedAt - 1 }), { code: 'COMPACT_INTENT_INVALID' });
    assert.equal(store.compactIntent(fresh.intentId)?.state, 'unknown');
  } finally { store.close(); }
});

test('compact success without a checkpoint is recorded as no-op, not as completed history', () => {
  const store = open(':memory:');
  try {
    const value = intent('e'.repeat(64), store.bindingVersion(bindingId)); store.reserveCompactIntent(value);
    const result = store.recordCompactOutcome(value.intentId, { state: 'noop', commandId: 'native-command-noop', outcomeAt: value.dispatchedAt + 1 });
    assert.equal(result.state, 'noop'); assert.equal(result.sourceEventSeq, undefined);
    assert.equal(store.latestCompactIntent(sessionId)?.state, 'noop');
  } finally { store.close(); }
});
