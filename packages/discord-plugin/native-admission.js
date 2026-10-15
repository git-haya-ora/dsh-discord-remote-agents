// INTERNAL DESIGN only: pure receipt/recovery decisions, not a DSH API or scheduler.
// Callers must durably CAS these decisions before acting. This module performs no
// I/O, native submit, proof verification, reservation release, or automatic replay.
import { types } from 'node:util';
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= 4096 && !/\p{Cc}/u.test(value);
// Reject proxies before reflection: traps could synthesize changing descriptors.
// Never invoke getters; all subsequent checks/copies use own-data snapshots only.
function snapshot(value) {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
      Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
    }
    return Object.freeze(copy);
  } catch { return null; }
}
const exact = (value, keys) => value !== null && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const utc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sameRun = (left, right) => left.backendIdentity === right.backendIdentity && left.nativeSessionId === right.nativeSessionId && left.nativeRunIdOrEquivalent === right.nativeRunIdOrEquivalent;
function context(value) {
  const copy = snapshot(value);
  if (!exact(copy, ['backendIdentity', 'nativeSessionId', 'clientRequestId', 'payloadDigest']) || !Object.values(copy).every(text)) throw new Error('INVALID_ADMISSION_CONTEXT');
  return copy;
}
function run(value, expected) {
  const copy = snapshot(value);
  return exact(copy, ['backendIdentity', 'nativeSessionId', 'nativeRunIdOrEquivalent']) && Object.values(copy).every(text)
    && copy.backendIdentity === expected.backendIdentity && copy.nativeSessionId === expected.nativeSessionId ? copy : null;
}
function receiptFor(expected, value) {
  const candidate = snapshot(value);
  if (!exact(candidate, ['clientRequestId', 'payloadDigest', 'run', 'acceptedAt', 'admissionRevision', 'durable'])
    || candidate.clientRequestId !== expected.clientRequestId || candidate.payloadDigest !== expected.payloadDigest
    || candidate.durable !== true || !text(candidate.admissionRevision) || !utc(candidate.acceptedAt)) return null;
  const pinnedRun = run(candidate.run, expected);
  if (!pinnedRun) return null;
  return Object.freeze({ clientRequestId: candidate.clientRequestId, payloadDigest: candidate.payloadDigest,
    run: Object.freeze({ ...pinnedRun }), acceptedAt: candidate.acceptedAt, admissionRevision: candidate.admissionRevision, durable: true });
}
/** Structural validation is not authenticity: upstream contract/provenance is mandatory. */
export function validateAdmissionReceipt(expected, candidate) {
  return receiptFor(context(expected), candidate);
}
const decision = (state, receipt, reason) => Object.freeze({ state, receipt, reason, blocksSession: state !== 'queued' && state !== 'failed', replayAllowed: false });
/** Only for a durably recorded dispatching attempt and a trusted admission response. */
export function decideAdmissionResponse(expected, response) {
  const pinned = context(expected), reply = snapshot(response);
  if (exact(reply, ['kind', 'receipt']) && (reply.kind === 'accepted' || reply.kind === 'duplicate')) {
    const receipt = receiptFor(pinned, reply.receipt);
    return receipt ? decision('accepted', receipt, 'DURABLE_RECEIPT') : decision('unknown', null, 'INVALID_RECEIPT');
  }
  if (exact(reply, ['kind', 'activeRun', 'accepted']) && reply.kind === 'busy' && reply.accepted === false && run(reply.activeRun, pinned)) return decision('queued', null, 'NATIVE_BUSY');
  if (exact(reply, ['kind', 'code', 'accepted']) && reply.kind === 'rejected' && reply.accepted === false && text(reply.code)) return decision('failed', null, 'NATIVE_REJECTED');
  return decision('unknown', null, 'ADMISSION_UNCONFIRMED');
}
/** Lookup is not resubmission. A fence string alone cannot prove non-acceptance. */
export function reconcileAdmissionLookup(expected, previousReceipt, lookup) {
  const pinned = context(expected);
  const previous = previousReceipt === null ? null : receiptFor(pinned, previousReceipt);
  if (previousReceipt !== null && previous === null) throw new Error('INVALID_PREVIOUS_RECEIPT');
  const reply = snapshot(lookup);
  if (exact(reply, ['kind', 'receipt']) && reply.kind === 'accepted') {
    const receipt = receiptFor(pinned, reply.receipt);
    if (receipt && (!previous || (sameRun(previous.run, receipt.run) && previous.acceptedAt === receipt.acceptedAt && previous.admissionRevision === receipt.admissionRevision))) return decision('accepted', receipt, 'RECEIPT_RESTORED');
    return decision('unknown', previous, 'RECEIPT_CONFLICT');
  }
  if (reply && reply.kind === 'not-accepted') return decision('unknown', previous, 'NON_ACCEPTANCE_PROOF_UNVERIFIED');
  return decision('unknown', previous, 'LOOKUP_UNCONFIRMED');
}
