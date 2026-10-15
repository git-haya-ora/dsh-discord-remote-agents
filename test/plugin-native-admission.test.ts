// Mock-only INTERNAL DESIGN tests: not native admission/AC-35/36 acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
const { validateAdmissionReceipt: validate, decideAdmissionResponse: decide, reconcileAdmissionLookup: reconcile } = await import(new URL('../../packages/discord-plugin/native-admission.js', import.meta.url).href) as typeof import('../packages/discord-plugin/native-admission.js');
const expected = { backendIdentity: 'backend', nativeSessionId: 'session', clientRequestId: 'request', payloadDigest: 'digest' };
const receipt = { clientRequestId: 'request', payloadDigest: 'digest', run: { backendIdentity: 'backend', nativeSessionId: 'session', nativeRunIdOrEquivalent: 'run' }, acceptedAt: '2026-10-13T09:00:00.000Z', admissionRevision: 'revision', durable: true as const };
test('mock receipt pins exact native identity without implying running or replay', () => {
  for (const kind of ['accepted', 'duplicate']) {
    const result = decide(expected, { kind, receipt });
    assert.equal(result.state, 'accepted'); assert.equal(result.blocksSession, true); assert.equal(result.replayAllowed, false);
    assert.deepEqual(result.receipt, receipt); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.receipt?.run));
  }
  const copy = structuredClone(receipt); const validated = validate(expected, copy)!;
  copy.run.nativeRunIdOrEquivalent = 'changed'; assert.equal(validated.run.nativeRunIdOrEquivalent, 'run');
});
test('mock validation rejects mismatched identities, unknown fields, unsafe IDs and invalid dates', () => {
  const invalid = [null, { accepted: true }, { ...receipt, extra: 'private' }, { ...receipt, durable: false },
    { ...receipt, clientRequestId: 'different' }, { ...receipt, payloadDigest: 'different' },
    ...['backendIdentity', 'nativeSessionId', 'nativeRunIdOrEquivalent'].flatMap(key => [
      { ...receipt, run: { ...receipt.run, [key]: '' } }, { ...receipt, run: { ...receipt.run, [key]: ' ' } }, { ...receipt, run: { ...receipt.run, [key]: 'x\n' } }]),
    { ...receipt, run: { ...receipt.run, backendIdentity: 'other' } }, { ...receipt, run: { ...receipt.run, nativeSessionId: 'other' } },
    { ...receipt, run: { ...receipt.run, extra: true } }, { ...receipt, admissionRevision: '' },
    ...['not-a-date', '2026-02-30T09:00:00.000Z', '2026-10-13T09:00:00.000+00:00'].map(acceptedAt => ({ ...receipt, acceptedAt }))];
  for (const value of invalid) { assert.equal(validate(expected, value), null); assert.equal(decide(expected, { kind: 'accepted', receipt: value }).state, 'unknown'); }
});
test('mock busy preserves queued intent; only exact definitive rejection fails', () => {
  assert.equal(decide(expected, { kind: 'busy', activeRun: receipt.run, accepted: false }).state, 'queued');
  assert.equal(decide(expected, { kind: 'rejected', code: 'REQUEST_ID_CONFLICT', accepted: false }).state, 'failed');
  for (const reply of [undefined, { accepted: true }, { kind: 'busy', activeRun: receipt.run, accepted: true }, { kind: 'busy', activeRun: { ...receipt.run, nativeSessionId: 'other' }, accepted: false }, { kind: 'rejected', code: 'private', accepted: false, extra: true }]) {
    const result = decide(expected, reply); assert.equal(result.state, 'unknown'); assert.equal(result.blocksSession, true); assert.equal(result.replayAllowed, false);
  }
});
test('mock recovery restores only the identical receipt and preserves pinned receipt on conflict', () => {
  assert.equal(reconcile(expected, null, { kind: 'accepted', receipt }).state, 'accepted');
  assert.equal(reconcile(expected, receipt, { kind: 'accepted', receipt }).state, 'accepted');
  for (const conflicting of [{ ...receipt, run: { ...receipt.run, nativeRunIdOrEquivalent: 'new' } }, { ...receipt, admissionRevision: 'new' }, { ...receipt, acceptedAt: '2026-10-13T09:00:01.000Z' }]) {
    const result = reconcile(expected, receipt, { kind: 'accepted', receipt: conflicting }); assert.equal(result.state, 'unknown'); assert.deepEqual(result.receipt, receipt);
  }
});
test('mock unknown, missing and forged non-acceptance evidence never releases session', () => {
  for (const lookup of [null, { kind: 'unknown', reason: 'private' }, { kind: 'not-accepted', fencedRevision: 'r', proof: 'synthetic-private-proof' }, { kind: 'not-accepted', verified: true }, { kind: 'accepted', receipt: { ...receipt, payloadDigest: 'other' } }]) {
    const result = reconcile(expected, receipt, lookup); assert.equal(result.state, 'unknown'); assert.equal(result.blocksSession, true); assert.equal(result.replayAllowed, false); assert.deepEqual(result.receipt, receipt);
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});
test('mock descriptors reject dynamic accessors, proxies, hidden and symbol fields without invoking getters', () => {
  let calls = 0;
  const getter = () => { calls++; return calls === 1 ? 'request' : 'foreign'; };
  const accessorReceipt = { ...receipt, get clientRequestId() { return getter(); } };
  const accessorRun = { ...receipt.run, get backendIdentity() { calls++; return 'backend'; } };
  const accessorReply = { kind: 'accepted', get receipt() { calls++; return receipt; } };
  const busy = { kind: 'busy', accepted: false, activeRun: accessorRun };
  const hidden = Object.defineProperty({ ...receipt }, 'extra', { value: true });
  const symbolic = { ...receipt, [Symbol('extra')]: true };
  const proxy = new Proxy(receipt, { getOwnPropertyDescriptor() { calls++; throw new Error('private'); } });
  for (const candidate of [accessorReceipt, { ...receipt, run: accessorRun }, hidden, symbolic, proxy]) {
    assert.equal(validate(expected, candidate), null);
    assert.equal(decide(expected, { kind: 'accepted', receipt: candidate }).state, 'unknown');
    assert.equal(reconcile(expected, receipt, { kind: 'accepted', receipt: candidate }).state, 'unknown');
  }
  assert.equal(decide(expected, accessorReply).state, 'unknown'); assert.equal(decide(expected, busy).state, 'unknown');
  const accessorContext = { ...expected, get clientRequestId() { return getter(); } };
  for (const badContext of [accessorContext, new Proxy(expected, {})]) {
    assert.throws(() => validate(badContext, receipt), /^Error: INVALID_ADMISSION_CONTEXT$/);
    assert.throws(() => decide(badContext, {}), /^Error: INVALID_ADMISSION_CONTEXT$/);
    assert.throws(() => reconcile(badContext, receipt, {}), /^Error: INVALID_ADMISSION_CONTEXT$/);
  }
  assert.throws(() => reconcile(expected, accessorReceipt, {}), /^Error: INVALID_PREVIOUS_RECEIPT$/);
  assert.equal(calls, 0);
  for (const control of ['\u007f', '\u0080', '\u009f']) assert.equal(validate(expected, { ...receipt, admissionRevision: `r${control}x` }), null);
});
test('mock unreadable replies sanitize errors and corrupt local context fails closed', () => {
  const unreadable = new Proxy({}, { ownKeys() { throw new Error('synthetic-private-error'); } });
  assert.equal(decide(expected, unreadable).state, 'unknown'); assert.equal(reconcile(expected, receipt, unreadable).state, 'unknown');
  assert.equal(validate(expected, unreadable), null);
  assert.throws(() => decide({ ...expected, nativeSessionId: '' }, {}), /^Error: INVALID_ADMISSION_CONTEXT$/);
  assert.throws(() => reconcile(expected, { ...receipt, clientRequestId: 'other' }, {}), /^Error: INVALID_PREVIOUS_RECEIPT$/);
});
