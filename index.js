import { DiscordHost, RPC_CHANNEL, RPC_ENDPOINT } from './host-runtime.js';
export { DiscordHost } from './host-runtime.js';
// Cordis Host injection names services, not dependency package identifiers.
export const inject = ['connection', 'sessionController'];
const names = [
  'sessions.list', 'sessions.create', 'sessions.history', 'sessions.sharedWithDesktop',
  'runs.submit', 'runs.status', 'runs.cancel', 'runs.atomicAcceptance', 'runs.idempotentSubmit',
  'approvals.list', 'approvals.decide', 'attachments.upload', 'attachments.imageInput',
  'artifacts.download', 'events.stream', 'events.resume', 'desktopRuns.observe',
  'management.authorization', 'secrets.protectedStorage', 'settings.persist',
  'migration.explicit', 'discord.receiver'
];
const capabilities = Object.freeze(Object.fromEntries(names.map(name => [name,
  Object.freeze({ supported: false, reason: 'NOT_IMPLEMENTED_OR_NOT_VERIFIED' })])));
const reasons = Object.freeze(['MANAGEMENT_AUTHORIZATION_UNAVAILABLE', 'PROTECTED_SECRET_STORE_UNAVAILABLE',
  'HOST_COMPATIBILITY_UNVERIFIED', 'ATOMIC_ACCEPTANCE_UNVERIFIED', 'RECEIVER_NOT_IMPLEMENTED']);
export class FoundationHost {
  #state;
  constructor(config = {}) {
    // The only accepted activation configuration is empty. Never retain unknown
    // input (it might contain a mistakenly pasted token) or echo it in errors.
    this.#state = config !== null && typeof config === 'object' && !Array.isArray(config)
      && Object.keys(config).length === 0 ? 'unconfigured' : 'blocked';
  }
  status() {
    return Object.freeze({ contractVersion: 1, state: this.#state, receiverStarted: false,
      nativeRunsTouched: false, supportedDshVersion: '0.2.0-rc.2', compatibility: 'unverified',
      reasons, capabilities });
  }
  async dispatch(_request) {
    // Internal-only boundary. Do not expose this as Remote until an independently
    // verified owner/admin authority can authenticate and authorize every call.
    return { ok: false, code: this.#state === 'disposed' ? 'DISPOSED' : 'MANAGEMENT_AUTHORIZATION_UNAVAILABLE' };
  }
  async dispose() { this.#state = 'disposed'; }
}
export function apply(ctx, config = {}) {
  const host = new DiscordHost(ctx, config);
  // Documented Host RPC is connection-authenticated local authority, not RFC-M
  // owner/admin. No HTTP/Cookie bridge or claimed caller-bound grants are installed.
  ctx.effect(() => ctx.connection.rpc.handle(RPC_CHANNEL, (endpoint, payload, signal) => endpoint === RPC_ENDPOINT
    ? host.dispatch(payload, signal) : Promise.resolve({ ok: false, code: 'INVALID_REQUEST' })));
  ctx.effect(() => { void host.boot(); return () => host.dispose(); });
}
