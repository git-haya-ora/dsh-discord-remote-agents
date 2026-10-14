import type { AdmissionReceipt } from './native-admission.js';
/** INTERNAL DESIGN metadata only. Scope/generation snapshots are NOT authorization. */
export interface AdmissionInput {
  readonly backendIdentity: string; readonly nativeSessionId: string; readonly agentId: string;
  readonly transport: 'discord'; readonly botId: string; readonly inputId: string;
  readonly payloadDigest: string; readonly payloadRef: string;
  readonly guildId: string; readonly channelId: string; readonly threadId: string | null;
  readonly actorId: string; readonly bindingId: string; readonly bindingVersion: number;
  readonly workspaceAlias: string; readonly receiverGeneration: number; readonly leaseEpoch: number;
}
export interface AdmissionRun {
  readonly id: string; readonly clientRequestId: string; readonly sequence: number; readonly version: number;
  readonly state: 'queued' | 'dispatching' | 'accepted' | 'failed' | 'unknown';
  readonly metadata: AdmissionInput; readonly receipt: AdmissionReceipt | null;
}
export class AdmissionJournalError extends Error { readonly code: string; constructor(code: string); }
/** No Native/Host integration. Dedicated private local root, lifetime writer ownership.
 * Caller must check authorization/capabilities/Session/Workspace/Agent/attachments
 * before enqueue and recheck generation/lease/Binding continuation before claim.
 * queued+dispatching reserve <=10 waiting slots; accepted is NOT running.
 * No terminal release, cleanup, protected-payload loading or automatic replay. */
export class SQLiteAdmissionJournal {
  private constructor();
  static open(root: string): Promise<SQLiteAdmissionJournal>;
  /** Explicit nondurable SQLite logic fixture only. */
  static memoryForTests(): SQLiteAdmissionJournal;
  readonly durable: boolean;
  enqueue(input: AdmissionInput): Readonly<{ duplicate: boolean; run: AdmissionRun }>;
  get(runId: string): AdmissionRun | null;
  listSession(backendIdentity: string, nativeSessionId: string): readonly AdmissionRun[];
  /** Local Agent-wide budget across backends; dispatching/accepted/unknown occupy.
   * Default 1; positive safe integer in the journal's supported integer range.
   * Caller supplies canonical registered agentId and current formally validated
   * Agent configuration. No alias resolution, settings-revision CAS, authorization
   * proof or Native/shared-process capacity contract; stale higher limits are unsafe.
   * Lowering the limit retains existing states and rejects excess new claims. */
  claim(runId: string, expectedVersion: number, agentConcurrencyLimit?: number): AdmissionRun;
  /** Trusted response provenance mandatory; only dispatching CAS allowed. */
  applyResponse(runId: string, expectedVersion: number, response: unknown): AdmissionRun;
  markUnknown(runId: string, expectedVersion: number): AdmissionRun;
  /** Lookup only unknown; proof strings never authorize requeue. */
  reconcileLookup(runId: string, expectedVersion: number, lookup: unknown): AdmissionRun;
  close(): void;
}
