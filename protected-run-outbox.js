// INTERNAL DESIGN Host-only local integration. No Native, network, Client, auth
// grants, claim/send methods, cleanup or capability activation. Fresh profile only.
import { types } from 'node:util';
import { describePayload } from './protected-payloads.js';
import { RunOutboxJournalError } from './run-outbox-journal.js';
const promptFields = ['backendIdentity','nativeSessionId','agentId','transport','botId','inputId','guildId','channelId','threadId','actorId','bindingId','bindingVersion','workspaceAlias'];
const inputFields = [...promptFields,'payloadDigest','receiverGeneration','leaseEpoch'];
const eventFields = ['backendIdentity','nativeSessionId','clientRequestId','payloadDigest','nativeRunIdOrEquivalent','eventId','revision','checkpoint','occurredAt','state'];
const notificationFields = ['backendIdentity','nativeSessionId','agentId','runId','clientRequestId','nativeRunIdOrEquivalent','promptDigest','eventId','revision','checkpoint','occurredAt','state','transport','botId','guildId','channelId','threadId','ownerId','bindingId','bindingVersion','workspaceAlias'];
const fenceFields = ['botId','generation','leaseEpoch','settingsRevision'];
const hex = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.isWellFormed() && value.trim() === value && !/\p{Cc}/u.test(value);
export class ProtectedRunOutboxError extends Error {
  constructor(code) { super(code); this.name = 'ProtectedRunOutboxError'; this.code = code; }
}
const fail = code => { throw new ProtectedRunOutboxError(code); };
function own(value, fields) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('PROTECTED_RUN_INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors), copy = {};
  if (keys.length !== fields.length || !fields.every(field => keys.includes(field))) fail('PROTECTED_RUN_INVALID_INPUT');
  for (const field of fields) {
    const d = descriptors[field];
    if (!d.enumerable || !Object.hasOwn(d,'value')) fail('PROTECTED_RUN_INVALID_INPUT');
    copy[field] = d.value;
  }
  return Object.freeze(copy);
}
const pick = (value, fields) => Object.freeze(Object.fromEntries(fields.map(field => [field,value[field]])));
function description(payload) { try { return describePayload(payload); } catch { fail('PROTECTED_RUN_INVALID_INPUT'); } }
function fenceSnapshot(value) {
  const f = own(value,fenceFields);
  if (!id(f.botId) || !['generation','leaseEpoch','settingsRevision'].every(field => integer(f[field]))) fail('PROTECTED_RUN_INVALID_INPUT');
  return f;
}
const sameFence = (a,b) => a !== null && b !== null && fenceFields.every(field => a[field] === b[field]);
function notificationContext(run,event) {
  const m = run.metadata;
  return Object.freeze({ backendIdentity:m.backendIdentity,nativeSessionId:m.nativeSessionId,agentId:m.agentId,runId:run.id,clientRequestId:run.clientRequestId,nativeRunIdOrEquivalent:event.nativeRunIdOrEquivalent,
    promptDigest:m.protectedPayloadDigest,eventId:event.eventId,revision:event.revision,checkpoint:event.checkpoint,occurredAt:event.occurredAt,state:event.state,
    transport:m.transport,botId:m.botId,guildId:m.guildId,channelId:m.channelId,threadId:m.threadId,ownerId:m.actorId,bindingId:m.bindingId,bindingVersion:m.bindingVersion,workspaceAlias:m.workspaceAlias });
}
function correlates(run,event) {
  return run.receipt !== null && event.backendIdentity === run.metadata.backendIdentity && event.nativeSessionId === run.metadata.nativeSessionId
    && event.clientRequestId === run.clientRequestId && event.payloadDigest === run.metadata.payloadDigest
    && event.nativeRunIdOrEquivalent === run.receipt.run.nativeRunIdOrEquivalent;
}
function readSnapshot(value, expected) {
  try {
    const v = own(value,['schemaVersion','kind','context','text']);
    if (v.schemaVersion !== 1 || v.kind !== expected.kind) fail('PROTECTED_RUN_PAYLOAD_MISMATCH');
    const ctx = own(v.context,v.kind === 'prompt' ? promptFields : notificationFields);
    const payload = Object.freeze({schemaVersion:1,kind:v.kind,context:ctx,text:v.text});
    const d = describePayload({kind:payload.kind,context:ctx,text:payload.text});
    if (d.digest !== expected.digest || JSON.stringify(ctx) !== JSON.stringify(expected.context)) fail('PROTECTED_RUN_PAYLOAD_MISMATCH');
    return {payload,description:d};
  } catch { fail('PROTECTED_RUN_PAYLOAD_MISMATCH'); }
}
/** Dependencies are trusted Host instances; injected test doubles are not authority
 * or durability proofs. Caller must establish Native digest/event provenance and
 * authorize pinned scope; local checks neither authenticate nor submit anything. */
export class ProtectedRunOutbox {
  #journal; #store;
  constructor(journal,store) { this.#journal=journal; this.#store=store; }
  #db(action) { try { return action(); } catch(error) { if(error instanceof RunOutboxJournalError) throw error; fail('PROTECTED_RUN_STORAGE_FAILURE'); } }
  async #read(ref,expected) {
    let value; try { value=await this.#store.read(ref,expected); } catch { fail('PROTECTED_RUN_PAYLOAD_FAILURE'); }
    return readSnapshot(value,expected);
  }
  async #protect(payload,d) {
    let result; try { result=await this.#store.create(payload); } catch { fail('PROTECTED_RUN_PAYLOAD_FAILURE'); }
    let descriptor;
    try {
      descriptor=own(result,['ref','kind','digest','byteLength']);
      if(!hex(descriptor.ref)||descriptor.kind!==d.kind||descriptor.digest!==d.digest||descriptor.byteLength!==d.byteLength||!integer(descriptor.byteLength)||descriptor.byteLength<1) fail('PROTECTED_RUN_PAYLOAD_MISMATCH');
    } catch { fail('PROTECTED_RUN_PAYLOAD_MISMATCH'); }
    const loaded=await this.#read(descriptor.ref,Object.freeze({kind:payload.kind,digest:d.digest,context:payload.context}));
    if(loaded.payload.text!==payload.text || loaded.description.byteLength!==d.byteLength) fail('PROTECTED_RUN_PAYLOAD_MISMATCH');
    return descriptor;
  }
  async enqueue(input,text) {
    // Every untrusted argument is detached before the first await. No input refs,
    // attachment fields, authority booleans or caller-supplied envelope fingerprint.
    const m=own(input,inputFields);
    if(!hex(m.payloadDigest)||!integer(m.receiverGeneration)||!integer(m.leaseEpoch)) fail('PROTECTED_RUN_INVALID_INPUT');
    const payload=Object.freeze({kind:'prompt',context:pick(m,promptFields),text}),d=description(payload);
    const descriptor=await this.#protect(payload,d);
    return this.#db(()=>this.#journal.enqueue(Object.freeze({...m,payloadRef:descriptor.ref,protectedPayloadDigest:d.digest})));
  }
  async commitTerminal(runId,expectedVersion,input,text) {
    if(!id(runId)||!integer(expectedVersion)) fail('PROTECTED_RUN_INVALID_INPUT');
    const event=own(input,eventFields),run=this.#db(()=>this.#journal.get(runId));
    if(!run||!correlates(run,event)) fail('PROTECTED_RUN_RECEIPT_CONFLICT');
    if(!run.terminal&&(!['accepted','unknown'].includes(run.state)||run.version!==expectedVersion)) fail('PROTECTED_RUN_FENCE_CONFLICT');
    const payload=Object.freeze({kind:'notification',context:notificationContext(run,event),text}),d=description(payload);
    const descriptor=await this.#protect(payload,d);
    // Product journal rechecks exact Native correlation/CAS/event duplicate and
    // commits terminal+Outbox atomically. Blob+SQL themselves are NOT atomic.
    return this.#db(()=>this.#journal.commitTerminal(runId,expectedVersion,Object.freeze({...event,notificationRef:descriptor.ref,notificationDigest:d.digest})));
  }
  #promptRun(runId,version) {
    const r=this.#db(()=>this.#journal.get(runId));
    if(!r||r.state!=='dispatching'||r.version!==version) fail('PROTECTED_RUN_FENCE_CONFLICT');
    return r;
  }
  async readPrompt(runId,expectedVersion) {
    if(!id(runId)||!integer(expectedVersion)) fail('PROTECTED_RUN_INVALID_INPUT');
    const before=this.#promptRun(runId,expectedVersion),m=before.metadata;
    const loaded=await this.#read(m.payloadRef,Object.freeze({kind:'prompt',digest:m.protectedPayloadDigest,context:pick(m,promptFields)}));
    const after=this.#promptRun(runId,expectedVersion);
    if(JSON.stringify(after)!==JSON.stringify(before)) fail('PROTECTED_RUN_FENCE_CONFLICT');
    return loaded.payload;
  }
  #deliveryRow(deliveryId,version,fence) {
    const row=this.#db(()=>this.#journal.getDelivery(deliveryId));
    if(!row||row.state!=='sending'||row.version!==version||!sameFence(row.fence,fence)||!sameFence(this.#db(()=>this.#journal.getLease(fence.botId)),fence)) fail('PROTECTED_RUN_FENCE_CONFLICT');
    return row;
  }
  async readDelivery(deliveryId,expectedVersion,inputFence) {
    if(!id(deliveryId)||!integer(expectedVersion)) fail('PROTECTED_RUN_INVALID_INPUT');
    const f=fenceSnapshot(inputFence),before=this.#deliveryRow(deliveryId,expectedVersion,f),run=this.#db(()=>this.#journal.get(before.metadata.runId));
    if(!run?.terminal||!correlates(run,run.terminal)) fail('PROTECTED_RUN_RECEIPT_CONFLICT');
    const loaded=await this.#read(before.metadata.payloadRef,Object.freeze({kind:'notification',digest:before.metadata.payloadDigest,context:notificationContext(run,run.terminal)}));
    const after=this.#deliveryRow(deliveryId,expectedVersion,f),afterRun=this.#db(()=>this.#journal.get(before.metadata.runId));
    if(JSON.stringify(after)!==JSON.stringify(before)||JSON.stringify(afterRun)!==JSON.stringify(run)) fail('PROTECTED_RUN_FENCE_CONFLICT');
    return loaded.payload;
  }
}
