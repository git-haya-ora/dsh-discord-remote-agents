// INTERNAL DESIGN: metadata-only local Outbox, never network/Native/payload access.
// Separate DB does NOT provide terminal+Outbox atomicity, authorization or a shared lease.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { lstat, mkdir, readdir, open } from 'node:fs/promises';
import { isAbsolute, join, dirname, parse } from 'node:path';
import { prepareOutboxJournalRoot, ProtectedStoreError } from './windows-secrets.js';
const key = Symbol('construction');
const integer = n => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER - 1;
const id = s => typeof s === 'string' && s.length > 0 && s.length <= 256 && s.trim() === s && !/\p{Cc}/u.test(s);
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/u.test(s);
const time = n => integer(n) && n <= 8640000000000000;
export class OutboxJournalError extends Error { constructor(code) { super(code); this.name = 'OutboxJournalError'; this.code = code; } }
const fail = code => { throw new OutboxJournalError(code); };
function own(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail('OUTBOX_INVALID_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || !fields.every(field => keys.includes(field))) fail('OUTBOX_INVALID_INPUT');
  const copy = {};
  for (const field of fields) {
    const d = descriptors[field];
    if (!d.enumerable || !Object.hasOwn(d, 'value')) fail('OUTBOX_INVALID_INPUT');
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
      || !metadataFields.filter(f => !['threadId','bindingVersion'].includes(f)).every(f => id(copy[f]))) fail('OUTBOX_INVALID_INPUT');
    return Object.freeze(copy);
  } catch { fail('OUTBOX_INVALID_INPUT'); }
}
function fence(value) {
  try {
    const copy = own(value, ['botId','generation','leaseEpoch','settingsRevision']);
    if (!id(copy.botId) || !['generation','leaseEpoch','settingsRevision'].every(f => integer(copy[f]))) fail('OUTBOX_INVALID_INPUT');
    return Object.freeze(copy);
  } catch { fail('OUTBOX_INVALID_INPUT'); }
}
const sameFence = (a,b) => a !== null && b !== null && ['botId','generation','leaseEpoch','settingsRevision'].every(f => a[f] === b[f]);
const eventKey = m => JSON.stringify([m.transport,m.botId,m.guildId,m.channelId,m.threadId ?? '',m.logicalEventKey]);
const schema = [
  'CREATE TABLE outbox_schema (identity TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  "CREATE TABLE outbox_rows (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, event_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','retry_wait','blocked','delivery_unknown','dead_letter')), version INTEGER NOT NULL, metadata TEXT NOT NULL, fence TEXT, failures INTEGER NOT NULL, next_at INTEGER, message_id TEXT, reason TEXT)",
  'CREATE TABLE outbox_leases (bot TEXT PRIMARY KEY, snapshot TEXT NOT NULL)'
];
const guardSchema = ['CREATE TABLE outbox_writer (id INTEGER PRIMARY KEY CHECK(id=1))'];
function inspect(db, definitions, identity) {
  const objects = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (db.prepare('PRAGMA application_id').get().application_id !== 0) fail('OUTBOX_SCHEMA_INCOMPATIBLE');
  if (!objects.length && version === 0) {
    if (db.prepare('PRAGMA page_count').get().page_count !== 0) fail('OUTBOX_SCHEMA_INCOMPATIBLE');
    return false;
  }
  const expected = definitions.map(sql => ({ name: sql.match(/^CREATE TABLE (\w+)/u)[1], sql })).sort((a,b) => a.name.localeCompare(b.name));
  if (version !== 1 || expected.length !== objects.length || expected.some((e,i) => e.name !== objects[i].name || e.sql !== objects[i].sql)) fail('OUTBOX_SCHEMA_INCOMPATIBLE');
  if (identity) {
    const rows = db.prepare('SELECT * FROM outbox_schema').all();
    if (rows.length !== 1 || rows[0].identity !== identity || rows[0].version !== 1) fail('OUTBOX_SCHEMA_INCOMPATIBLE');
  }
  return true;
}
async function secureRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root || root.includes('\0') || root.split(/[\\/]/).some(p => p === '.' || p === '..')) fail('OUTBOX_PRIVATE_PATH_UNSAFE');
  const files = /^outbox-(journal|guard)\.sqlite(-journal)?$/;
  if (process.platform === 'win32') {
    await prepareOutboxJournalRoot(root);
    for (const name of await readdir(root)) {
      const stat = await lstat(join(root,name));
      if (!files.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('OUTBOX_PRIVATE_PATH_UNSAFE');
    }
    return;
  }
  let cursor = dirname(root);
  while (true) {
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.mode & 0o022) && !(stat.mode & 0o1000 && stat.uid === 0))) fail('OUTBOX_PRIVATE_PATH_UNSAFE');
    if (cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
  }
  await mkdir(root,{mode:0o700}).catch(e => { if (e.code !== 'EEXIST') throw e; });
  for (const path of [root,...(await readdir(root)).map(name => { if (!files.test(name)) fail('OUTBOX_PRIVATE_PATH_UNSAFE'); return join(root,name); })]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || (path === root ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('OUTBOX_PRIVATE_PATH_UNSAFE');
  }
}
export class SQLiteOutboxJournal {
  #db; #guard; #closed = false; #durable;
  static async open(root) {
    let journal;
    try {
      await secureRoot(root);
      for (const name of ['outbox-journal.sqlite','outbox-guard.sqlite']) {
        try { const file = await open(join(root,name),'wx',0o600); await file.close(); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      await secureRoot(root);
      journal = new SQLiteOutboxJournal(key,root);
      await secureRoot(root);
      return journal;
    } catch (e) {
      try { journal?.close(); } catch { /* Preserve sanitized refusal. */ }
      if (e instanceof OutboxJournalError) throw e;
      if (e instanceof ProtectedStoreError) fail(['INVALID_SECRET_PATH','PROTECTED_STORE_UNSAFE_PATH'].includes(e.code) ? 'OUTBOX_PRIVATE_PATH_UNSAFE' : 'OUTBOX_PRIVATE_STORAGE_UNAVAILABLE');
      fail('OUTBOX_STORAGE_UNAVAILABLE');
    }
  }
  static memoryForTests() { return new SQLiteOutboxJournal(key,null); }
  constructor(token,root) {
    if (token !== key) fail('OUTBOX_STORAGE_UNAVAILABLE');
    this.#durable = root !== null;
    try {
      this.#guard = new DatabaseSync(root === null ? ':memory:' : join(root,'outbox-guard.sqlite'));
      const guardExists = inspect(this.#guard,guardSchema,null);
      this.#db = new DatabaseSync(root === null ? ':memory:' : join(root,'outbox-journal.sqlite'));
      const exists = inspect(this.#db,schema,'discord-outbox-journal');
      if (exists) {
        const leases = new Map();
        for (const row of this.#db.prepare('SELECT * FROM outbox_leases').all()) {
          let value; try { value = fence(JSON.parse(row.snapshot)); } catch { fail('OUTBOX_DATA_INVALID'); }
          if (value.botId !== row.bot) fail('OUTBOX_DATA_INVALID');
          leases.set(row.bot,value);
        }
        for (const stored of this.#db.prepare('SELECT * FROM outbox_rows').all()) {
          const row = this.#decode(stored);
          const current = leases.get(row.metadata.botId) ?? null;
          if (row.fence && (!current || row.fence.generation > current.generation || row.fence.leaseEpoch > current.leaseEpoch || row.fence.settingsRevision > current.settingsRevision)) fail('OUTBOX_DATA_INVALID');
          if (row.state === 'sending' && (row.version >= Number.MAX_SAFE_INTEGER-2 || !sameFence(row.fence,current))) fail('OUTBOX_DATA_INVALID');
        }
        const counters = this.#db.prepare('SELECT name,seq FROM sqlite_sequence').all();
        const maximum = this.#db.prepare('SELECT coalesce(max(sequence),0) AS maximum FROM outbox_rows').get().maximum;
        if (counters.length > 1 || counters.some(c => c.name !== 'outbox_rows' || !integer(c.seq) || c.seq < maximum) || (maximum > 0 && counters.length !== 1)) fail('OUTBOX_DATA_INVALID');
      }
      this.#guard.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
      if (!guardExists) { this.#guard.exec(guardSchema[0]); this.#guard.exec('PRAGMA user_version=1;'); }
      try { this.#guard.exec('BEGIN IMMEDIATE'); } catch { fail('OUTBOX_WRITER_BUSY'); }
      this.#db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
      if (!exists) this.#transaction(() => { for (const sql of schema) this.#db.exec(sql); this.#db.exec("INSERT INTO outbox_schema VALUES('discord-outbox-journal',1); PRAGMA user_version=1;"); });
      this.#transaction(() => this.#db.exec("UPDATE outbox_rows SET state='delivery_unknown',reason='INTERRUPTED',version=version+1 WHERE state='sending'"));
    } catch (e) {
      try { this.#db?.close(); } catch {} try { this.#guard?.close(); } catch {}
      if (e instanceof OutboxJournalError) throw e;
      fail('OUTBOX_STORAGE_UNAVAILABLE');
    }
  }
  get durable() { return this.#durable; }
  #transaction(action) {
    if (this.#closed) fail('OUTBOX_CLOSED');
    try { this.#db.exec('BEGIN IMMEDIATE'); const result = action(); this.#db.exec('COMMIT'); return result; }
    catch (e) { try { this.#db.exec('ROLLBACK'); } catch {} if (e instanceof OutboxJournalError) throw e; fail('OUTBOX_STORAGE_UNAVAILABLE'); }
  }
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
        || (stored.reason !== null && !['HTTP_401','HTTP_403','HTTP_404','RATE_LIMIT','SERVER_FAILURE','AMBIGUOUS','INTERRUPTED','LEASE_CHANGED'].includes(stored.reason))) fail('OUTBOX_DATA_INVALID');
      const reasons = {
        pending: [null], sending: [null], sent: [null],
        retry_wait: ['RATE_LIMIT','SERVER_FAILURE'], blocked: ['HTTP_401','HTTP_403','HTTP_404'],
        delivery_unknown: ['AMBIGUOUS','INTERRUPTED','LEASE_CHANGED'], dead_letter: ['RATE_LIMIT','SERVER_FAILURE']
      };
      if (!reasons[stored.state].includes(stored.reason)
        || (stored.state === 'pending' && stored.version !== 0)
        || (stored.state !== 'pending' && stored.version < 1)
        || (stored.state !== 'pending' && stored.version < 2 * stored.failures)
        || (stored.state === 'sending' && stored.version < 2 * stored.failures + 1)
        || (['blocked','delivery_unknown'].includes(stored.state) && stored.version < 2 * stored.failures + 2)
        || (stored.state === 'sent' && stored.version < 2)
        || (['pending','sent'].includes(stored.state) && stored.failures !== 0)
        || (stored.state !== 'dead_letter' && stored.failures >= 10)) fail('OUTBOX_DATA_INVALID');
      return Object.freeze({id:stored.id,sequence:stored.sequence,version:stored.version,state:stored.state,metadata:m,fence:f,failures:stored.failures,nextAt:stored.next_at,messageId:stored.message_id,reason:stored.reason});
    } catch { fail('OUTBOX_DATA_INVALID'); }
  }
  get(rowId) {
    if (!id(rowId)) fail('OUTBOX_INVALID_INPUT');
    if (this.#closed) fail('OUTBOX_CLOSED');
    try { return this.#decode(this.#db.prepare('SELECT * FROM outbox_rows WHERE id=?').get(rowId)); }
    catch (e) { if (e instanceof OutboxJournalError) throw e; fail('OUTBOX_STORAGE_UNAVAILABLE'); }
  }
  #lease(botId) {
    const row = this.#db.prepare('SELECT * FROM outbox_leases WHERE bot=?').get(botId);
    if (!row) return null;
    try { const f = fence(JSON.parse(row.snapshot)); if (f.botId !== botId) fail('OUTBOX_DATA_INVALID'); return f; } catch { fail('OUTBOX_DATA_INVALID'); }
  }
  getLease(botId) {
    if (!id(botId)) fail('OUTBOX_INVALID_INPUT'); if (this.#closed) fail('OUTBOX_CLOSED');
    try { return this.#lease(botId); } catch (e) { if (e instanceof OutboxJournalError) throw e; fail('OUTBOX_STORAGE_UNAVAILABLE'); }
  }
  advanceLease(expected,next) {
    const before = expected === null ? null : fence(expected), after = fence(next);
    if (before && (before.botId !== after.botId || after.generation < before.generation || after.leaseEpoch <= before.leaseEpoch || after.settingsRevision < before.settingsRevision)) fail('OUTBOX_INVALID_INPUT');
    return this.#transaction(() => {
      const current = this.#lease(after.botId);
      if (before === null ? current !== null : !sameFence(before,current)) fail('OUTBOX_FENCE_CONFLICT');
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
      if (existing) { if (metadataFields.some(f => existing.metadata[f] !== m[f])) fail('OUTBOX_EVENT_CONFLICT'); return Object.freeze({duplicate:true,row:existing}); }
      const previous = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name='outbox_rows'").get()?.seq ?? 0;
      if (!integer(previous) || !integer(previous+1)) fail('OUTBOX_DATA_INVALID');
      const rowId = randomUUID();
      this.#db.prepare("INSERT INTO outbox_rows(id,event_key,state,version,metadata,fence,failures,next_at,message_id,reason) VALUES(?,?,'pending',0,?,NULL,0,NULL,NULL,NULL)").run(rowId,dedupe,JSON.stringify(m));
      return Object.freeze({duplicate:false,row:this.get(rowId)});
    });
  }
  #current(rowId,version) { if (!integer(version)) fail('OUTBOX_INVALID_INPUT'); const row = this.get(rowId); if (!row || row.version !== version) fail('OUTBOX_CAS_CONFLICT'); return row; }
  #checkFence(f) { if (!sameFence(f,this.#lease(f.botId))) fail('OUTBOX_FENCE_CONFLICT'); }
  #update(row,state,f,failures,nextAt,messageId,reason) {
    if (row.version >= Number.MAX_SAFE_INTEGER-2) fail('OUTBOX_DATA_INVALID');
    const result = this.#db.prepare('UPDATE outbox_rows SET state=?,fence=?,failures=?,next_at=?,message_id=?,reason=?,version=version+1 WHERE id=? AND version=? AND state=?').run(state,f === null ? null : JSON.stringify(f),failures,nextAt,messageId,reason,row.id,row.version,row.state);
    if (result.changes !== 1) fail('OUTBOX_CAS_CONFLICT'); return this.get(row.id);
  }
  claim(rowId,version,lease,now) {
    const f = fence(lease); if (!time(now)) fail('OUTBOX_INVALID_INPUT');
    return this.#transaction(() => {
      this.#checkFence(f); const row = this.#current(rowId,version);
      if (row.metadata.botId !== f.botId) fail('OUTBOX_FENCE_CONFLICT');
      if (!['pending','retry_wait'].includes(row.state)) fail('OUTBOX_CAS_CONFLICT');
      // Reserve claim AND settlement/recovery increments before publishing sending.
      if (row.version >= Number.MAX_SAFE_INTEGER-3) fail('OUTBOX_DATA_INVALID');
      if (row.state === 'retry_wait' && now < row.nextAt) fail('OUTBOX_NOT_DUE');
      return this.#update(row,'sending',f,row.failures,null,null,null);
    });
  }
  applyResult(rowId,version,lease,result,now,jitter = 0) {
    const f = fence(lease); if (!time(now) || typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) fail('OUTBOX_INVALID_INPUT');
    return this.#transaction(() => {
      this.#checkFence(f); const row = this.#current(rowId,version);
      if (row.state !== 'sending' || !sameFence(row.fence,f)) fail('OUTBOX_CAS_CONFLICT');
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
  close() {
    if (this.#closed) return; this.#closed=true; let failed=false;
    try { this.#db.close(); } catch { failed=true; } try { this.#guard.close(); } catch { failed=true; }
    if (failed) fail('OUTBOX_STORAGE_UNAVAILABLE');
  }
}
