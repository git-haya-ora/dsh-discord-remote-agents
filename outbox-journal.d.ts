/** INTERNAL DESIGN snapshots, not authentication or supported receiver lease proofs. */
export interface OutboxMetadata {
  readonly transport: 'discord'; readonly botId: string; readonly guildId: string; readonly channelId: string; readonly threadId: string | null;
  readonly logicalEventKey: string; readonly runId: string; readonly ownerId: string; readonly bindingId: string; readonly bindingVersion: number;
  readonly workspaceAlias: string; readonly payloadRef: string; readonly payloadDigest: string;
}
export interface OutboxFence { readonly botId: string; readonly generation: number; readonly leaseEpoch: number; readonly settingsRevision: number; }
export interface OutboxRow {
  readonly id: string; readonly sequence: number; readonly version: number;
  readonly state: 'pending'|'sending'|'sent'|'retry_wait'|'blocked'|'delivery_unknown'|'dead_letter';
  readonly metadata: OutboxMetadata; readonly fence: OutboxFence | null; readonly failures: number;
  readonly nextAt: number | null; readonly messageId: string | null; readonly reason: string | null;
}
export class OutboxJournalError extends Error { readonly code: string; constructor(code: string); }
/** Dedicated metadata DB, NOT atomic with Run terminal; no payload, network or Native calls.
 * Caller must verify canonical Bot, formal settings revision/lease, current pinned-owner
 * ACL/scope and protected payload provenance before enqueue/lease/each claim. This local
 * fence cannot cancel a remote HTTP commit or arbitrate independent processes/DBs.
 * Unknown/blocked/dead_letter are held: no retry release absent formal reconcile/admin
 * proof contract. Generic network/timeout/malformed outcomes remain delivery_unknown.
 * Trusted definite-negative HTTP 5xx only: caller must verify API response provenance
 * and no successful remote commit; ambiguous 5xx must be passed as unknown instead.
 * Pre-send network retry contract, terminal atomicity, retention, GUI diagnostics,
 * nonce/history reconciliation and live API authorization remain unimplemented. */
export class SQLiteOutboxJournal {
  private constructor();
  static open(root: string): Promise<SQLiteOutboxJournal>;
  static memoryForTests(): SQLiteOutboxJournal;
  readonly durable: boolean;
  get(rowId: string): OutboxRow | null;
  getLease(botId: string): OutboxFence | null;
  /** Full previous-fence CAS; change requires epoch increase, generation/settings nondecrease. */
  advanceLease(expected: OutboxFence | null, next: OutboxFence): OutboxFence;
  enqueue(metadata: OutboxMetadata): Readonly<{duplicate: boolean; row: OutboxRow}>;
  /** now is validated UTC epoch milliseconds; caller reauthorizes original pinned scope. */
  claim(rowId: string, expectedVersion: number, lease: OutboxFence, now: number): OutboxRow;
  /** Own-data structural results only; no auth boolean. nextAt committed once.
   * 429 exact positive retryAfterMs, uncapped; 5xx bounded 1–60s with jitter in [0,1].
   * Each valid retryable failure counts; tenth => dead_letter; 401/403/404 => blocked. */
  applyResult(rowId: string, expectedVersion: number, lease: OutboxFence, result: unknown, now: number, jitter?: number): OutboxRow;
  close(): void;
}
