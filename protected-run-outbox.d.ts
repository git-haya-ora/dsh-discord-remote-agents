import type { AdmissionInput } from './admission-journal.js';
import type { SQLiteRunOutboxJournal, TerminalEvent, TerminalPair, UnifiedRun } from './run-outbox-journal.js';
import type { OutboxFence } from './outbox-journal.js';
import type { WindowsProtectedPayloadStore, ProtectedPayload } from './protected-payloads.js';
/** No refs/attachments/internal fingerprint input. Caller must establish normalized
 * Native payloadDigest externally; it is NEVER replaced by envelope fingerprint. */
export type UnprotectedAdmissionInput = Omit<AdmissionInput,'payloadRef'>;
export type UnprotectedTerminalEvent = Omit<TerminalEvent,'notificationRef'|'notificationDigest'>;
export class ProtectedRunOutboxError extends Error { readonly code: string; constructor(code: string); }
/** INTERNAL DESIGN Host-only adapter, fresh discord-run-outbox-protected-journal
 * profile. Uses existing private store + ONE unified Run/Outbox database, no new
 * journal or service. Dependencies are trusted Host instances (test doubles are
 * neither auth nor durability proof). Caller must authorize/pin scope, establish
 * Native/event provenance and maintain formal receiver/lease policy externally.
 * Every mutation snapshots arguments, protects and independently re-reads/verifies
 * the body BEFORE SQL. Protection/readback failure cannot enqueue or commit a
 * terminal/Outbox through this adapter. File+SQL commits are NOT atomic; SQL
 * failure or replay may leave encrypted orphan refs. Original replay refs remain
 * pinned. No delete/retention/replay release/Native/claim/send/network/UI/RPC API.
 * Direct journal writes remain trusted internal seams, not automatically protected. */
export class ProtectedRunOutbox {
  constructor(journal: SQLiteRunOutboxJournal, store: Pick<WindowsProtectedPayloadStore,'create'|'read'>);
  enqueue(input: UnprotectedAdmissionInput, text: string): Promise<Readonly<{duplicate: boolean; run: UnifiedRun}>>;
  commitTerminal(runId: string, expectedVersion: number, event: UnprotectedTerminalEvent, text: string): Promise<TerminalPair>;
  /** Caller already claimed and reauthorized. Only dispatching at exact version;
   * rechecks state/version/full snapshot after asynchronous blob read. Unknown,
   * accepted, queued and terminal reads never grant a resend. Failure holds state. */
  readPrompt(runId: string, expectedVersion: number): Promise<Readonly<ProtectedPayload>>;
  /** Caller already claimed and reauthorized pinned owner/destination. Only sending
   * at exact version with row AND current lease matching fence, before/after read.
   * Local tuple is NOT formal lease/auth proof. No held-state release or actual send. */
  readDelivery(deliveryId: string, expectedVersion: number, fence: OutboxFence): Promise<Readonly<ProtectedPayload>>;
}
