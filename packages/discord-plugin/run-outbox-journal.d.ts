import type { AdmissionInput } from './admission-journal.js';
import type { AdmissionReceipt } from './native-admission.js';
import type { OutboxFence, OutboxRow } from './outbox-journal.js';
/** INTERNAL DESIGN own-data snapshot, NOT an SDK event or authentication proof.
 * Caller must prove authoritative event provenance and exact receipt correlation,
 * and create+validate Host-protected notification blob BEFORE commitTerminal.
 * Protection failure means do not enter SQL; orphan cleanup remains external.
 * revision/checkpoint are opaque verified event-local correlation, NEVER sortable.
 * No shared stream cursor, gap/history recovery or event subscription integration. */
export interface TerminalEvent {
 readonly backendIdentity: string; readonly nativeSessionId: string; readonly clientRequestId: string;
 readonly payloadDigest: string; readonly nativeRunIdOrEquivalent: string;
 readonly eventId: string; readonly revision: string; readonly checkpoint: string;
 readonly occurredAt: string; readonly state: 'completed'|'failed'|'cancelled';
 readonly notificationRef: string; readonly notificationDigest: string;
}
/** Breaking INTERNAL profile discord-run-outbox-protected-journal v1. Mandatory
 * internal envelope fingerprint, distinct from externally verified Native
 * AdmissionInput.payloadDigest. Old profile rejected, no defaults/migration. */
export interface ProtectedAdmissionInput extends AdmissionInput { readonly protectedPayloadDigest: string; }
export interface UnifiedRun {
 readonly id: string; readonly clientRequestId: string; readonly sequence: number; readonly version: number;
 readonly state: 'queued'|'dispatching'|'accepted'|'failed'|'unknown'|'completed'|'cancelled';
 readonly metadata: ProtectedAdmissionInput; readonly receipt: AdmissionReceipt|null;
 /** null means pre-admission/ongoing; failed+null is NOT a Native terminal. */
 readonly terminal: TerminalEvent|null;
}
export interface TerminalPair { readonly duplicate: boolean; readonly run: UnifiedRun; readonly delivery: OutboxRow; }
export class RunOutboxJournalError extends Error { readonly code: string; constructor(code: string); }
/** New dedicated schema/private root, one local data database; no oldstore migration.
 * No Native/Host/capabilities/receiver/network/payload APIs or authority booleans.
 * Enqueue/claim require externally checked ACL, current Agent limit, Session,
 * Workspace, attachments, binding continuation, settings and RFC lease.
 * accepted != running; unknown is held, never replayed. Trusted terminal releases
 * local reservations; pre-admission rejection notification (§22.3) remains open.
 * Current owner ACL withdrawal does NOT discard terminal truth; sender must hold
 * and reauthorize before delivery. Delivery methods never resubmit Native.
 * Cross-table invariants checked on open/every public state read/write (linear scan).
 * No retention, stream cursor, GUI, supported auth/event/native contracts or live integration. */
export class SQLiteRunOutboxJournal {
 private constructor();
 static open(root: string): Promise<SQLiteRunOutboxJournal>;
 /** Explicit nondurable logic fixture, never an integration/durability escape hatch. */
 static memoryForTests(): SQLiteRunOutboxJournal;
 readonly durable: boolean;
 enqueue(input: ProtectedAdmissionInput): Readonly<{duplicate: boolean; run: UnifiedRun}>;
 get(runId: string): UnifiedRun|null;
 listSession(backendIdentity: string, nativeSessionId: string): readonly UnifiedRun[];
 claim(runId: string, expectedVersion: number, agentConcurrencyLimit?: number): UnifiedRun;
 applyResponse(runId: string, expectedVersion: number, response: unknown): UnifiedRun;
 markUnknown(runId: string, expectedVersion: number): UnifiedRun;
 reconcileLookup(runId: string, expectedVersion: number, lookup: unknown): UnifiedRun;
 /** Stable event scope backend+Native Session+eventId; terminal logical delivery key
  * derived once from local Run. Duplicate canonical event+notification digest returns
  * same pair even with stale expectedVersion; only random notificationRef is excluded
  * from equivalence. Original ref/snapshot/IDs/version remain pinned and unchanged.
  * Producer owns unused recreated blob cleanup, comparing returned delivery ref.
  * Changed digest/Native event/crossRun targeting conflicts; no rollback.
  * Native terminal snapshot, event-local checkpoint, dedupe and pinned delivery
  * commit atomically in ONE transaction. Unknown without receipt is held. */
 commitTerminal(runId: string, expectedVersion: number, event: TerminalEvent): TerminalPair;
 getDelivery(deliveryId: string): OutboxRow|null;
 getLease(botId: string): OutboxFence|null;
 advanceLease(expected: OutboxFence|null, next: OutboxFence): OutboxFence;
 /** Caller rechecks pinned owner/current ACL, destination, protected blob, settings
  * and formal lease before claim/send. Snapshot fields provide no authority. */
 claimDelivery(deliveryId: string, expectedVersion: number, fence: OutboxFence, now: number): OutboxRow;
 /** Only trusted definite-negative HTTP responses authorize retry; ambiguous data
  * remain held unknown. 429 Retry-After; bounded 5xx backoff; tenth dead-letter.
  * Future sender must supply jitter, normalize Discord 429 retry delays and control
  * SDK-level automatic attempts; none is implemented here. Proven pre-send network
  * retry remains open. This local lease cannot cancel remote HTTP commits or replace
  * Discord reconciliation. */
 applyDeliveryResult(deliveryId: string, expectedVersion: number, fence: OutboxFence, result: unknown, now: number, jitter?: number): OutboxRow;
 close(): void;
}
