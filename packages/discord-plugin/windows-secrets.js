import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const helperHash = '450c940ede0ab72f136697644c951270a73c2a6f199c3ea69b34a08c0368c08d';
const refPattern = /^[a-f0-9]{64}$/;
export function isSecretRef(ref) { return typeof ref === 'string' && ref.length === 64 && refPattern.test(ref); }
export async function prepareJournalRoot(root) {
  if (!validRoot(root)) throw new ProtectedStoreError('INVALID_SECRET_PATH');
  await privateCall({ operation: 'journal', root: win32.normalize(root), ref: '0'.repeat(64) });
}
export async function prepareAdmissionJournalRoot(root) {
  if (!validRoot(root)) throw new ProtectedStoreError('INVALID_SECRET_PATH');
  await privateCall({ operation: 'admission-journal', root: win32.normalize(root), ref: '0'.repeat(64) });
}
export async function prepareOutboxJournalRoot(root) {
  if (!validRoot(root)) throw new ProtectedStoreError('INVALID_SECRET_PATH');
  await privateCall({ operation: 'outbox-journal', root: win32.normalize(root), ref: '0'.repeat(64) });
}
export async function prepareRunOutboxJournalRoot(root) {
  if (!validRoot(root)) throw new ProtectedStoreError('INVALID_SECRET_PATH');
  await privateCall({ operation: 'run-outbox-journal', root: win32.normalize(root), ref: '0'.repeat(64) });
}
export class ProtectedStoreError extends Error {
  constructor(code = 'PROTECTED_STORE_FAILURE') { super(code); this.name = 'ProtectedStoreError'; this.code = code; }
}
function validRoot(root) {
  return typeof root === 'string' && /^[A-Za-z]:\\/.test(root) && !root.slice(2).includes(':')
    && !root.includes('\0') && !root.split(/[\\/]/).some(part => part === '..' || part === '.' || /[. ]$/.test(part))
    && win32.normalize(root).length > 3;
}
async function privateCall(request) {
  let script;
  try {
    const source = await readFile(new URL('./windows-secrets.ps1', import.meta.url));
    if (createHash('sha256').update(source).digest('hex') !== helperHash) throw new Error();
    // Pass verified script bytes, not a mutable script path, to the fixed system executable.
    script = source.toString('utf8');
    const stat = await lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  } catch { throw new ProtectedStoreError('PROTECTED_API_UNAVAILABLE'); }
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' }
    }); } catch { reject(new ProtectedStoreError('PROTECTED_API_UNAVAILABLE')); return; }
    let output = ''; let bytes = 0; let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      output = ''; if (error) reject(error); else resolve(result);
    };
    let pendingFailure;
    const timer = setTimeout(() => { pendingFailure = new ProtectedStoreError('PROTECTED_STORE_TIMEOUT'); child.kill(); }, 15000);
    child.on('error', () => finish(new ProtectedStoreError('PROTECTED_API_UNAVAILABLE')));
    child.stdin.on('error', () => { pendingFailure = new ProtectedStoreError(); child.kill(); });
    child.stderr.on('data', () => {}); // Discard, never forward provider/PowerShell messages.
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 200000) { pendingFailure = new ProtectedStoreError(); child.kill(); } else output += chunk.toString('utf8');
    });
    child.on('close', code => {
      if (settled) return;
      if (pendingFailure) { finish(pendingFailure); return; }
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) {
          const safeCode = ['PROTECTED_STORE_FAILURE', 'PROTECTED_STORE_UNSAFE_PATH', 'PROTECTED_LOGGING_POLICY', 'PROTECTED_API_UNAVAILABLE'].includes(result.code) ? result.code : 'PROTECTED_STORE_FAILURE';
          finish(new ProtectedStoreError(safeCode)); return;
        }
        finish(undefined, result);
      } catch { finish(new ProtectedStoreError()); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
/** Host-only: no fallback, public RPC or ambient credentials access. */
export class WindowsSecretStore {
  #root;
  constructor(root) {
    if (process.platform !== 'win32') throw new ProtectedStoreError('PROTECTED_API_UNAVAILABLE');
    if (!validRoot(root)) throw new ProtectedStoreError('INVALID_SECRET_PATH');
    this.#root = win32.normalize(root);
  }
  async create(candidate) {
    if (typeof candidate !== 'string' || !candidate.length || Buffer.byteLength(candidate, 'utf8') > 65536) throw new ProtectedStoreError('INVALID_SECRET');
    const ref = randomBytes(32).toString('hex');
    await privateCall({ operation: 'put', root: this.#root, ref, value: Buffer.from(candidate, 'utf8').toString('base64') });
    return ref;
  }
  async read(ref) {
    if (!isSecretRef(ref)) throw new ProtectedStoreError('INVALID_SECRET_REF');
    const result = await privateCall({ operation: 'read', root: this.#root, ref });
    if (typeof result.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.value)) throw new ProtectedStoreError();
    return Buffer.from(result.value, 'base64').toString('utf8');
  }
  async retire(ref) {
    if (!isSecretRef(ref)) throw new ProtectedStoreError('INVALID_SECRET_REF');
    await privateCall({ operation: 'delete', root: this.#root, ref });
  }
}
/**
 * Host-only lifecycle coordinator. Journal must provide durable revision CAS;
 * it is an explicit product seam, not a claimed DSH service. Serialized calls
 * plus a journal-owned cross-coordinator guard prevent recovery racing a verifier.
 */
export function validateState(state) {
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision > Number.MAX_SAFE_INTEGER - 4
    || (state.activeRef !== null && !isSecretRef(state.activeRef))) throw new ProtectedStoreError('SECRET_JOURNAL_INVALID');
  if (state.pending !== null) {
    const p = state.pending;
    if (p?.phase === 'deleting') {
      if (p.candidateRef !== null || !isSecretRef(p.previousRef) || state.activeRef !== null) throw new ProtectedStoreError('SECRET_JOURNAL_INVALID');
      return state;
    }
    if (!p || !isSecretRef(p.candidateRef) || (p.previousRef !== null && !isSecretRef(p.previousRef))
      || p.candidateRef === p.previousRef || !['candidate', 'switched'].includes(p.phase)
      || (p.phase === 'candidate' ? state.activeRef !== p.previousRef : state.activeRef !== p.candidateRef)) throw new ProtectedStoreError('SECRET_JOURNAL_INVALID');
  }
  return state;
}
export class SecretLifecycle {
  #store; #journal; #busy = false;
  constructor(store, journal) { this.#store = store; this.#journal = journal; }
  async #exclusive(action) {
    if (this.#busy) throw new ProtectedStoreError('SECRET_UPDATE_BUSY');
    this.#busy = true;
    try {
      if (typeof this.#journal.withExclusive !== 'function') throw new ProtectedStoreError('SECRET_EXCLUSIVE_UNAVAILABLE');
      return await this.#journal.withExclusive(action);
    } catch (error) { if (error instanceof ProtectedStoreError) throw error; throw new ProtectedStoreError('SECRET_UPDATE_FAILED'); }
    finally { this.#busy = false; }
  }
  async replace(candidate, expectedRevision, verifier) {
    return this.#exclusive(async () => {
      const state = validateState(await this.#journal.load());
      if (state.revision !== expectedRevision || state.pending) throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
      const nextRef = await this.#store.create(candidate);
      if (!isSecretRef(nextRef) || nextRef === state.activeRef) throw new ProtectedStoreError('SECRET_JOURNAL_INVALID');
      // A crash before prepare can leave an encrypted orphan. Never auto-adopt it.
      const prepared = { ...state, revision: state.revision + 1, pending: { candidateRef: nextRef, previousRef: state.activeRef, phase: 'candidate' } };
      if (!await this.#journal.compareAndSwap(state.revision, prepared)) {
        await this.#store.retire(nextRef); throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
      }
      let verified = false;
      try { verified = await verifier(await this.#store.read(nextRef)); } catch { /* Treat verifier exceptions as failure without leaking details. */ }
      if (verified !== true) {
        await this.#store.retire(nextRef);
        if (!await this.#journal.compareAndSwap(prepared.revision, { revision: prepared.revision + 1, activeRef: state.activeRef, pending: null })) throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
        throw new ProtectedStoreError('SECRET_VERIFICATION_FAILED');
      }
      const switched = { revision: prepared.revision + 1, activeRef: nextRef, pending: { ...prepared.pending, phase: 'switched' } };
      if (!await this.#journal.compareAndSwap(prepared.revision, switched)) throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
      return this.#finish(switched);
    });
  }
  async #finish(state) {
    if (state.pending.previousRef) await this.#store.retire(state.pending.previousRef);
    const finished = { revision: state.revision + 1, activeRef: state.activeRef, pending: null };
    if (!await this.#journal.compareAndSwap(state.revision, finished)) throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
    return { revision: finished.revision, configured: finished.activeRef !== null };
  }
  async keep(expectedRevision) {
    return this.#exclusive(async () => {
      const state = validateState(await this.#journal.load());
      if (state.revision !== expectedRevision || state.pending) throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
      return { revision: state.revision, configured: state.activeRef !== null };
    });
  }
  async delete(expectedRevision, confirmed) {
    if (confirmed !== true) throw new ProtectedStoreError('SECRET_DELETE_CONFIRMATION_REQUIRED');
    return this.#exclusive(async () => {
      const state = validateState(await this.#journal.load());
      if (state.revision !== expectedRevision || state.pending) throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
      if (!state.activeRef) return { revision: state.revision, configured: false };
      const deleting = { revision: state.revision + 1, activeRef: null, pending: { candidateRef: null, previousRef: state.activeRef, phase: 'deleting' } };
      if (!await this.#journal.compareAndSwap(state.revision, deleting)) throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
      return this.#finish(deleting);
    });
  }
  async recover() {
    return this.#exclusive(async () => {
      const state = validateState(await this.#journal.load());
      if (!state.pending) return { revision: state.revision, configured: state.activeRef !== null };
      if (state.pending.phase === 'switched' || state.pending.phase === 'deleting') return this.#finish(state);
      // Unverified candidates are discarded, never submitted or auto-verified.
      await this.#store.retire(state.pending.candidateRef);
      const reverted = { revision: state.revision + 1, activeRef: state.activeRef, pending: null };
      if (!await this.#journal.compareAndSwap(state.revision, reverted)) throw new ProtectedStoreError('SECRET_REVISION_CONFLICT');
      return { revision: reverted.revision, configured: reverted.activeRef !== null };
    });
  }
}
