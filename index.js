import { DiscordHost, RPC_CHANNEL, RPC_ENDPOINT } from './host-runtime.js';
export { DiscordHost } from './host-runtime.js';
// Cordis Host injection names services, not dependency package identifiers.
// Exact Fetch contributions are mounted by Connection's authenticated /api carrier.
// Do not register a separate RPC prefix: affected SDK builds resolve its webServer
// dependency against the Connection provider rather than this consumer.
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
  // The command service is an optional feature: profiles without it still get
  // the ordinary restricted Host runtime. Never add it to required injection.
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['commands'], commands => host.attachCompactServices(commands, ctx.agents)); }
    catch { /* Compact remains unavailable; core Host startup is unaffected. */ }
  }
  // This exact route is reachable only through the official /api carrier, which
  // performs Host/Origin and browser-session admission BEFORE dispatching routes.
  // The outer Connection reply carries our own narrow management DTO as its value.
  if (typeof ctx.connection?.fetch?.register !== 'function') throw new Error('HOST_COMPATIBILITY_UNVERIFIED');
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${RPC_CHANNEL}/${RPC_ENDPOINT}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== `${RPC_CHANNEL}/${RPC_ENDPOINT}`) return new Response(null, { status: 404 });
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response(null, { status: 415 });
      let body;
      try {
        // Independently cap the management envelope; never echo input or errors.
        const reader = request.body?.getReader();
        if (!reader) return new Response(null, { status: 400 });
        const chunks = []; let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            length += value.byteLength;
            if (length > 131072) { await reader.cancel(); return new Response(null, { status: 413 }); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch { return new Response(null, { status: 400 }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['type', 'rpcId', 'method', 'payload'].includes(key))
        || body.type !== 'client-request' || body.method !== RPC_ENDPOINT
        || typeof body.rpcId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.rpcId)
        || !Object.hasOwn(body, 'payload')) return new Response(null, { status: 400 });
      try {
        request.signal.throwIfAborted();
        const value = await host.dispatch(body.payload, request.signal);
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } },
          { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      } catch { return new Response(null, { status: 500, headers: { 'cache-control': 'no-store' } }); }
    }
  }));
  ctx.effect(() => { void host.boot(); return () => host.dispose(); });
}
