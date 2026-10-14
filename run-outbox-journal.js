// INTERNAL DESIGN only. Reviewed state machine snapshots; no runtime old-store dependency or migration.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {lstat,mkdir,readdir,open} from 'node:fs/promises';
import {isAbsolute,join,dirname,parse} from 'node:path';
import {prepareRunOutboxJournalRoot,ProtectedStoreError} from './windows-secrets.js';
import {decideAdmissionResponse,reconcileAdmissionLookup,validateAdmissionReceipt} from './native-admission.js';
export class RunOutboxJournalError extends Error {constructor(code){super(code);this.name='RunOutboxJournalError';this.code=code;}}
const fail=code=>{throw new RunOutboxJournalError(code);};
const token=Symbol('construction');
const files=/^run-outbox-(journal|guard)\.sqlite(-journal)?$/;
const admissionCore=(()=>{
const active = "state IN ('dispatching','accepted','unknown')";
const schema = [
  "CREATE TABLE admission_schema (identity TEXT PRIMARY KEY, version INTEGER NOT NULL)",
  "CREATE TABLE admission_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE, input_key TEXT NOT NULL UNIQUE, backend TEXT NOT NULL, session TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','dispatching','accepted','failed','unknown','completed','cancelled')), version INTEGER NOT NULL CHECK(version>=0), metadata TEXT NOT NULL, receipt TEXT, terminal TEXT)",
  `CREATE UNIQUE INDEX admission_active ON admission_runs(backend,session) WHERE ${active}`
];
const fail = code => { throw new RunOutboxJournalError(code); };
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/\p{Cc}/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fields = ['backendIdentity', 'nativeSessionId', 'agentId', 'transport', 'botId', 'inputId', 'payloadDigest', 'protectedPayloadDigest', 'payloadRef', 'guildId', 'channelId', 'threadId', 'actorId', 'bindingId', 'bindingVersion', 'workspaceAlias', 'receiverGeneration', 'leaseEpoch'];
function metadata(value) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('RUN_OUTBOX_INVALID_INPUT');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || !fields.every(field => keys.includes(field))) fail('RUN_OUTBOX_INVALID_INPUT');
    const copy = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('RUN_OUTBOX_INVALID_INPUT');
      copy[field] = descriptor.value;
    }
    if (copy.transport !== 'discord' || !hex(copy.payloadRef) || !hex(copy.payloadDigest) || !hex(copy.protectedPayloadDigest)
      || !['bindingVersion', 'receiverGeneration', 'leaseEpoch'].every(field => integer(copy[field]))
      || (copy.threadId !== null && !id(copy.threadId))
      || !fields.filter(field => !['bindingVersion', 'receiverGeneration', 'leaseEpoch', 'threadId'].includes(field)).every(field => id(copy[field]))) fail('RUN_OUTBOX_INVALID_INPUT');
    return Object.freeze(copy);
  } catch { fail('RUN_OUTBOX_INVALID_INPUT'); }
}
function context(row) { return { backendIdentity: row.metadata.backendIdentity, nativeSessionId: row.metadata.nativeSessionId, clientRequestId: row.clientRequestId, payloadDigest: row.metadata.payloadDigest }; }

class Core{
 #db;#owner;#closed=false;
 constructor(db,owner){this.#db=db;this.#owner=owner;}
 #transaction(action){return this.#owner.transaction(action);}
  #decode(row) {
    if (!row) return null;
    try {
      const pinned = metadata(JSON.parse(row.metadata));
      if (!id(row.id) || !id(row.request_id) || !integer(row.version) || !integer(row.sequence) || row.sequence < 1
        || row.backend !== pinned.backendIdentity || row.session !== pinned.nativeSessionId
        || row.input_key !== JSON.stringify([pinned.transport, pinned.botId, pinned.inputId])) fail('RUN_OUTBOX_DATA_INVALID');
      const value = { id: row.id, clientRequestId: row.request_id, sequence: row.sequence, version: row.version, state: row.state, metadata: pinned, receipt: null, terminal: row.terminal === null ? null : terminalEvent(JSON.parse(row.terminal)) };
      if (row.receipt !== null) { value.receipt = validateAdmissionReceipt(context(value), JSON.parse(row.receipt)); if (!value.receipt) fail('RUN_OUTBOX_DATA_INVALID'); }
      if (!['queued', 'dispatching', 'accepted', 'failed', 'unknown','completed','cancelled'].includes(value.state) || (value.state === 'accepted' && !value.receipt) || (['queued', 'dispatching','failed'].includes(value.state) && !value.terminal && value.receipt)) fail('RUN_OUTBOX_DATA_INVALID');
      if ((value.state === 'queued' && value.version % 2 !== 0)
        || (value.state === 'dispatching' && (value.version < 1 || value.version % 2 !== 1))
        || (value.state === 'failed' && !value.terminal && (value.version < 2 || value.version % 2 !== 0))
        || (['accepted', 'unknown'].includes(value.state) && value.version < 2)) fail('RUN_OUTBOX_DATA_INVALID');
      return Object.freeze(value);
    } catch { fail('RUN_OUTBOX_DATA_INVALID'); }
  }
  get(runId) {
    if (!id(runId)) fail('RUN_OUTBOX_INVALID_INPUT');
    if (this.#closed) fail('RUN_OUTBOX_CLOSED');
    try { return this.#decode(this.#db.prepare('SELECT * FROM admission_runs WHERE id=?').get(runId)); }
    catch (error) { if (error instanceof RunOutboxJournalError) throw error; fail('RUN_OUTBOX_STORAGE_UNAVAILABLE'); }
  }
  listSession(backendIdentity, nativeSessionId) {
    if (!id(backendIdentity) || !id(nativeSessionId)) fail('RUN_OUTBOX_INVALID_INPUT');
    if (this.#closed) fail('RUN_OUTBOX_CLOSED');
    try { return Object.freeze(this.#db.prepare('SELECT * FROM admission_runs WHERE backend=? AND session=? ORDER BY sequence').all(backendIdentity, nativeSessionId).map(row => this.#decode(row))); }
    catch (error) { if (error instanceof RunOutboxJournalError) throw error; fail('RUN_OUTBOX_STORAGE_UNAVAILABLE'); }
  }
  /** Caller must authorize/capability-check/validate payload, Session and scope first. */
  enqueue(input) {
    const pinned = metadata(input), inputKey = JSON.stringify([pinned.transport, pinned.botId, pinned.inputId]);
    return this.#transaction(() => {
      const duplicate = this.#decode(this.#db.prepare('SELECT * FROM admission_runs WHERE input_key=?').get(inputKey));
      if (duplicate) {
        // Original protected ref and generation remain pinned on duplicate delivery.
        const compare = fields.filter(field => !['payloadRef', 'receiverGeneration', 'leaseEpoch'].includes(field));
        if (compare.some(field => duplicate.metadata[field] !== pinned[field])) fail('RUN_OUTBOX_INPUT_CONFLICT');
        return Object.freeze({ duplicate: true, run: duplicate });
      }
      if (this.#db.prepare("SELECT 1 FROM admission_runs WHERE backend=? AND session=? AND state='unknown'").get(pinned.backendIdentity, pinned.nativeSessionId)) fail('RUN_OUTBOX_SESSION_UNKNOWN');
      // Dispatching retains its waiting slot: a later busy cannot exceed capacity.
      const waiting = this.#db.prepare("SELECT count(*) AS count FROM admission_runs WHERE backend=? AND session=? AND state IN ('queued','dispatching')").get(pinned.backendIdentity, pinned.nativeSessionId).count;
      if (waiting >= 10) fail('RUN_OUTBOX_QUEUE_FULL');
      const counter = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name='admission_runs'").get();
      const previous = counter?.seq ?? 0;
      if (!integer(previous) || !integer(previous + 1)) fail('RUN_OUTBOX_DATA_INVALID');
      const runId = randomUUID(), requestId = randomUUID();
      this.#db.prepare("INSERT INTO admission_runs(id,request_id,input_key,backend,session,state,version,metadata,receipt) VALUES(?,?,?,?,?,'queued',0,?,NULL)").run(runId, requestId, inputKey, pinned.backendIdentity, pinned.nativeSessionId, JSON.stringify(pinned));
      return Object.freeze({ duplicate: false, run: this.get(runId) });
    });
  }
  #current(runId, expectedVersion, state) {
    if (!integer(expectedVersion)) fail('RUN_OUTBOX_INVALID_INPUT');
    const row = this.get(runId);
    if (!row || row.version !== expectedVersion || row.state !== state) fail('RUN_OUTBOX_CAS_CONFLICT');
    return row;
  }
  #update(row, state, receipt) {
    if (row.version >= Number.MAX_SAFE_INTEGER - 2) fail('RUN_OUTBOX_DATA_INVALID');
    const changed = this.#db.prepare('UPDATE admission_runs SET state=?,receipt=?,version=version+1 WHERE id=? AND version=? AND state=?').run(state, receipt === null ? null : JSON.stringify(receipt), row.id, row.version, row.state).changes;
    if (changed !== 1) fail('RUN_OUTBOX_CAS_CONFLICT');
    return this.get(row.id);
  }
  /** Revalidate authorization, generation/lease, Binding continuation, Agent,
   * Workspace, Session and attachments externally immediately before claim.
   * Successful return is committed dispatching; no external submit is performed. */
  claim(runId, expectedVersion, agentConcurrencyLimit = 1) {
    // Formal current Agent configuration must supply this budget; it grants no authority.
    if (!integer(agentConcurrencyLimit) || agentConcurrencyLimit < 1) fail('RUN_OUTBOX_INVALID_INPUT');
    return this.#transaction(() => {
      const row = this.#current(runId, expectedVersion, 'queued');
      // Claim must reserve the additional response/recovery version increment.
      if (row.version >= Number.MAX_SAFE_INTEGER - 3) fail('RUN_OUTBOX_DATA_INVALID');
      if (this.#db.prepare(`SELECT 1 FROM admission_runs WHERE backend=? AND session=? AND ${active}`).get(row.metadata.backendIdentity, row.metadata.nativeSessionId)) fail('RUN_OUTBOX_SESSION_BLOCKED');
      const head = this.#db.prepare("SELECT id FROM admission_runs WHERE backend=? AND session=? AND state='queued' ORDER BY sequence LIMIT 1").get(row.metadata.backendIdentity, row.metadata.nativeSessionId);
      if (head.id !== row.id) fail('RUN_OUTBOX_NOT_FIFO_HEAD');
      // One decoder is authoritative even for persisted duplicate JSON keys.
      // Agent-wide local Bridge budget spans backend identities, unlike Session guard.
      const occupied = this.#db.prepare(`SELECT * FROM admission_runs WHERE ${active}`).all()
        .map(candidate => this.#decode(candidate))
        .filter(candidate => candidate.metadata.agentId === row.metadata.agentId).length;
      if (occupied >= agentConcurrencyLimit) fail('RUN_OUTBOX_AGENT_CAPACITY');
      return this.#update(row, 'dispatching', null);
    });
  }
  /** Trusted provenance required; structural validation does not authenticate DSH. */
  applyResponse(runId, expectedVersion, response) {
    return this.#transaction(() => { const row = this.#current(runId, expectedVersion, 'dispatching'); const result = decideAdmissionResponse(context(row), response); return this.#update(row, result.state, result.receipt); });
  }
  markUnknown(runId, expectedVersion) {
    return this.#transaction(() => {
      const row = this.get(runId);
      if (!row || !integer(expectedVersion) || row.version !== expectedVersion || !['dispatching', 'accepted'].includes(row.state)) fail('RUN_OUTBOX_CAS_CONFLICT');
      return this.#update(row, 'unknown', row.receipt);
    });
  }
  reconcileLookup(runId, expectedVersion, lookup) {
    return this.#transaction(() => { const row = this.#current(runId, expectedVersion, 'unknown'); const result = reconcileAdmissionLookup(context(row), row.receipt, lookup); return this.#update(row, result.state, result.receipt); });
  }

}
return {Core,schema,metadata,context};
})();
const deliveryCore=(()=>{
const integer = n => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER - 1;
const id = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && s.trim() === s && !/\p{Cc}/u.test(s);
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/u.test(s);
const time = n => integer(n) && n <= 8640000000000000;
const fail = code => { throw new RunOutboxJournalError(code); };
function own(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail('RUN_OUTBOX_INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || !fields.every(field => keys.includes(field))) fail('RUN_OUTBOX_INVALID_INPUT');
  const copy = {};
  for (const field of fields) {
    const d = descriptors[field];
    if (!d.enumerable || !Object.hasOwn(d, 'value')) fail('RUN_OUTBOX_INVALID_INPUT');
    copy[field] = d.value;
  }
  return copy;
}
const metadataFields = ['transport','botId','guildId','channelId','threadId','logicalEventKey','runId','ownerId','bindingId','bindingVersion','workspaceAlias','payloadRef','payloadDigest'];
function metadata(value) {
  try {
    const copy = own(value, metadataFields);
    if (copy.transport !== 'discord' || !hex(copy.payloadRef) || !hex(copy.payloadDigest) || !integer(copy.bindingVersion)
      || (copy.threadId !== null && !id(copy.threadId))
      || !metadataFields.filter(f => !['threadId','bindingVersion'].includes(f)).every(f => id(copy[f]))) fail('RUN_OUTBOX_INVALID_INPUT');
    return Object.freeze(copy);
  } catch { fail('RUN_OUTBOX_INVALID_INPUT'); }
}
function fence(value) {
  try {
    const copy = own(value, ['botId','generation','leaseEpoch','settingsRevision']);
    if (!id(copy.botId) || !['generation','leaseEpoch','settingsRevision'].every(f => integer(copy[f]))) fail('RUN_OUTBOX_INVALID_INPUT');
    return Object.freeze(copy);
  } catch { fail('RUN_OUTBOX_INVALID_INPUT'); }
}
const sameFence = (a,b) => a !== null && b !== null && ['botId','generation','leaseEpoch','settingsRevision'].every(f => a[f] === b[f]);
const eventKey = m => JSON.stringify([m.transport,m.botId,m.guildId,m.channelId,m.threadId ?? '',m.logicalEventKey]);
const schema = [
  'CREATE TABLE outbox_schema (identity TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  "CREATE TABLE outbox_rows (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, event_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','retry_wait','blocked','delivery_unknown','dead_letter')), version INTEGER NOT NULL, metadata TEXT NOT NULL, fence TEXT, failures INTEGER NOT NULL, next_at INTEGER, message_id TEXT, reason TEXT)",
  'CREATE TABLE outbox_leases (bot TEXT PRIMARY KEY, snapshot TEXT NOT NULL)'
];

class Core{
 #db;#owner;#closed=false;
 constructor(db,owner){this.#db=db;this.#owner=owner;}
 #transaction(action){return this.#owner.transaction(action);}
  #decode(stored) {
    if (!stored) return null;
    try {
      const m = metadata(JSON.parse(stored.metadata)), f = stored.fence === null ? null : fence(JSON.parse(stored.fence));
      const states = ['pending','sending','sent','retry_wait','blocked','delivery_unknown','dead_letter'];
      if (!id(stored.id) || !integer(stored.sequence) || stored.sequence < 1 || !integer(stored.version) || stored.event_key !== eventKey(m)
        || !states.includes(stored.state) || !integer(stored.failures) || stored.failures > 10 || (f && f.botId !== m.botId)
        || (stored.state === 'pending' ? f !== null : f === null)
        || (stored.state === 'sent' ? !id(stored.message_id) : stored.message_id !== null)
        || (stored.state === 'retry_wait' ? !time(stored.next_at) || stored.failures < 1 || stored.failures >= 10 : stored.next_at !== null)
        || (stored.state === 'dead_letter' && stored.failures !== 10)
        || (stored.reason !== null && !['HTTP_401','HTTP_403','HTTP_404','RATE_LIMIT','SERVER_FAILURE','AMBIGUOUS','INTERRUPTED','LEASE_CHANGED'].includes(stored.reason))) fail('RUN_OUTBOX_DATA_INVALID');
      const reasons = {
        pending: [null], sending: [null], sent: [null],
        retry_wait: ['RATE_LIMIT','SERVER_FAILURE'], blocked: ['HTTP_401','HTTP_403','HTTP_404'],
        delivery_unknown: ['AMBIGUOUS','INTERRUPTED','LEASE_CHANGED'], dead_letter: ['RATE_LIMIT','SERVER_FAILURE']
      };
      if (!reasons[stored.state].includes(stored.reason)
        || (stored.state === 'pending' && stored.version !== 0)
        || (stored.state !== 'pending' && stored.version < 1)
        || (['retry_wait','dead_letter'].includes(stored.state) && stored.version !== 2 * stored.failures)
        || (stored.state === 'sending' && stored.version !== 2 * stored.failures + 1)
        || (['blocked','delivery_unknown'].includes(stored.state) && stored.version !== 2 * stored.failures + 2)
        || (stored.state === 'sent' && (stored.version < 2 || stored.version > 20 || stored.version % 2 !== 0))
        || (['pending','sent'].includes(stored.state) && stored.failures !== 0)
        || (stored.state !== 'dead_letter' && stored.failures >= 10)) fail('RUN_OUTBOX_DATA_INVALID');
      return Object.freeze({id:stored.id,sequence:stored.sequence,version:stored.version,state:stored.state,metadata:m,fence:f,failures:stored.failures,nextAt:stored.next_at,messageId:stored.message_id,reason:stored.reason});
    } catch { fail('RUN_OUTBOX_DATA_INVALID'); }
  }
  get(rowId) {
    if (!id(rowId)) fail('RUN_OUTBOX_INVALID_INPUT');
    if (this.#closed) fail('RUN_OUTBOX_CLOSED');
    try { return this.#decode(this.#db.prepare('SELECT * FROM outbox_rows WHERE id=?').get(rowId)); }
    catch (e) { if (e instanceof RunOutboxJournalError) throw e; fail('RUN_OUTBOX_STORAGE_UNAVAILABLE'); }
  }
  #lease(botId) {
    const row = this.#db.prepare('SELECT * FROM outbox_leases WHERE bot=?').get(botId);
    if (!row) return null;
    try { const f = fence(JSON.parse(row.snapshot)); if (f.botId !== botId) fail('RUN_OUTBOX_DATA_INVALID'); return f; } catch { fail('RUN_OUTBOX_DATA_INVALID'); }
  }
  getLease(botId) {
    if (!id(botId)) fail('RUN_OUTBOX_INVALID_INPUT'); if (this.#closed) fail('RUN_OUTBOX_CLOSED');
    try { return this.#lease(botId); } catch (e) { if (e instanceof RunOutboxJournalError) throw e; fail('RUN_OUTBOX_STORAGE_UNAVAILABLE'); }
  }
  advanceLease(expected,next) {
    const before = expected === null ? null : fence(expected), after = fence(next);
    if (before && (before.botId !== after.botId || after.generation < before.generation || after.leaseEpoch <= before.leaseEpoch || after.settingsRevision < before.settingsRevision)) fail('RUN_OUTBOX_INVALID_INPUT');
    return this.#transaction(() => {
      const current = this.#lease(after.botId);
      if (before === null ? current !== null : !sameFence(before,current)) fail('RUN_OUTBOX_FENCE_CONFLICT');
      for (const stored of this.#db.prepare("SELECT * FROM outbox_rows WHERE state='sending'").all()) {
        const row = this.#decode(stored);
        if (row.metadata.botId === after.botId) this.#update(row,'delivery_unknown',row.fence,row.failures,null,null,'LEASE_CHANGED');
      }
      this.#db.prepare('INSERT INTO outbox_leases(bot,snapshot) VALUES(?,?) ON CONFLICT(bot) DO UPDATE SET snapshot=excluded.snapshot').run(after.botId,JSON.stringify(after));
      return after;
    });
  }
  enqueue(value) {
    const m = metadata(value), dedupe = eventKey(m);
    return this.#transaction(() => {
      const existing = this.#decode(this.#db.prepare('SELECT * FROM outbox_rows WHERE event_key=?').get(dedupe));
      if (existing) { if (metadataFields.some(f => existing.metadata[f] !== m[f])) fail('RUN_OUTBOX_EVENT_CONFLICT'); return Object.freeze({duplicate:true,row:existing}); }
      const previous = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name='outbox_rows'").get()?.seq ?? 0;
      if (!integer(previous) || !integer(previous+1)) fail('RUN_OUTBOX_DATA_INVALID');
      const rowId = randomUUID();
      this.#db.prepare("INSERT INTO outbox_rows(id,event_key,state,version,metadata,fence,failures,next_at,message_id,reason) VALUES(?,?,'pending',0,?,NULL,0,NULL,NULL,NULL)").run(rowId,dedupe,JSON.stringify(m));
      return Object.freeze({duplicate:false,row:this.get(rowId)});
    });
  }
  #current(rowId,version) { if (!integer(version)) fail('RUN_OUTBOX_INVALID_INPUT'); const row = this.get(rowId); if (!row || row.version !== version) fail('RUN_OUTBOX_CAS_CONFLICT'); return row; }
  #checkFence(f) { if (!sameFence(f,this.#lease(f.botId))) fail('RUN_OUTBOX_FENCE_CONFLICT'); }
  #update(row,state,f,failures,nextAt,messageId,reason) {
    if (row.version >= Number.MAX_SAFE_INTEGER-2) fail('RUN_OUTBOX_DATA_INVALID');
    const result = this.#db.prepare('UPDATE outbox_rows SET state=?,fence=?,failures=?,next_at=?,message_id=?,reason=?,version=version+1 WHERE id=? AND version=? AND state=?').run(state,f === null ? null : JSON.stringify(f),failures,nextAt,messageId,reason,row.id,row.version,row.state);
    if (result.changes !== 1) fail('RUN_OUTBOX_CAS_CONFLICT'); return this.get(row.id);
  }
  claim(rowId,version,lease,now) {
    const f = fence(lease); if (!time(now)) fail('RUN_OUTBOX_INVALID_INPUT');
    return this.#transaction(() => {
      this.#checkFence(f); const row = this.#current(rowId,version);
      if (row.metadata.botId !== f.botId) fail('RUN_OUTBOX_FENCE_CONFLICT');
      if (!['pending','retry_wait'].includes(row.state)) fail('RUN_OUTBOX_CAS_CONFLICT');
      // Reserve claim AND settlement/recovery increments before publishing sending.
      if (row.version >= Number.MAX_SAFE_INTEGER-3) fail('RUN_OUTBOX_DATA_INVALID');
      if (row.state === 'retry_wait' && now < row.nextAt) fail('RUN_OUTBOX_NOT_DUE');
      return this.#update(row,'sending',f,row.failures,null,null,null);
    });
  }
  applyResult(rowId,version,lease,result,now,jitter = 0) {
    const f = fence(lease); if (!time(now) || typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) fail('RUN_OUTBOX_INVALID_INPUT');
    return this.#transaction(() => {
      this.#checkFence(f); const row = this.#current(rowId,version);
      if (row.state !== 'sending' || !sameFence(row.fence,f)) fail('RUN_OUTBOX_CAS_CONFLICT');
      let state = 'delivery_unknown', failures = row.failures, nextAt = null, messageId = null, reason = 'AMBIGUOUS';
      try {
        if (!result || typeof result !== 'object' || types.isProxy(result)) throw new Error();
        const kind = Object.getOwnPropertyDescriptor(result,'kind');
        if (!kind || !Object.hasOwn(kind,'value')) throw new Error();
        if (kind.value === 'sent') { const r = own(result,['kind','messageId']); if (!id(r.messageId)) throw new Error(); state='sent';messageId=r.messageId;failures=0;reason=null; }
        else if (kind.value === 'http') {
          const status = Object.getOwnPropertyDescriptor(result,'status'); if (!status || !Object.hasOwn(status,'value')) throw new Error();
          const r = own(result,status.value === 429 ? ['kind','status','retryAfterMs'] : ['kind','status']);
          if ([401,403,404].includes(r.status)) { state='blocked';reason=`HTTP_${r.status}`; }
          else if (r.status === 429 || (Number.isInteger(r.status) && r.status >=500 && r.status<=599)) {
            const delay = r.status === 429 ? r.retryAfterMs : Math.min(60000,Math.floor(1000*2**Math.min(row.failures,6)*(1+jitter)));
            if (!integer(delay) || delay < 1 || !time(now+delay)) throw new Error();
            failures = Math.min(10,row.failures+1); reason=r.status===429?'RATE_LIMIT':'SERVER_FAILURE';
            state=failures===10?'dead_letter':'retry_wait';nextAt=state==='retry_wait'?now+delay:null;
          }
        }
      } catch { /* Unauthenticated/malformed/ambiguous data cannot authorize replay. */ }
      return this.#update(row,state,f,failures,nextAt,messageId,reason);
    });
  }

}
return {Core,schema,metadata,own,fence,sameFence,eventKey};
})();
function inspectSchema(db, definitions, schemaIdentity) {
  const objects = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (db.prepare('PRAGMA application_id').get().application_id !== 0) fail('RUN_OUTBOX_SCHEMA_INCOMPATIBLE');
  if (!objects.length && version === 0) {
    // A schema-free SQLite header can still belong to another application.
    if (db.prepare('PRAGMA page_count').get().page_count !== 0) fail('RUN_OUTBOX_SCHEMA_INCOMPATIBLE');
    return false;
  }
  const expected = definitions.map(sql => ({ name: sql.match(/^CREATE (?:UNIQUE INDEX|TABLE) (\w+)/u)[1], sql })).sort((a, b) => a.name.localeCompare(b.name));
  if (version !== 1 || objects.length !== expected.length || expected.some((item, index) => item.name !== objects[index].name || item.sql !== objects[index].sql)) fail('RUN_OUTBOX_SCHEMA_INCOMPATIBLE');
  if (schemaIdentity) {
    const rows = db.prepare('SELECT identity,version FROM run_outbox_schema').all();
    if (rows.length !== 1 || rows[0].identity !== schemaIdentity || rows[0].version !== 1) fail('RUN_OUTBOX_SCHEMA_INCOMPATIBLE');
  }
  return true;
}
const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<Number.MAX_SAFE_INTEGER-1;
const id=s=>typeof s==='string'&&s.length>0&&s.length<=256&&s.trim()===s&&!/\p{Cc}/u.test(s);
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/u.test(s);
const eventFields=['backendIdentity','nativeSessionId','clientRequestId','payloadDigest','nativeRunIdOrEquivalent','eventId','revision','checkpoint','occurredAt','state','notificationRef','notificationDigest'];
/** Proven event/checkpoint and protected blob validity are external preconditions.
 * Revision/checkpoint are opaque exact identities, NEVER sorted or treated as feed cursors. */
function terminalEvent(input){try{const e=deliveryCore.own(input,eventFields);
  if(!['completed','failed','cancelled'].includes(e.state)||!hex(e.payloadDigest)||!hex(e.notificationRef)||!hex(e.notificationDigest)
    ||!eventFields.filter(f=>!['state','payloadDigest','notificationRef','notificationDigest'].includes(f)).every(f=>id(e[f]))
    ||new Date(e.occurredAt).toISOString()!==e.occurredAt)fail('RUN_OUTBOX_INVALID_INPUT');return Object.freeze(e);
}catch{fail('RUN_OUTBOX_INVALID_INPUT');}}
const scope=e=>JSON.stringify([e.backendIdentity,e.nativeSessionId,e.eventId]);
const correlates=(r,e)=>r.receipt!==null&&e.backendIdentity===r.metadata.backendIdentity&&e.nativeSessionId===r.metadata.nativeSessionId&&e.clientRequestId===r.clientRequestId&&e.payloadDigest===r.metadata.payloadDigest&&e.nativeRunIdOrEquivalent===r.receipt.run.nativeRunIdOrEquivalent;
function notification(r,e){const m=r.metadata;return deliveryCore.metadata({transport:m.transport,botId:m.botId,guildId:m.guildId,channelId:m.channelId,threadId:m.threadId,logicalEventKey:`terminal:${r.id}`,runId:r.id,ownerId:m.actorId,bindingId:m.bindingId,bindingVersion:m.bindingVersion,workspaceAlias:m.workspaceAlias,payloadRef:e.notificationRef,payloadDigest:e.notificationDigest});}
const schema=['CREATE TABLE run_outbox_schema (identity TEXT PRIMARY KEY, version INTEGER NOT NULL)',...admissionCore.schema.slice(1),...deliveryCore.schema.slice(1),'CREATE TABLE terminal_events (scope TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, delivery_id TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL)'];
const guardSchema=['CREATE TABLE run_outbox_writer (id INTEGER PRIMARY KEY CHECK(id=1))'];
// Breaking INTERNAL metadata format: fresh profile only; reject the previous
// discord-run-outbox-journal identity before any mutating PRAGMA/DML. No migration.
const identity='discord-run-outbox-protected-journal';
/** One local data database; guard is ONLY a lifetime writer lock, NOT RFC-A.
 * No Native/network/payload APIs, authority booleans, ATTACH or legacy migration.
 * Pre-admission failed is distinct from Native terminal failed: its notification remains open. */
export class SQLiteRunOutboxJournal{
 #db;#guard;#admission;#delivery;#durable;#closed=false;#inside=false;
 static memoryForTests(){return new SQLiteRunOutboxJournal(token,null);}
 static async open(root){let j;try{
   await secureRoot(root);for(const n of ['run-outbox-journal.sqlite','run-outbox-guard.sqlite']){try{const f=await open(join(root,n),'wx',0o600);await f.close();}catch(e){if(e.code!=='EEXIST')throw e;}}
   await secureRoot(root);j=new SQLiteRunOutboxJournal(token,root);await secureRoot(root);return j;
 }catch(e){try{j?.close();}catch{}if(e instanceof RunOutboxJournalError)throw e;if(e instanceof ProtectedStoreError)fail(['INVALID_SECRET_PATH','PROTECTED_STORE_UNSAFE_PATH'].includes(e.code)?'RUN_OUTBOX_PRIVATE_PATH_UNSAFE':'RUN_OUTBOX_PRIVATE_STORAGE_UNAVAILABLE');fail('RUN_OUTBOX_STORAGE_UNAVAILABLE');}}
 constructor(key,root){if(key!==token)fail('RUN_OUTBOX_STORAGE_UNAVAILABLE');this.#durable=root!==null;try{
   this.#guard=new DatabaseSync(root===null?':memory:':join(root,'run-outbox-guard.sqlite'));const g=inspectSchema(this.#guard,guardSchema,null);
   this.#db=new DatabaseSync(root===null?':memory:':join(root,'run-outbox-journal.sqlite'));const exists=inspectSchema(this.#db,schema,identity);
   const owner={transaction:action=>this.#transaction(action)};this.#admission=new admissionCore.Core(this.#db,owner);this.#delivery=new deliveryCore.Core(this.#db,owner);
   if(exists)this.#assert(); // read-only cross-table refusal before format/DML mutations
   this.#guard.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');if(!g){this.#guard.exec(guardSchema[0]);this.#guard.exec('PRAGMA user_version=1;');}
   try{this.#guard.exec('BEGIN IMMEDIATE');}catch{fail('RUN_OUTBOX_WRITER_BUSY');}
   this.#db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
   if(!exists)this.#transaction(()=>{for(const sql of schema)this.#db.exec(sql);this.#db.prepare('INSERT INTO run_outbox_schema VALUES (?,1)').run(identity);this.#db.exec('PRAGMA user_version=1;');});
   this.#transaction(()=>{this.#db.exec("UPDATE admission_runs SET state='unknown',version=version+1 WHERE state='dispatching'; UPDATE outbox_rows SET state='delivery_unknown',reason='INTERRUPTED',version=version+1 WHERE state='sending'");this.#assert();});
 }catch(e){try{this.#db?.close();}catch{}try{this.#guard?.close();}catch{}if(e instanceof RunOutboxJournalError)throw e;fail('RUN_OUTBOX_STORAGE_UNAVAILABLE');}}
 get durable(){return this.#durable;}
 #check(){if(this.#closed)fail('RUN_OUTBOX_CLOSED');}
 #transaction(action){this.#check();if(this.#inside)return action();try{this.#db.exec('BEGIN IMMEDIATE');this.#inside=true;const v=action();this.#db.exec('COMMIT');return v;}catch(e){try{this.#db.exec('ROLLBACK');}catch{}if(e instanceof RunOutboxJournalError)throw e;fail('RUN_OUTBOX_STORAGE_UNAVAILABLE');}finally{this.#inside=false;}}
 #assert(){this.#check();try{
   const runs=this.#db.prepare('SELECT id FROM admission_runs').all().map(v=>this.#admission.get(v.id));
   const rows=this.#db.prepare('SELECT id FROM outbox_rows').all().map(v=>this.#delivery.get(v.id));
   const events=this.#db.prepare('SELECT * FROM terminal_events').all();const leases=new Map(),eventRuns=new Map(),deliveryRuns=new Map();
   for(const e of events){if(eventRuns.has(e.run_id))fail('RUN_OUTBOX_DATA_INVALID');eventRuns.set(e.run_id,e);}
   for(const d of rows){if(deliveryRuns.has(d.metadata.runId))fail('RUN_OUTBOX_DATA_INVALID');deliveryRuns.set(d.metadata.runId,d);}
   for(const v of this.#db.prepare('SELECT * FROM outbox_leases').all()){const f=deliveryCore.fence(JSON.parse(v.snapshot));if(f.botId!==v.bot)fail('RUN_OUTBOX_DATA_INVALID');leases.set(v.bot,f);}
   for(const r of runs){if(r.state==='dispatching'&&r.version>=Number.MAX_SAFE_INTEGER-2)fail('RUN_OUTBOX_DATA_INVALID');
     if(r.terminal){const e=r.terminal;if(!correlates(r,e)||r.state!==e.state||r.version<3)fail('RUN_OUTBOX_DATA_INVALID');
       const t=eventRuns.get(r.id),d=deliveryRuns.get(r.id);
       if(!t||t.scope!==scope(e)||t.snapshot!==JSON.stringify(e)||!d||d.id!==t.delivery_id||JSON.stringify(d.metadata)!==JSON.stringify(notification(r,e)))fail('RUN_OUTBOX_DATA_INVALID');
     }else if(['completed','cancelled'].includes(r.state))fail('RUN_OUTBOX_DATA_INVALID');}
   const n=runs.filter(r=>r.terminal!==null).length;if(rows.length!==n||events.length!==n)fail('RUN_OUTBOX_DATA_INVALID');
   for(const r of rows){const f=leases.get(r.metadata.botId)??null;if(r.fence&&(!f||r.fence.generation>f.generation||r.fence.leaseEpoch>f.leaseEpoch||r.fence.settingsRevision>f.settingsRevision))fail('RUN_OUTBOX_DATA_INVALID');if(r.state==='sending'&&(r.version>=Number.MAX_SAFE_INTEGER-2||!deliveryCore.sameFence(r.fence,f)))fail('RUN_OUTBOX_DATA_INVALID');}
   if(this.#db.prepare("SELECT 1 FROM admission_runs WHERE state IN ('queued','dispatching') GROUP BY backend,session HAVING count(*)>10").get()||this.#db.prepare("SELECT 1 FROM admission_runs WHERE state IN ('dispatching','accepted','unknown') GROUP BY backend,session HAVING count(*)>1").get())fail('RUN_OUTBOX_DATA_INVALID');
   const counters=this.#db.prepare('SELECT name,seq FROM sqlite_sequence').all();if(counters.length>2||new Set(counters.map(c=>c.name)).size!==counters.length||counters.some(c=>!['admission_runs','outbox_rows'].includes(c.name)||!integer(c.seq)))fail('RUN_OUTBOX_DATA_INVALID');
   for(const name of ['admission_runs','outbox_rows']){const max=this.#db.prepare(`SELECT coalesce(max(sequence),0) AS maximum FROM ${name}`).get().maximum,c=counters.find(v=>v.name===name);if(max>0&&(!c||c.seq<max))fail('RUN_OUTBOX_DATA_INVALID');}
 }catch{fail('RUN_OUTBOX_DATA_INVALID');}}
 #read(action){this.#check();try{this.#assert();return action();}catch(e){if(e instanceof RunOutboxJournalError)throw e;fail('RUN_OUTBOX_STORAGE_UNAVAILABLE');}}
 #write(action){return this.#transaction(()=>{this.#assert();const v=action();this.#assert();return v;});}
 get(id){return this.#read(()=>this.#admission.get(id));}
 listSession(backend,session){return this.#read(()=>this.#admission.listSession(backend,session));}
 enqueue(m){return this.#write(()=>this.#admission.enqueue(m));}
 claim(id,v,limit=1){return this.#write(()=>this.#admission.claim(id,v,limit));}
 applyResponse(id,v,r){return this.#write(()=>this.#admission.applyResponse(id,v,r));}
 markUnknown(id,v){return this.#write(()=>this.#admission.markUnknown(id,v));}
 reconcileLookup(id,v,l){return this.#write(()=>this.#admission.reconcileLookup(id,v,l));}
 /** Trusted authoritative event intake. Blob must already exist and be validated externally.
  * Current sender eligibility is separate; ACL withdrawal does not discard terminal truth.
  * Native event+notification digest duplicate returns same pair even with stale CAS.
  * A recreated random notificationRef never replaces the original pinned ref; producer
  * owns unused blob cleanup (compare returned ref). Checkpoint is event-local. */
 commitTerminal(runId,expectedVersion,input){if(!id(runId)||!integer(expectedVersion))fail('RUN_OUTBOX_INVALID_INPUT');const e=terminalEvent(input);return this.#write(()=>{
   const old=this.#db.prepare('SELECT * FROM terminal_events WHERE scope=?').get(scope(e));if(old){const archived=terminalEvent(JSON.parse(old.snapshot));if(old.run_id!==runId||eventFields.filter(f=>f!=='notificationRef').some(f=>archived[f]!==e[f]))fail('RUN_OUTBOX_EVENT_CONFLICT');return Object.freeze({duplicate:true,run:this.#admission.get(runId),delivery:this.#delivery.get(old.delivery_id)});}
   const r=this.#admission.get(runId);if(!r||r.terminal||!['accepted','unknown'].includes(r.state)||r.version!==expectedVersion)fail('RUN_OUTBOX_CAS_CONFLICT');if(!correlates(r,e))fail('RUN_OUTBOX_RECEIPT_CONFLICT');if(r.version>=Number.MAX_SAFE_INTEGER-2)fail('RUN_OUTBOX_DATA_INVALID');
   // UPDATE, notification INSERT and scoped dedupe/checkpoint INSERT share ONE COMMIT.
   const changed=this.#db.prepare('UPDATE admission_runs SET state=?,terminal=?,version=version+1 WHERE id=? AND version=? AND state=?').run(e.state,JSON.stringify(e),r.id,r.version,r.state).changes;if(changed!==1)fail('RUN_OUTBOX_CAS_CONFLICT');
   const delivery=this.#delivery.enqueue(notification(r,e)).row;this.#db.prepare('INSERT INTO terminal_events(scope,run_id,delivery_id,snapshot) VALUES(?,?,?,?)').run(scope(e),r.id,delivery.id,JSON.stringify(e));return Object.freeze({duplicate:false,run:this.#admission.get(r.id),delivery});
 });}
 getDelivery(id){return this.#read(()=>this.#delivery.get(id));}
 getLease(bot){return this.#read(()=>this.#delivery.getLease(bot));}
 advanceLease(before,after){return this.#write(()=>this.#delivery.advanceLease(before,after));}
 /** Caller must reauthorize pinned owner/destination and validate blob/lease BEFORE claim/send. */
 claimDelivery(id,v,f,now){return this.#write(()=>this.#delivery.claim(id,v,f,now));}
 applyDeliveryResult(id,v,f,r,now,jitter=0){return this.#write(()=>this.#delivery.applyResult(id,v,f,r,now,jitter));}
 close(){if(this.#closed)return;this.#closed=true;let bad=false;try{this.#db.close();}catch{bad=true;}try{this.#guard.close();}catch{bad=true;}if(bad)fail('RUN_OUTBOX_STORAGE_UNAVAILABLE');}
}
async function secureRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root || root.includes('\0') || root.split(/[\\/]/).some(part => part === '.' || part === '..')) fail('RUN_OUTBOX_PRIVATE_PATH_UNSAFE');
  if (process.platform === 'win32') {
    await prepareRunOutboxJournalRoot(root);
    for (const name of await readdir(root)) {
      if (!files.test(name)) fail('RUN_OUTBOX_PRIVATE_PATH_UNSAFE');
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('RUN_OUTBOX_PRIVATE_PATH_UNSAFE');
    }
    return;
  }
  let cursor = dirname(root);
  while (true) {
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) && !(stat.mode & 0o1000 && stat.uid === 0)) fail('RUN_OUTBOX_PRIVATE_PATH_UNSAFE');
    if (cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
  }
  await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  for (const path of [root, ...(await readdir(root)).map(name => { if (!files.test(name)) fail('RUN_OUTBOX_PRIVATE_PATH_UNSAFE'); return join(root, name); })]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || (path === root ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('RUN_OUTBOX_PRIVATE_PATH_UNSAFE');
  }
}
