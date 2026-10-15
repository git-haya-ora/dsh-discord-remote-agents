// INTERNAL DESIGN Host-only foundation. No native calls, receiver, public RPC,
// authorization, protected-payload reads, lifecycle terminal handling or Outbox.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { lstat, mkdir, readdir, open } from 'node:fs/promises';
import { isAbsolute, join, dirname, parse } from 'node:path';
import { prepareAdmissionJournalRoot, ProtectedStoreError } from './windows-secrets.js';
import { decideAdmissionResponse, reconcileAdmissionLookup, validateAdmissionReceipt } from './native-admission.js';
const identity = 'discord-admission-journal';
const files = /^admission-(journal|guard)\.sqlite(-journal)?$/;
const key = Symbol('construction');
const active = "state IN ('dispatching','accepted','unknown')";
const schema = [
  "CREATE TABLE admission_schema (identity TEXT PRIMARY KEY, version INTEGER NOT NULL)",
  "CREATE TABLE admission_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE, input_key TEXT NOT NULL UNIQUE, backend TEXT NOT NULL, session TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','dispatching','accepted','failed','unknown')), version INTEGER NOT NULL CHECK(version>=0), metadata TEXT NOT NULL, receipt TEXT)",
  `CREATE UNIQUE INDEX admission_active ON admission_runs(backend,session) WHERE ${active}`
];
export class AdmissionJournalError extends Error {
  constructor(code) { super(code); this.name = 'AdmissionJournalError'; this.code = code; }
}
const fail = code => { throw new AdmissionJournalError(code); };
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/\p{Cc}/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fields = ['backendIdentity', 'nativeSessionId', 'agentId', 'transport', 'botId', 'inputId', 'payloadDigest', 'payloadRef', 'guildId', 'channelId', 'threadId', 'actorId', 'bindingId', 'bindingVersion', 'workspaceAlias', 'receiverGeneration', 'leaseEpoch'];
function metadata(value) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('ADMISSION_INVALID_INPUT');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || !fields.every(field => keys.includes(field))) fail('ADMISSION_INVALID_INPUT');
    const copy = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('ADMISSION_INVALID_INPUT');
      copy[field] = descriptor.value;
    }
    if (copy.transport !== 'discord' || !hex(copy.payloadRef) || !hex(copy.payloadDigest)
      || !['bindingVersion', 'receiverGeneration', 'leaseEpoch'].every(field => integer(copy[field]))
      || (copy.threadId !== null && !id(copy.threadId))
      || !fields.filter(field => !['bindingVersion', 'receiverGeneration', 'leaseEpoch', 'threadId'].includes(field)).every(field => id(copy[field]))) fail('ADMISSION_INVALID_INPUT');
    return Object.freeze(copy);
  } catch { fail('ADMISSION_INVALID_INPUT'); }
}
function context(row) { return { backendIdentity: row.metadata.backendIdentity, nativeSessionId: row.metadata.nativeSessionId, clientRequestId: row.clientRequestId, payloadDigest: row.metadata.payloadDigest }; }
function inspectSchema(db, definitions, schemaIdentity) {
  const objects = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (db.prepare('PRAGMA application_id').get().application_id !== 0) fail('ADMISSION_SCHEMA_INCOMPATIBLE');
  if (!objects.length && version === 0) {
    // A schema-free SQLite header can still belong to another application.
    if (db.prepare('PRAGMA page_count').get().page_count !== 0) fail('ADMISSION_SCHEMA_INCOMPATIBLE');
    return false;
  }
  const expected = definitions.map(sql => ({ name: sql.match(/^CREATE (?:UNIQUE INDEX|TABLE) (\w+)/u)[1], sql })).sort((a, b) => a.name.localeCompare(b.name));
  if (version !== 1 || objects.length !== expected.length || expected.some((item, index) => item.name !== objects[index].name || item.sql !== objects[index].sql)) fail('ADMISSION_SCHEMA_INCOMPATIBLE');
  if (schemaIdentity) {
    const rows = db.prepare('SELECT identity,version FROM admission_schema').all();
    if (rows.length !== 1 || rows[0].identity !== schemaIdentity || rows[0].version !== 1) fail('ADMISSION_SCHEMA_INCOMPATIBLE');
  }
  return true;
}
async function secureRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root || root.includes('\0') || root.split(/[\\/]/).some(part => part === '.' || part === '..')) fail('ADMISSION_PRIVATE_PATH_UNSAFE');
  if (process.platform === 'win32') {
    await prepareAdmissionJournalRoot(root);
    for (const name of await readdir(root)) {
      if (!files.test(name)) fail('ADMISSION_PRIVATE_PATH_UNSAFE');
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('ADMISSION_PRIVATE_PATH_UNSAFE');
    }
    return;
  }
  let cursor = dirname(root);
  while (true) {
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) && !(stat.mode & 0o1000 && stat.uid === 0)) fail('ADMISSION_PRIVATE_PATH_UNSAFE');
    if (cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
  }
  await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  for (const path of [root, ...(await readdir(root)).map(name => { if (!files.test(name)) fail('ADMISSION_PRIVATE_PATH_UNSAFE'); return join(root, name); })]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || (path === root ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('ADMISSION_PRIVATE_PATH_UNSAFE');
  }
}
const guardSchema = ['CREATE TABLE admission_writer (id INTEGER PRIMARY KEY CHECK(id=1))'];
/** One owner for the lifetime of the journal. A local DB lock is NOT RFC-A. */
export class SQLiteAdmissionJournal {
  #db; #guard; #closed = false; #durable;
  static async open(root) {
    let journal;
    try {
      await secureRoot(root);
      for (const name of ['admission-journal.sqlite', 'admission-guard.sqlite']) {
        try { const file = await open(join(root, name), 'wx', 0o600); await file.close(); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      await secureRoot(root);
      journal = new SQLiteAdmissionJournal(key, root);
      await secureRoot(root); // Recheck newly created SQLite files before publication.
      return journal;
    } catch (error) {
      try { journal?.close(); } catch { /* Preserve fixed path/storage failure. */ }
      if (error instanceof AdmissionJournalError) throw error;
      if (error instanceof ProtectedStoreError) fail(error.code === 'INVALID_SECRET_PATH' || error.code === 'PROTECTED_STORE_UNSAFE_PATH' ? 'ADMISSION_PRIVATE_PATH_UNSAFE' : 'ADMISSION_PRIVATE_STORAGE_UNAVAILABLE');
      fail('ADMISSION_STORAGE_UNAVAILABLE');
    }
  }
  /** SQLite logic fixture only. No filesystem escape hatch or durability claim. */
  static memoryForTests() { return new SQLiteAdmissionJournal(key, null); }
  constructor(token, root) {
    if (token !== key) fail('ADMISSION_STORAGE_UNAVAILABLE');
    this.#durable = root !== null;
    try {
      this.#guard = new DatabaseSync(root === null ? ':memory:' : join(root, 'admission-guard.sqlite'));
      // Prevalidate both nonempty DBs before any CREATE/DML/format pragma.
      const guardExists = inspectSchema(this.#guard, guardSchema, null);
      this.#db = new DatabaseSync(root === null ? ':memory:' : join(root, 'admission-journal.sqlite'));
      const exists = inspectSchema(this.#db, schema, identity);
      if (exists) {
        // Read-only persisted-state preflight before mutating either database.
        for (const row of this.#db.prepare('SELECT * FROM admission_runs').all()) {
          this.#decode(row);
          if (row.state === 'dispatching' && row.version >= Number.MAX_SAFE_INTEGER - 2) fail('ADMISSION_DATA_INVALID');
        }
        if (this.#db.prepare("SELECT 1 FROM admission_runs WHERE state IN ('queued','dispatching') GROUP BY backend,session HAVING count(*)>10").get()
          || this.#db.prepare(`SELECT 1 FROM admission_runs WHERE ${active} GROUP BY backend,session HAVING count(*)>1`).get()) fail('ADMISSION_DATA_INVALID');
        const counters = this.#db.prepare('SELECT name,seq FROM sqlite_sequence').all();
        const maximum = this.#db.prepare('SELECT coalesce(max(sequence),0) AS maximum FROM admission_runs').get().maximum;
        if (counters.length > 1 || counters.some(counter => counter.name !== 'admission_runs' || !integer(counter.seq) || counter.seq < maximum)
          || (maximum > 0 && counters.length !== 1)) fail('ADMISSION_DATA_INVALID');
      }
      this.#guard.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
      if (!guardExists) { this.#guard.exec(guardSchema[0]); this.#guard.exec('PRAGMA user_version=1;'); }
      try { this.#guard.exec('BEGIN IMMEDIATE'); } catch { fail('ADMISSION_WRITER_BUSY'); }
      this.#db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
      if (!exists) this.#transaction(() => {
        for (const sql of schema) this.#db.exec(sql);
        this.#db.prepare('INSERT INTO admission_schema VALUES (?,1)').run(identity);
        this.#db.exec('PRAGMA user_version=1;');
      });
      this.#transaction(() => {
        this.#db.exec("UPDATE admission_runs SET state='unknown',version=version+1 WHERE state='dispatching'");
      });
    } catch (error) {
      try { this.#db?.close(); } catch { /* Owned connections only. */ }
      try { this.#guard?.close(); } catch { /* No raw native errors. */ }
      if (error instanceof AdmissionJournalError) throw error;
      fail('ADMISSION_STORAGE_UNAVAILABLE');
    }
  }
  get durable() { return this.#durable; }
  #transaction(action) {
    if (this.#closed) fail('ADMISSION_CLOSED');
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const result = action(); this.#db.exec('COMMIT'); return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* An uncommitted decision is never success. */ }
      if (error instanceof AdmissionJournalError) throw error;
      fail('ADMISSION_STORAGE_UNAVAILABLE');
    }
  }
  #decode(row) {
    if (!row) return null;
    try {
      const pinned = metadata(JSON.parse(row.metadata));
      if (!id(row.id) || !id(row.request_id) || !integer(row.version) || !integer(row.sequence) || row.sequence < 1
        || row.backend !== pinned.backendIdentity || row.session !== pinned.nativeSessionId
        || row.input_key !== JSON.stringify([pinned.transport, pinned.botId, pinned.inputId])) fail('ADMISSION_DATA_INVALID');
      const value = { id: row.id, clientRequestId: row.request_id, sequence: row.sequence, version: row.version, state: row.state, metadata: pinned, receipt: null };
      if (row.receipt !== null) { value.receipt = validateAdmissionReceipt(context(value), JSON.parse(row.receipt)); if (!value.receipt) fail('ADMISSION_DATA_INVALID'); }
      if (!['queued', 'dispatching', 'accepted', 'failed', 'unknown'].includes(value.state) || (value.state === 'accepted' && !value.receipt) || (['queued', 'dispatching', 'failed'].includes(value.state) && value.receipt)) fail('ADMISSION_DATA_INVALID');
      if ((value.state === 'queued' && value.version % 2 !== 0)
        || (value.state === 'dispatching' && (value.version < 1 || value.version % 2 !== 1))
        || (value.state === 'failed' && (value.version < 2 || value.version % 2 !== 0))
        || (['accepted', 'unknown'].includes(value.state) && value.version < 2)) fail('ADMISSION_DATA_INVALID');
      return Object.freeze(value);
    } catch { fail('ADMISSION_DATA_INVALID'); }
  }
  get(runId) {
    if (!id(runId)) fail('ADMISSION_INVALID_INPUT');
    if (this.#closed) fail('ADMISSION_CLOSED');
    try { return this.#decode(this.#db.prepare('SELECT * FROM admission_runs WHERE id=?').get(runId)); }
    catch (error) { if (error instanceof AdmissionJournalError) throw error; fail('ADMISSION_STORAGE_UNAVAILABLE'); }
  }
  listSession(backendIdentity, nativeSessionId) {
    if (!id(backendIdentity) || !id(nativeSessionId)) fail('ADMISSION_INVALID_INPUT');
    if (this.#closed) fail('ADMISSION_CLOSED');
    try { return Object.freeze(this.#db.prepare('SELECT * FROM admission_runs WHERE backend=? AND session=? ORDER BY sequence').all(backendIdentity, nativeSessionId).map(row => this.#decode(row))); }
    catch (error) { if (error instanceof AdmissionJournalError) throw error; fail('ADMISSION_STORAGE_UNAVAILABLE'); }
  }
  /** Caller must authorize/capability-check/validate payload, Session and scope first. */
  enqueue(input) {
    const pinned = metadata(input), inputKey = JSON.stringify([pinned.transport, pinned.botId, pinned.inputId]);
    return this.#transaction(() => {
      const duplicate = this.#decode(this.#db.prepare('SELECT * FROM admission_runs WHERE input_key=?').get(inputKey));
      if (duplicate) {
        // Original protected ref and generation remain pinned on duplicate delivery.
        const compare = fields.filter(field => !['payloadRef', 'receiverGeneration', 'leaseEpoch'].includes(field));
        if (compare.some(field => duplicate.metadata[field] !== pinned[field])) fail('ADMISSION_INPUT_CONFLICT');
        return Object.freeze({ duplicate: true, run: duplicate });
      }
      if (this.#db.prepare("SELECT 1 FROM admission_runs WHERE backend=? AND session=? AND state='unknown'").get(pinned.backendIdentity, pinned.nativeSessionId)) fail('ADMISSION_SESSION_UNKNOWN');
      // Dispatching retains its waiting slot: a later busy cannot exceed capacity.
      const waiting = this.#db.prepare("SELECT count(*) AS count FROM admission_runs WHERE backend=? AND session=? AND state IN ('queued','dispatching')").get(pinned.backendIdentity, pinned.nativeSessionId).count;
      if (waiting >= 10) fail('ADMISSION_QUEUE_FULL');
      const counter = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name='admission_runs'").get();
      const previous = counter?.seq ?? 0;
      if (!integer(previous) || !integer(previous + 1)) fail('ADMISSION_DATA_INVALID');
      const runId = randomUUID(), requestId = randomUUID();
      this.#db.prepare("INSERT INTO admission_runs(id,request_id,input_key,backend,session,state,version,metadata,receipt) VALUES(?,?,?,?,?,'queued',0,?,NULL)").run(runId, requestId, inputKey, pinned.backendIdentity, pinned.nativeSessionId, JSON.stringify(pinned));
      return Object.freeze({ duplicate: false, run: this.get(runId) });
    });
  }
  #current(runId, expectedVersion, state) {
    if (!integer(expectedVersion)) fail('ADMISSION_INVALID_INPUT');
    const row = this.get(runId);
    if (!row || row.version !== expectedVersion || row.state !== state) fail('ADMISSION_CAS_CONFLICT');
    return row;
  }
  #update(row, state, receipt) {
    if (row.version >= Number.MAX_SAFE_INTEGER - 2) fail('ADMISSION_DATA_INVALID');
    const changed = this.#db.prepare('UPDATE admission_runs SET state=?,receipt=?,version=version+1 WHERE id=? AND version=? AND state=?').run(state, receipt === null ? null : JSON.stringify(receipt), row.id, row.version, row.state).changes;
    if (changed !== 1) fail('ADMISSION_CAS_CONFLICT');
    return this.get(row.id);
  }
  /** Revalidate authorization, generation/lease, Binding continuation, Agent,
   * Workspace, Session and attachments externally immediately before claim.
   * Successful return is committed dispatching; no external submit is performed. */
  claim(runId, expectedVersion, agentConcurrencyLimit = 1) {
    // Formal current Agent configuration must supply this budget; it grants no authority.
    if (!integer(agentConcurrencyLimit) || agentConcurrencyLimit < 1) fail('ADMISSION_INVALID_INPUT');
    return this.#transaction(() => {
      const row = this.#current(runId, expectedVersion, 'queued');
      // Claim must reserve the additional response/recovery version increment.
      if (row.version >= Number.MAX_SAFE_INTEGER - 3) fail('ADMISSION_DATA_INVALID');
      if (this.#db.prepare(`SELECT 1 FROM admission_runs WHERE backend=? AND session=? AND ${active}`).get(row.metadata.backendIdentity, row.metadata.nativeSessionId)) fail('ADMISSION_SESSION_BLOCKED');
      const head = this.#db.prepare("SELECT id FROM admission_runs WHERE backend=? AND session=? AND state='queued' ORDER BY sequence LIMIT 1").get(row.metadata.backendIdentity, row.metadata.nativeSessionId);
      if (head.id !== row.id) fail('ADMISSION_NOT_FIFO_HEAD');
      // One decoder is authoritative even for persisted duplicate JSON keys.
      // Agent-wide local Bridge budget spans backend identities, unlike Session guard.
      const occupied = this.#db.prepare(`SELECT * FROM admission_runs WHERE ${active}`).all()
        .map(candidate => this.#decode(candidate))
        .filter(candidate => candidate.metadata.agentId === row.metadata.agentId).length;
      if (occupied >= agentConcurrencyLimit) fail('ADMISSION_AGENT_CAPACITY');
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
      if (!row || !integer(expectedVersion) || row.version !== expectedVersion || !['dispatching', 'accepted'].includes(row.state)) fail('ADMISSION_CAS_CONFLICT');
      return this.#update(row, 'unknown', row.receipt);
    });
  }
  reconcileLookup(runId, expectedVersion, lookup) {
    return this.#transaction(() => { const row = this.#current(runId, expectedVersion, 'unknown'); const result = reconcileAdmissionLookup(context(row), row.receipt, lookup); return this.#update(row, result.state, result.receipt); });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    let failed = false;
    try { this.#db.close(); } catch { failed = true; }
    try { this.#guard.close(); } catch { failed = true; }
    if (failed) fail('ADMISSION_STORAGE_UNAVAILABLE');
  }
}
