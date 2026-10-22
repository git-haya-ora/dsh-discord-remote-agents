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
export interface BridgeOutputContext {
  readonly profile: 'local-bridge-output-v1'; readonly transport: 'discord'; readonly applicationId: string; readonly botId: string;
  readonly nativeSessionId: string; readonly bridgeRunId: string; readonly clientRequestId: string; readonly promptDigest: string;
  readonly observedTurn: number|null; readonly bridgeStartSeq: number; readonly lastObservedSeq: number;
  readonly completionSource: 'native-turn'|'bridge-rejection'; readonly terminalState: 'succeeded'|'failed'|'interrupted';
  readonly ownerId: string; readonly guildId: string; readonly channelId: string; readonly threadId: null;
  readonly bindingMode: 'actor'|'shared'; readonly bindingId: string; readonly bindingVersion: number; readonly destination: 'dm'|'origin';
  readonly preRedactionDigest: string|null; readonly redactedBodyDigest: string; readonly deliveryPlanDigest: string;
  readonly itemKind: 'body'|'part'; readonly itemIndex: number; readonly itemCount: number; readonly itemDigest: string;
}
export type ProtectedPayloadInput =
  | Readonly<{kind: 'prompt'; context: PromptPayloadContext; text: string}>
  | Readonly<{kind: 'notification'; context: NotificationPayloadContext; text: string}>
  | Readonly<{kind: 'bridge-output'; context: BridgeOutputContext; text: string}>;
export type ProtectedPayload = ProtectedPayloadInput & Readonly<{schemaVersion: 1}>;
export interface PayloadDescription {
  readonly kind: 'prompt'|'notification'|'bridge-output'; readonly digest: string; readonly byteLength: number;
}
export interface PayloadEstimate extends PayloadDescription { readonly cipherBytes: number; }
export interface ProtectedPayloadDescriptor extends PayloadDescription { readonly ref: string; }
export type ExpectedPayload =
  | Readonly<{kind: 'prompt'; digest: string; context: PromptPayloadContext}>
  | Readonly<{kind: 'notification'; digest: string; context: NotificationPayloadContext}>
  | Readonly<{kind: 'bridge-output'; digest: string; context: BridgeOutputContext}>;
export class ProtectedPayloadError extends Error { readonly code: string; constructor(code?: string); }
/** Fixed field-order JSON/UTF8 digest includes schema, kind, context and exact text.
 * Pure metadata only, not evidence of persistence. 20,000 Unicode scalars, 80,000
 * UTF8 body bytes, 96KiB canonical envelope; preserves newlines/no normalization.
 * Identity rules match local journal; malformed Unicode/control characters reject.
 * Generation/lease are intentionally excluded from content identity. */
export function describePayload(input: ProtectedPayloadInput): Readonly<PayloadDescription>;
/** Host-only private payload root (never a secret/journal root). Bridge output is
 * a local profile, not a Native receipt/provenance contract. Caller must authorize,
 * pin scope, persist unpredictable refs/reservations, and verify readback before its
 * SQLite publish transaction; file and SQL writes are NOT atomic. Windows gate
 * checks logging, SID/system ACL, ancestors, reparse and hardlinks; no fallback. */
export class WindowsProtectedPayloadStore {
  constructor(root: string);
  create(input: ProtectedPayloadInput): Promise<Readonly<ProtectedPayloadDescriptor>>;
  estimate(inputs: readonly ProtectedPayloadInput[]): Promise<readonly PayloadEstimate[]>;
  createWithRef(ref: string, input: ProtectedPayloadInput, reservedBytes: number): Promise<void>;
  createManyWithRefs(inputs: readonly Readonly<{ref: string; input: ProtectedPayloadInput; reserveBytes: number}>[]): Promise<void>;
  readMany(inputs: readonly Readonly<{ref: string; expected: ExpectedPayload}>[]): Promise<readonly Readonly<ProtectedPayload>[]>;
  stats(): Promise<Readonly<{bytes: number; files: readonly Readonly<{ref: string; bytes: number}>[]}>>;
  /** Deletes supplied opaque exact refs only; never scans/deletes orphans. */
  delete(ref: string): Promise<void>;
  deleteMany(refs: readonly string[]): Promise<readonly Readonly<{ref: string; deleted: boolean; bytes: number}>[]>;
  /** Host-only plaintext after fatal UTF8 decode, canonical encoding, digest, kind
   * and exact pinned context verification; never expose through a Client service. */
  read(ref: string, expected: ExpectedPayload): Promise<Readonly<ProtectedPayload>>;
}
