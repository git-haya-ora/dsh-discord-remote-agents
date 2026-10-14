import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, readdir, open } from 'node:fs/promises';
import { isAbsolute, join, dirname, parse } from 'node:path';
import { ProtectedStoreError, validateState, prepareJournalRoot } from './windows-secrets.js';
const names = /^secret-(journal|guard)\.sqlite(-journal)?$/;
async function secureRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root || root.includes('\0') || root.split(/[\\/]/).some(p => p === '.' || p === '..')) throw new ProtectedStoreError('INVALID_SECRET_PATH');
  if (process.platform === 'win32') return prepareJournalRoot(root);
  // POSIX is for portable journal tests/hosts, not a substitute secret provider.
  let cursor = dirname(root);
  while (true) {
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) && !(stat.mode & 0o1000 && stat.uid === 0)) throw new ProtectedStoreError('PROTECTED_STORE_UNSAFE_PATH');
    if (cursor === dirname(cursor)) break; cursor = dirname(cursor);
  }
  await mkdir(root, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  for (const path of [root, ...(await readdir(root)).map(name => {
    if (!names.test(name)) throw new ProtectedStoreError('PROTECTED_STORE_UNSAFE_PATH'); return join(root, name);
  })]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || (path === root ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new ProtectedStoreError('PROTECTED_STORE_UNSAFE_PATH');
  }
}
/** Product-owned Host-only SQLite journal. Separate OS-backed guard prevents recovery racing verification. */
export class SQLiteSecretJournal {
  #db; #guard; #held = false; #closed = false;
  static async open(root) {
    let journal;
    try {
      await secureRoot(root);
      for (const name of ['secret-journal.sqlite', 'secret-guard.sqlite']) {
        try { const file = await open(join(root, name), 'wx', 0o600); await file.close(); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      await secureRoot(root);
      journal = new SQLiteSecretJournal({ key: constructionKey, path: root });
      return journal;
    } catch (error) { journal?.close(); if (error instanceof ProtectedStoreError) throw error; throw new ProtectedStoreError('SECRET_JOURNAL_UNAVAILABLE'); }
  }
  constructor(root) {
    // Construct only via open(), which checks storage before SQLite touches it.
    if (root?.key !== constructionKey) throw new ProtectedStoreError('SECRET_JOURNAL_UNAVAILABLE');
    this.#db = new DatabaseSync(join(root.path, 'secret-journal.sqlite'));
    try {
      this.#guard = new DatabaseSync(join(root.path, 'secret-guard.sqlite'));
      for (const db of [this.#db, this.#guard]) db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
      this.#db.exec("CREATE TABLE IF NOT EXISTS secret_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state TEXT NOT NULL); INSERT OR IGNORE INTO secret_state VALUES(1,0,'{\"revision\":0,\"activeRef\":null,\"pending\":null}');");
      this.#guard.exec('CREATE TABLE IF NOT EXISTS coordinator_guard (id INTEGER PRIMARY KEY CHECK(id=1));');
    } catch (e) { this.#guard?.close(); this.#db.close(); throw e; }
  }
  async withExclusive(action) {
    if (this.#held || this.#closed) throw new ProtectedStoreError('SECRET_UPDATE_BUSY');
    try { this.#guard.exec('BEGIN IMMEDIATE'); } catch { throw new ProtectedStoreError('SECRET_UPDATE_BUSY'); }
    this.#held = true;
    try { return await action(); }
    finally {
      this.#held = false;
      try { this.#guard.exec('ROLLBACK'); }
      catch {
        this.#closed = true;
        try { this.#guard.close(); } catch { /* Owned connection only. */ }
        try { this.#db.close(); } catch { /* Do not leak native diagnostics. */ }
        throw new ProtectedStoreError('SECRET_UPDATE_FAILED');
      }
    }
  }
  async load() {
    try {
      const row = this.#db.prepare('SELECT revision,state FROM secret_state WHERE id=1').get();
      const state = validateState(JSON.parse(row.state));
      if (state.revision !== row.revision) throw new Error();
      return state;
    } catch { throw new ProtectedStoreError('SECRET_JOURNAL_INVALID'); }
  }
  async compareAndSwap(expectedRevision, state) {
    if (!this.#held) throw new ProtectedStoreError('SECRET_EXCLUSIVE_UNAVAILABLE');
    validateState(state);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || state.revision !== expectedRevision + 1) throw new ProtectedStoreError('SECRET_JOURNAL_INVALID');
    // Reconstruct exact shape: never persist arbitrary caller fields/plaintext.
    const safe = { revision: state.revision, activeRef: state.activeRef, pending: state.pending && { candidateRef: state.pending.candidateRef, previousRef: state.pending.previousRef, phase: state.pending.phase } };
    try { return this.#db.prepare('UPDATE secret_state SET revision=?,state=? WHERE id=1 AND revision=?').run(safe.revision, JSON.stringify(safe), expectedRevision).changes === 1; }
    catch { throw new ProtectedStoreError('SECRET_UPDATE_FAILED'); }
  }
  close() {
    if (this.#held) throw new ProtectedStoreError('SECRET_UPDATE_BUSY');
    if (!this.#closed) { this.#closed = true; this.#guard.close(); this.#db.close(); }
  }
}
const constructionKey = Symbol('private journal construction');
