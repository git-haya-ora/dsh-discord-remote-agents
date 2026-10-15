# Discord component-action guard (isolated building block)

[The `discord-components.js` module](<../packages/discord-plugin/discord-components.js>) issues short, opaque, one-time identifiers for a proposed Discord button/select-menu action. The package exports this module, but it is not wired into the Host foundation, Discord receiver, or DSH API. A passing unit test is not DI-02 acceptance and does not establish a live Discord/DSH workflow.

## Contract

- `ComponentActionGuard` requires an `authorize(grant, currentInteractionScope)` callback. The receiver must create `currentInteractionScope` from trusted Discord interaction fields (user, guild, channel, and thread), not from the component payload or saved button fields. The callback must fetch current server-side policy, Binding, and target state again; the immutable grant is only an old snapshot, not proof that authorization/state is still current. A DSH GUI cookie or browser session is not owner/admin proof.
- `issue(scope, action)` must only be called after ordinary application authorization. Scope pins actor ID, guild/channel/thread IDs, nullable Binding (agent ID, native session ID, Binding version), and target kind/ID/version. Comparison is exact; a scope mismatch does not consume the grant.
- The generated `custom_id` is 58 ASCII characters (`d1.<192-bit random nonce>.<truncated HMAC-SHA-256>`), below Discord's 100-character limit. It contains no user, guild, channel, Binding, target, or action value. The HMAC key is generated in memory per guard instance.
- Grants expire after 5 minutes by default; callers may choose 1 second–15 minutes. The in-memory store is capped at 4,096 outstanding grants. Simultaneous consumes reserve the grant synchronously before awaiting authorization. Authorization denial/errors burn it; explicit revocation and expiration also defeat in-flight authorization checks. `revokeAll()` and `dispose()` invalidate outstanding grants.

## Limits and required integration checks

This is process-memory state only. Restart loses all outstanding grants and generates a different HMAC key; it is not a durable approval ledger, recovery journal, or replay-safe cross-process token. Integrators must invalidate/refresh old Discord components after restart and must persist real approvals separately if required by the spec.

Successful `consume()` is only a short-lived authorization gate. It does **not** make a later Binding/target mutation, DSH action, or native request atomic. The actual operation must re-check versions and authorization in its own mutation/dispatch boundary, verify current receiver generation/native capability, then perform the side effect once. A DB transaction or native protocol is outside this package. This module does not solve Desktop-vs-Discord acceptance races, run-specific cancellation, approval reconciliation, owner/admin management authorization, or trusted Peer provenance.

No component is registered with Discord and no UI is rendered; the package export only makes the isolated module distributable. Do not mark DI-02 or approval/cancel acceptance complete from these isolated tests.

## Supported extension boundary

Use supported Host/Client extension patterns with effect-owned cleanup and declared manifest exports. Source inspection and isolated tests do not prove Plugin Manager activation, GUI rendering, owner/admin authority or trusted Peer provenance. Never import installed-application internals at runtime.
