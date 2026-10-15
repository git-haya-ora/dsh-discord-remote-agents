/** INTERNAL DESIGN caller-supplied pinned snapshots, not authorization or SDK
 * provenance. No attachment keys are accepted: text-only primitive, not complete
 * SubmitInput/notification/artifact support. Scalars are exact, well-formed Unicode. */
export interface PromptPayloadContext {
  readonly backendIdentity: string; readonly nativeSessionId: string; readonly agentId: string;
  readonly transport: 'discord'; readonly botId: string; readonly inputId: string;
  readonly guildId: string; readonly channelId: string; readonly threadId: string|null;
  readonly actorId: string; readonly bindingId: string; readonly bindingVersion: number;
  readonly workspaceAlias: string;
}
export interface NotificationPayloadContext {
  readonly backendIdentity: string; readonly nativeSessionId: string; readonly agentId: string;
  readonly runId: string; readonly clientRequestId: string; readonly nativeRunIdOrEquivalent: string;
  /** Internal original prompt fingerprint, NOT a formal Native/RFC-A digest. */
  readonly promptDigest: string;
  readonly eventId: string; readonly revision: string; readonly checkpoint: string;
  readonly occurredAt: string; readonly state: 'completed'|'failed'|'cancelled';
  readonly transport: 'discord'; readonly botId: string; readonly guildId: string;
  readonly channelId: string; readonly threadId: string|null; readonly ownerId: string;
  readonly bindingId: string; readonly bindingVersion: number; readonly workspaceAlias: string;
}
export type ProtectedPayloadInput =
  | Readonly<{kind: 'prompt'; context: PromptPayloadContext; text: string}>
  | Readonly<{kind: 'notification'; context: NotificationPayloadContext; text: string}>;
export type ProtectedPayload = ProtectedPayloadInput & Readonly<{schemaVersion: 1}>;
export interface PayloadDescription {
  readonly kind: 'prompt'|'notification'; readonly digest: string; readonly byteLength: number;
}
export interface ProtectedPayloadDescriptor extends PayloadDescription { readonly ref: string; }
export type ExpectedPayload =
  | Readonly<{kind: 'prompt'; digest: string; context: PromptPayloadContext}>
  | Readonly<{kind: 'notification'; digest: string; context: NotificationPayloadContext}>;
export class ProtectedPayloadError extends Error { readonly code: string; constructor(code?: string); }
/** Fixed field-order JSON/UTF8 digest includes schema, kind, context and exact text.
 * Pure metadata only, not evidence of persistence. 20,000 Unicode scalars, 80,000
 * UTF8 body bytes, 96KiB canonical envelope; preserves newlines/no normalization.
 * Identity rules match local journal; malformed Unicode/control characters reject.
 * Generation/lease are intentionally excluded from content identity. */
export function describePayload(input: ProtectedPayloadInput): Readonly<PayloadDescription>;
/** Host-only, fresh dedicated private payload root (never a secret/journal root).
 * Different filename and DPAPI entropy namespace; mixed roots fail closed. The
 * old trusted token provider can still misconfigure/contaminate this root; this is
 * not a symmetric same-SID sandbox. No UI/RPC/plaintext DB/logs/fallback/delete.
 * Caller must authorize, pin scope and create+validate before SQL; separate file
 * and SQL writes are NOT atomic. Orphan cleanup/7day retention/referenced unknown
 * preservation/attachments/runtime integration remain external and unimplemented.
 * Windows gate checks logging, SID/system ACL, ancestors, reparse and hardlinks;
 * no platform/fixture fallback. At most this store's own helper may be terminated. */
export class WindowsProtectedPayloadStore {
  constructor(root: string);
  create(input: ProtectedPayloadInput): Promise<Readonly<ProtectedPayloadDescriptor>>;
  /** Host-only plaintext after fatal UTF8 decode, canonical encoding, digest, kind
   * and exact pinned context verification; never expose through a Client service. */
  read(ref: string, expected: ExpectedPayload): Promise<Readonly<ProtectedPayload>>;
}
