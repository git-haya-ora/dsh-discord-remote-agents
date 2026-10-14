/** INTERNAL DESIGN. No upstream authenticity/atomicity/durability claim. */
export interface AdmissionContext {
  readonly backendIdentity: string;
  readonly nativeSessionId: string;
  readonly clientRequestId: string;
  readonly payloadDigest: string;
}
export interface StableRunRef {
  readonly backendIdentity: string;
  readonly nativeSessionId: string;
  readonly nativeRunIdOrEquivalent: string;
}
export interface AdmissionReceipt {
  readonly clientRequestId: string;
  readonly payloadDigest: string;
  readonly run: StableRunRef;
  readonly acceptedAt: string;
  readonly admissionRevision: string;
  readonly durable: true;
}
export interface AdmissionDecision {
  readonly state: 'accepted' | 'queued' | 'failed' | 'unknown';
  readonly receipt: AdmissionReceipt | null;
  readonly reason: 'DURABLE_RECEIPT' | 'INVALID_RECEIPT' | 'NATIVE_BUSY' | 'NATIVE_REJECTED' | 'ADMISSION_UNCONFIRMED' | 'RECEIPT_RESTORED' | 'RECEIPT_CONFLICT' | 'NON_ACCEPTANCE_PROOF_UNVERIFIED' | 'LOOKUP_UNCONFIRMED';
  readonly blocksSession: boolean;
  readonly replayAllowed: false;
}
export function validateAdmissionReceipt(expected: AdmissionContext, candidate: unknown): AdmissionReceipt | null;
/** For durably recorded dispatching only; response must have trusted provenance. */
export function decideAdmissionResponse(expected: AdmissionContext, response: unknown): AdmissionDecision;
/** For unknown admission only, never for overriding running/terminal state.
 * Non-acceptance is deliberately unsupported until a verified upstream fence contract exists. */
export function reconcileAdmissionLookup(expected: AdmissionContext, previousReceipt: AdmissionReceipt | null, lookup: unknown): AdmissionDecision;
