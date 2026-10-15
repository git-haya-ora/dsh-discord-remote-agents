// INTERNAL DESIGN Host-only text payload producer. Not a Native digest/provenance
// contract, authorization proof, public API, receiver or retention coordinator.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { types } from 'node:util';
const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const helperHash = '90c45249209b462981c9594f7cc41cd5a9860890793c80dda275e675d1a8e611';
const MAX_ENVELOPE_BYTES = 98304;
const promptFields = ['backendIdentity','nativeSessionId','agentId','transport','botId','inputId','guildId','channelId','threadId','actorId','bindingId','bindingVersion','workspaceAlias'];
const notificationFields = ['backendIdentity','nativeSessionId','agentId','runId','clientRequestId','nativeRunIdOrEquivalent','promptDigest','eventId','revision','checkpoint','occurredAt','state','transport','botId','guildId','channelId','threadId','ownerId','bindingId','bindingVersion','workspaceAlias'];
export class ProtectedPayloadError extends Error {
  constructor(code = 'PROTECTED_PAYLOAD_FAILURE') { super(code); this.name = 'ProtectedPayloadError'; this.code = code; }
}
const fail = code => { throw new ProtectedPayloadError(code); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && value.length === 64;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.isWellFormed() && value.trim() === value && !/\p{Cc}/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1;
function snapshot(value, fields) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('INVALID_PAYLOAD');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || !fields.every(field => keys.includes(field))) fail('INVALID_PAYLOAD');
  const copy = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_PAYLOAD');
    copy[field] = descriptor.value;
  }
  return copy;
}
function context(kind, value) {
  const fields = kind === 'prompt' ? promptFields : kind === 'notification' ? notificationFields : null;
  if (!fields) fail('INVALID_PAYLOAD');
  const copy = snapshot(value, fields);
  for (const field of fields) {
    const v = copy[field];
    if (field === 'bindingVersion') { if (!integer(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'threadId') { if (v !== null && !id(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'transport') { if (v !== 'discord') fail('INVALID_PAYLOAD'); }
    else if (field === 'promptDigest') { if (!hex(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'state') { if (!['completed','failed','cancelled'].includes(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'occurredAt') {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('INVALID_PAYLOAD');
    } else if (!id(v)) fail('INVALID_PAYLOAD');
  }
  return Object.freeze(copy);
}
function canonical(input, stored = false) {
  try {
    const copy = snapshot(input, stored ? ['schemaVersion','kind','context','text'] : ['kind','context','text']);
    if (stored && copy.schemaVersion !== 1) fail('INVALID_PAYLOAD');
    const text = copy.text;
    if (typeof text !== 'string' || !text.length || text.length > 40000 || !text.isWellFormed() || /[\p{Cc}&&[^\t\r\n]]/v.test(text)
      || [...text].length > 20000 || Buffer.byteLength(text, 'utf8') > 80000) fail('INVALID_PAYLOAD');
    const payload = Object.freeze({ schemaVersion: 1, kind: copy.kind, context: context(copy.kind, copy.context), text });
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    if (bytes.length > MAX_ENVELOPE_BYTES) fail('INVALID_PAYLOAD');
    return { payload, bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  } catch { fail('INVALID_PAYLOAD'); }
}
/** Metadata only; pure validation/canonicalization, not a storage receipt. */
export function describePayload(input) {
  const value = canonical(input);
  return Object.freeze({ kind: value.payload.kind, digest: value.digest, byteLength: value.bytes.length });
}
function expectedSnapshot(value) {
  try {
    const copy = snapshot(value, ['kind','digest','context']);
    if (!hex(copy.digest)) fail('INVALID_PAYLOAD');
    return Object.freeze({ kind: copy.kind, digest: copy.digest, context: context(copy.kind, copy.context) });
  } catch { fail('INVALID_PAYLOAD'); }
}
function validRoot(root) {
  return typeof root === 'string' && root.isWellFormed() && /^[A-Za-z]:\\/u.test(root) && !root.slice(2).includes(':')
    && !/[\p{Cc}<>"|?*]/u.test(root) && !root.split(/[\\/]/u).some(part => part === '.' || part === '..' || /[. ]$/u.test(part))
    && win32.normalize(root).length > 3;
}
async function privateCall(request) {
  let script;
  try {
    const bytes = await readFile(new URL('./protected-payloads.ps1', import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== helperHash) throw new Error();
    const stat = await lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    script = bytes.toString('utf8');
  } catch { fail('PROTECTED_PAYLOAD_API_UNAVAILABLE'); }
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(executable, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' }
    }); } catch { reject(new ProtectedPayloadError('PROTECTED_PAYLOAD_API_UNAVAILABLE')); return; }
    let output = '', count = 0, settled = false, pending;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); output = ''; if (error) reject(error); else resolve(result); };
    const timer = setTimeout(() => { pending = new ProtectedPayloadError('PROTECTED_PAYLOAD_TIMEOUT'); child.kill(); }, 15000);
    child.on('error', () => finish(new ProtectedPayloadError('PROTECTED_PAYLOAD_API_UNAVAILABLE')));
    child.stdin.on('error', () => { pending = new ProtectedPayloadError(); child.kill(); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { count += chunk.length; if (count > 200000) { pending = new ProtectedPayloadError(); child.kill(); } else output += chunk.toString('utf8'); });
    child.on('close', code => {
      if (settled) return;
      if (pending) { finish(pending); return; }
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) {
          const allowed = ['PROTECTED_PAYLOAD_FAILURE','PROTECTED_PAYLOAD_UNSAFE_PATH','PROTECTED_PAYLOAD_LOGGING_POLICY','PROTECTED_PAYLOAD_API_UNAVAILABLE'];
          finish(new ProtectedPayloadError(allowed.includes(result.code) ? result.code : 'PROTECTED_PAYLOAD_FAILURE')); return;
        }
        finish(undefined, result);
      } catch { finish(new ProtectedPayloadError()); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
/** Fresh dedicated payload root only. No token store reuse, fallback, public RPC,
 * cleanup/delete, attachments, SQL or Runtime integration. Protection before SQL
 * is a caller ordering requirement; separate file/SQL commits are NOT atomic. */
export class WindowsProtectedPayloadStore {
  #root;
  constructor(root) {
    if (process.platform !== 'win32') fail('PROTECTED_PAYLOAD_API_UNAVAILABLE');
    if (!validRoot(root)) fail('INVALID_PAYLOAD_PATH');
    this.#root = win32.normalize(root);
  }
  async create(input) {
    // Snapshot synchronously before the first await; no caller mutation race.
    const value = canonical(input), ref = randomBytes(32).toString('hex');
    await privateCall({ operation: 'put', root: this.#root, ref, value: value.bytes.toString('base64') });
    return Object.freeze({ ref, kind: value.payload.kind, digest: value.digest, byteLength: value.bytes.length });
  }
  async read(ref, expected) {
    if (!hex(ref)) fail('INVALID_PAYLOAD_REF');
    const pin = expectedSnapshot(expected);
    const result = await privateCall({ operation: 'read', root: this.#root, ref });
    try {
      if (typeof result.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(result.value)) fail('PROTECTED_PAYLOAD_FAILURE');
      const bytes = Buffer.from(result.value, 'base64');
      if (!bytes.length || bytes.length > MAX_ENVELOPE_BYTES || bytes.toString('base64') !== result.value) fail('PROTECTED_PAYLOAD_FAILURE');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const value = canonical(JSON.parse(text), true);
      if (!value.bytes.equals(bytes) || value.digest !== pin.digest || value.payload.kind !== pin.kind || JSON.stringify(value.payload.context) !== JSON.stringify(pin.context)) fail('PROTECTED_PAYLOAD_MISMATCH');
      return value.payload;
    } catch (error) {
      if (error instanceof ProtectedPayloadError && error.code === 'PROTECTED_PAYLOAD_MISMATCH') throw error;
      fail('PROTECTED_PAYLOAD_FAILURE');
    }
  }
}
