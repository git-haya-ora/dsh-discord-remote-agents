import test from 'node:test';
import assert from 'node:assert/strict';
const guardUrl = new URL('../../packages/discord-plugin/discord-components.js', import.meta.url);
const { ComponentActionGuard, COMPONENT_CUSTOM_ID_MAX_LENGTH } = await import(guardUrl.href) as typeof import('../packages/discord-plugin/discord-components.js');
import type { DiscordComponentScope } from '../packages/discord-plugin/discord-components.js';

const baseScope: DiscordComponentScope = {
  actorId: 'user-1001',
  guildId: 'guild-2002',
  channelId: 'channel-3003',
  threadId: 'thread-4004',
  binding: { agentId: 'agent-1', nativeSessionId: 'session-1', version: 7 },
  target: { kind: 'run', id: 'run-55', version: 3 },
};
const copyScope = (patch: Partial<DiscordComponentScope> = {}): DiscordComponentScope => ({ ...baseScope, ...patch });

test('issues an opaque short custom id with expiry and no embedded scope/action', async () => {
  let now = 10_000;
  const guard = new ComponentActionGuard({ authorize: () => true, now: () => now });
  const issued = guard.issue(baseScope, 'stop-run');
  assert.ok(issued.customId.length <= COMPONENT_CUSTOM_ID_MAX_LENGTH);
  assert.match(issued.customId, /^d1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(issued.expiresAt, now + 300_000);
  assert.ok(!issued.customId.includes('user-1001'));
  assert.ok(!issued.customId.includes('run-55'));
  assert.ok(!issued.customId.includes('stop-run'));
  now = issued.expiresAt;
  assert.deepEqual(await guard.consume(issued.customId, baseScope), { ok: false, reason: 'EXPIRED' });
  guard.dispose();
});

test('pins actor, guild, channel, thread, binding IDs/version and target ID/version exactly', async () => {
  let calls = 0;
  const guard = new ComponentActionGuard({ authorize: (grant, current) => {
    calls++;
    assert.ok(Object.isFrozen(grant));
    assert.ok(Object.isFrozen(grant.binding));
    assert.ok(Object.isFrozen(grant.target));
    assert.ok(Object.isFrozen(current));
    return true;
  } });
  const { customId } = guard.issue(baseScope, 'approval-approve');
  const variants: DiscordComponentScope[] = [
    copyScope({ actorId: 'other-user' }),
    copyScope({ guildId: 'other-guild' }),
    copyScope({ channelId: 'other-channel' }),
    copyScope({ threadId: null }),
    copyScope({ binding: { ...baseScope.binding!, version: 8 } }),
    copyScope({ binding: { ...baseScope.binding!, agentId: 'agent-2' } }),
    copyScope({ binding: { ...baseScope.binding!, nativeSessionId: 'session-2' } }),
    copyScope({ target: { ...baseScope.target, id: 'run-56' } }),
    copyScope({ target: { ...baseScope.target, version: 4 } }),
  ];
  for (const context of variants) assert.deepEqual(await guard.consume(customId, context), { ok: false, reason: 'SCOPE_MISMATCH' });
  assert.equal(calls, 0, 'stale or differently scoped interactions must not reach the authorization callback');
  const result = await guard.consume(customId, baseScope);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(await guard.consume(customId, baseScope), { ok: false, reason: 'UNKNOWN' });
  guard.dispose();
});

test('serializes concurrent consumes and revocation cancels a pending authorization check', async () => {
  let release!: (allowed: boolean) => void;
  const pending = new Promise<boolean>(resolve => { release = resolve; });
  const guard = new ComponentActionGuard({ authorize: () => pending });
  const issued = guard.issue(baseScope, 'cancel-run');
  const first = guard.consume(issued.customId, baseScope);
  const second = await guard.consume(issued.customId, baseScope);
  assert.deepEqual(second, { ok: false, reason: 'IN_FLIGHT' });
  assert.equal(guard.revoke(issued.customId), true);
  release(true);
  assert.deepEqual(await first, { ok: false, reason: 'REVOKED' });
  assert.equal(guard.revoke(issued.customId), false);
  guard.dispose();
});

test('expiry or a broken clock during authorization invalidates the reserved grant', async () => {
  let now = 50_000;
  let release!: (allowed: boolean) => void;
  const pending = new Promise<boolean>(resolve => { release = resolve; });
  const guard = new ComponentActionGuard({ authorize: () => pending, now: () => now });
  const expires = guard.issue(baseScope, 'stop-run', 1_000);
  const consuming = guard.consume(expires.customId, baseScope);
  now = expires.expiresAt;
  release(true);
  assert.deepEqual(await consuming, { ok: false, reason: 'EXPIRED' });

  let brokenClock = false;
  const clockGuard = new ComponentActionGuard({ authorize: () => true, now: () => brokenClock ? Number.NaN : 80_000 });
  const clockId = clockGuard.issue(baseScope, 'page-next').customId;
  brokenClock = true;
  assert.deepEqual(await clockGuard.consume(clockId, baseScope), { ok: false, reason: 'AUTHORIZATION_UNAVAILABLE' });
  assert.deepEqual(await clockGuard.consume(clockId, baseScope), { ok: false, reason: 'UNKNOWN' });
  guard.dispose(); clockGuard.dispose();
});

test('authorization failure fails closed and burns the matching grant', async () => {
  const denied = new ComponentActionGuard({ authorize: () => false });
  const deniedId = denied.issue(baseScope, 'approval-reject').customId;
  assert.deepEqual(await denied.consume(deniedId, baseScope), { ok: false, reason: 'NOT_AUTHORIZED' });
  assert.deepEqual(await denied.consume(deniedId, baseScope), { ok: false, reason: 'UNKNOWN' });

  const unavailable = new ComponentActionGuard({ authorize: async () => { throw new Error('synthetic policy outage'); } });
  const unavailableId = unavailable.issue(baseScope, 'approval-approve').customId;
  assert.deepEqual(await unavailable.consume(unavailableId, baseScope), { ok: false, reason: 'AUTHORIZATION_UNAVAILABLE' });
  assert.deepEqual(await unavailable.consume(unavailableId, baseScope), { ok: false, reason: 'UNKNOWN' });
  denied.dispose(); unavailable.dispose();
});

test('supports targeted/all revocation, expiration sweep and strict lifetime validation', async () => {
  let now = 1_000;
  const guard = new ComponentActionGuard({ authorize: () => true, now: () => now });
  const first = guard.issue(baseScope, 'page-next', 1_000);
  const second = guard.issue(baseScope, 'select-session', 2_000);
  assert.equal(guard.revoke(first.customId), true);
  assert.deepEqual(await guard.consume(first.customId, baseScope), { ok: false, reason: 'UNKNOWN' });
  now = 3_000;
  assert.equal(guard.sweepExpired(), 1);
  assert.deepEqual(await guard.consume(second.customId, baseScope), { ok: false, reason: 'UNKNOWN' });
  assert.throws(() => guard.issue(baseScope, 'stop-run', 999), /Invalid grant lifetime/);
  assert.throws(() => guard.issue(baseScope, 'stop-run', 900_001), /Invalid grant lifetime/);
  const third = guard.issue({ ...baseScope, binding: null }, 'select-agent');
  guard.revokeAll();
  assert.deepEqual(await guard.consume(third.customId, { ...baseScope, binding: null }), { ok: false, reason: 'UNKNOWN' });
  guard.dispose(); guard.dispose();
});

test('rejects forged, malformed and incomplete scope inputs', async () => {
  const guard = new ComponentActionGuard({ authorize: () => true });
  const id = guard.issue(baseScope, 'show-history').customId;
  const [prefix, nonce, mac] = id.split('.');
  assert.ok(prefix && nonce && mac);
  const changedMac = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  assert.deepEqual(await guard.consume(`${prefix}.${nonce}.${changedMac}`, baseScope), { ok: false, reason: 'INVALID_SIGNATURE' });
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lastIndex = alphabet.indexOf(mac.at(-1)!);
  assert.equal(lastIndex % 16, 0, 'canonical final base64url symbol has zero unused bits');
  const aliasMac = `${mac.slice(0, -1)}${alphabet[lastIndex ^ 1]}`;
  const aliasId = `${prefix}.${nonce}.${aliasMac}`;
  assert.deepEqual(await guard.consume(aliasId, baseScope), { ok: false, reason: 'INVALID_SIGNATURE' });
  assert.equal(guard.revoke(aliasId), false);
  assert.deepEqual(await guard.consume(`${id}\n`, baseScope), { ok: false, reason: 'MALFORMED' });
  assert.equal(guard.revoke(`${id}\n`), false);
  assert.deepEqual(await guard.consume('not-a-component-id', baseScope), { ok: false, reason: 'MALFORMED' });
  assert.deepEqual(await guard.consume(id, { ...baseScope, threadId: undefined } as unknown as DiscordComponentScope), { ok: false, reason: 'SCOPE_MISMATCH' });
  assert.throws(() => guard.issue({ ...baseScope, binding: undefined } as unknown as DiscordComponentScope, 'stop-run'), /Invalid binding pin/);
  assert.equal((await guard.consume(id, baseScope)).ok, true, 'malformed/aliased/mismatched attempts do not burn the rightful grant');
  guard.dispose();
});
