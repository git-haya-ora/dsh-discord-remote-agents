import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const COMPONENT_CUSTOM_ID_MAX_LENGTH = 100;
export const COMPONENT_GRANT_DEFAULT_TTL_MS = 5 * 60 * 1000;
export const COMPONENT_GRANT_MAX_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_GRANTS = 4096;
const PREFIX = 'd1';
const NONCE_BYTES = 24;
const MAC_BYTES = 16;
const ID_PATTERN = /d1\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{22})/u;

function text(value, name, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

function version(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${name}`);
  return value;
}

function copyScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('Invalid component scope');
  const binding = scope.binding;
  let copiedBinding = null;
  if (binding !== null) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new TypeError('Invalid binding pin');
    copiedBinding = Object.freeze({
      agentId: text(binding.agentId, 'binding agent id'),
      nativeSessionId: text(binding.nativeSessionId, 'binding session id'),
      version: version(binding.version, 'binding version'),
    });
  }
  const target = scope.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new TypeError('Invalid target pin');
  return Object.freeze({
    actorId: text(scope.actorId, 'actor id'),
    guildId: text(scope.guildId, 'guild id'),
    channelId: text(scope.channelId, 'channel id'),
    threadId: scope.threadId === null ? null : text(scope.threadId, 'thread id'),
    binding: copiedBinding,
    target: Object.freeze({
      kind: text(target.kind, 'target kind', 32),
      id: text(target.id, 'target id'),
      version: version(target.version, 'target version'),
    }),
  });
}

function sameScope(a, b) {
  if (a.actorId !== b.actorId || a.guildId !== b.guildId || a.channelId !== b.channelId || a.threadId !== b.threadId) return false;
  if (a.target.kind !== b.target.kind || a.target.id !== b.target.id || a.target.version !== b.target.version) return false;
  if (a.binding === null || b.binding === null) return a.binding === b.binding;
  return a.binding.agentId === b.binding.agentId &&
    a.binding.nativeSessionId === b.binding.nativeSessionId &&
    a.binding.version === b.binding.version;
}

function immutableGrant(scope, action, expiresAt) {
  return Object.freeze({ ...scope, action, expiresAt });
}

function verifyCustomId(customId, key) {
  if (typeof customId !== 'string' || customId.length > COMPONENT_CUSTOM_ID_MAX_LENGTH) return { ok: false, reason: 'MALFORMED' };
  const match = ID_PATTERN.exec(customId);
  if (!match || match[0] !== customId) return { ok: false, reason: 'MALFORMED' };
  const [, nonce, encodedMac] = match;
  const suppliedMac = Buffer.from(encodedMac, 'base64url');
  const expectedMac = createHmac('sha256', key).update(`${PREFIX}.${nonce}`, 'ascii').digest().subarray(0, MAC_BYTES);
  if (suppliedMac.toString('base64url') !== encodedMac || suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }
  return { ok: true, nonce };
}

export class ComponentActionGuard {
  #key = randomBytes(32);
  #grants = new Map();
  #authorize;
  #now;
  #disposed = false;

  constructor(options) {
    if (!options || typeof options.authorize !== 'function') throw new TypeError('An authorization recheck callback is required');
    this.#authorize = options.authorize;
    this.#now = options.now ?? Date.now;
    if (typeof this.#now !== 'function') throw new TypeError('Invalid clock');
  }

  issue(scope, action, ttlMs = COMPONENT_GRANT_DEFAULT_TTL_MS) {
    this.#assertActive();
    const copiedScope = copyScope(scope);
    const safeAction = text(action, 'action', 32);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > COMPONENT_GRANT_MAX_TTL_MS) throw new RangeError('Invalid grant lifetime');
    const now = this.#time();
    const expiresAt = now + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError('Invalid grant expiry');
    this.sweepExpired();
    if (this.#grants.size >= MAX_PENDING_GRANTS) throw new Error('COMPONENT_GRANT_CAPACITY');

    let nonce;
    for (let attempt = 0; attempt < 8; attempt++) {
      nonce = randomBytes(NONCE_BYTES).toString('base64url');
      if (!this.#grants.has(nonce)) break;
      nonce = undefined;
    }
    if (!nonce) throw new Error('COMPONENT_GRANT_NONCE_COLLISION');

    const unsignedId = `${PREFIX}.${nonce}`;
    const mac = createHmac('sha256', this.#key).update(unsignedId, 'ascii').digest().subarray(0, MAC_BYTES).toString('base64url');
    const customId = `${unsignedId}.${mac}`;
    if (customId.length > COMPONENT_CUSTOM_ID_MAX_LENGTH) throw new Error('COMPONENT_CUSTOM_ID_TOO_LONG');
    const grant = immutableGrant(copiedScope, safeAction, expiresAt);
    this.#grants.set(nonce, { grant, state: 'issued' });
    return Object.freeze({ customId, expiresAt });
  }

  async consume(customId, context) {
    if (this.#disposed) return Object.freeze({ ok: false, reason: 'DISPOSED' });
    const verified = verifyCustomId(customId, this.#key);
    if (!verified.ok) return Object.freeze({ ok: false, reason: verified.reason });
    const nonce = verified.nonce;

    const entry = this.#grants.get(nonce);
    if (!entry) return Object.freeze({ ok: false, reason: 'UNKNOWN' });
    if (entry.state === 'pending') return Object.freeze({ ok: false, reason: 'IN_FLIGHT' });
    if (entry.state === 'revoked') return Object.freeze({ ok: false, reason: 'REVOKED' });

    let currentScope;
    try {
      currentScope = copyScope(context);
    } catch {
      return Object.freeze({ ok: false, reason: 'SCOPE_MISMATCH' });
    }
    if (!sameScope(entry.grant, currentScope)) return Object.freeze({ ok: false, reason: 'SCOPE_MISMATCH' });

    let now;
    try {
      now = this.#time();
    } catch {
      entry.state = 'revoked';
      this.#grants.delete(nonce);
      return Object.freeze({ ok: false, reason: 'AUTHORIZATION_UNAVAILABLE' });
    }
    if (now >= entry.grant.expiresAt) {
      entry.state = 'revoked';
      this.#grants.delete(nonce);
      return Object.freeze({ ok: false, reason: 'EXPIRED' });
    }

    // Reserve synchronously before awaiting policy code so concurrent interactions cannot both proceed.
    entry.state = 'pending';
    let allowed;
    try {
      allowed = await this.#authorize(entry.grant, currentScope);
    } catch {
      entry.state = 'revoked';
      this.#grants.delete(nonce);
      return Object.freeze({ ok: false, reason: 'AUTHORIZATION_UNAVAILABLE' });
    }
    if (entry.state === 'revoked' || this.#grants.get(nonce) !== entry) return Object.freeze({ ok: false, reason: 'REVOKED' });
    let verifiedAt;
    try {
      verifiedAt = this.#time();
    } catch {
      entry.state = 'revoked';
      this.#grants.delete(nonce);
      return Object.freeze({ ok: false, reason: 'AUTHORIZATION_UNAVAILABLE' });
    }
    if (verifiedAt >= entry.grant.expiresAt) {
      entry.state = 'revoked';
      this.#grants.delete(nonce);
      return Object.freeze({ ok: false, reason: 'EXPIRED' });
    }
    this.#grants.delete(nonce);
    entry.state = 'revoked';
    if (allowed !== true) return Object.freeze({ ok: false, reason: 'NOT_AUTHORIZED' });
    return Object.freeze({ ok: true, grant: entry.grant });
  }

  revoke(customId) {
    if (this.#disposed) return false;
    const verified = verifyCustomId(customId, this.#key);
    if (!verified.ok) return false;
    const entry = this.#grants.get(verified.nonce);
    if (!entry) return false;
    entry.state = 'revoked';
    this.#grants.delete(verified.nonce);
    return true;
  }

  revokeAll() {
    for (const entry of this.#grants.values()) entry.state = 'revoked';
    this.#grants.clear();
  }

  sweepExpired() {
    if (this.#disposed) return 0;
    const now = this.#time();
    let removed = 0;
    for (const [nonce, entry] of this.#grants) {
      if (now >= entry.grant.expiresAt) {
        entry.state = 'revoked';
        this.#grants.delete(nonce);
        removed++;
      }
    }
    return removed;
  }

  dispose() {
    if (this.#disposed) return;
    this.revokeAll();
    this.#key.fill(0);
    this.#disposed = true;
  }

  #time() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Invalid clock value');
    return now;
  }

  #assertActive() {
    if (this.#disposed) throw new Error('COMPONENT_GUARD_DISPOSED');
  }
}
