// INTERNAL DESIGN Host-only text payload producer. Not a Native digest/provenance
// contract, authorization proof, public API, receiver or retention coordinator.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { types } from 'node:util';
import { gzipSync } from 'node:zlib';
const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const helperHash = '6a78a6ce1123c93bae3cde27df5f82d96bf1f4d1d5c2ee1885a4dfb8721495a8';
const MAX_ENVELOPE_BYTES = 98304;
const promptFields = ['backendIdentity','nativeSessionId','agentId','transport','botId','inputId','guildId','channelId','threadId','actorId','bindingId','bindingVersion','workspaceAlias'];
const notificationFields = ['backendIdentity','nativeSessionId','agentId','runId','clientRequestId','nativeRunIdOrEquivalent','promptDigest','eventId','revision','checkpoint','occurredAt','state','transport','botId','guildId','channelId','threadId','ownerId','bindingId','bindingVersion','workspaceAlias'];
const bridgeOutputFields = ['profile','transport','applicationId','botId','nativeSessionId','bridgeRunId','clientRequestId','promptDigest','observedTurn','bridgeStartSeq','lastObservedSeq','completionSource','terminalState','ownerId','guildId','channelId','threadId','bindingMode','bindingId','bindingVersion','destination','preRedactionDigest','redactedBodyDigest','deliveryPlanDigest','itemKind','itemIndex','itemCount','itemDigest'];
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
  const fields = kind === 'prompt' ? promptFields : kind === 'notification' ? notificationFields : kind === 'bridge-output' ? bridgeOutputFields : null;
  if (!fields) fail('INVALID_PAYLOAD');
  const copy = snapshot(value, fields);
  for (const field of fields) {
    const v = copy[field];
    if (field === 'bindingVersion' || field === 'bridgeStartSeq' || field === 'lastObservedSeq' || field === 'itemIndex' || field === 'itemCount') {
      if (!integer(v) || field === 'itemCount' && (v < 1 || v > 200)) fail('INVALID_PAYLOAD');
    } else if (field === 'observedTurn') { if (v !== null && !integer(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'threadId') { if (v !== null && !id(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'transport') { if (v !== 'discord') fail('INVALID_PAYLOAD'); }
    else if (['promptDigest','redactedBodyDigest','deliveryPlanDigest','itemDigest'].includes(field)) { if (!hex(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'preRedactionDigest') { if (v !== null && !hex(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'profile') { if (v !== 'local-bridge-output-v1') fail('INVALID_PAYLOAD'); }
    else if (field === 'bindingMode') { if (!['actor','shared'].includes(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'completionSource') { if (!['native-turn','bridge-rejection'].includes(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'terminalState') { if (!['succeeded','failed','interrupted'].includes(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'state' && kind === 'notification') { if (!['completed','failed','cancelled'].includes(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'destination') { if (!['dm','origin'].includes(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'itemKind') { if (!['body','part'].includes(v)) fail('INVALID_PAYLOAD'); }
    else if (field === 'occurredAt') {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('INVALID_PAYLOAD');
    } else if (!id(v)) fail('INVALID_PAYLOAD');
  }
  if (kind === 'bridge-output' && copy.itemIndex >= copy.itemCount) fail('INVALID_PAYLOAD');
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
function verifiedPayload(encoded, pin) {
  try {
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) fail('PROTECTED_PAYLOAD_FAILURE');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_ENVELOPE_BYTES || bytes.toString('base64') !== encoded) fail('PROTECTED_PAYLOAD_FAILURE');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = canonical(JSON.parse(text), true);
    if (!value.bytes.equals(bytes) || value.digest !== pin.digest || value.payload.kind !== pin.kind || JSON.stringify(value.payload.context) !== JSON.stringify(pin.context)) fail('PROTECTED_PAYLOAD_MISMATCH');
    return value.payload;
  } catch (error) {
    if (error instanceof ProtectedPayloadError && error.code === 'PROTECTED_PAYLOAD_MISMATCH') throw error;
    fail('PROTECTED_PAYLOAD_FAILURE');
  }
}
function validRoot(root) {
  return typeof root === 'string' && root.isWellFormed() && /^[A-Za-z]:\\/u.test(root) && !root.slice(2).includes(':')
    && !/[\p{Cc}<>"|?*]/u.test(root) && !root.split(/[\\/]/u).some(part => part === '.' || part === '..' || /[. ]$/u.test(part))
    && win32.normalize(root).length > 3;
}
async function privateCall(request) {
  let scriptBytes;
  try {
    const bytes = await readFile(new URL('./protected-payloads.ps1', import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== helperHash) throw new Error();
    const stat = await lstat(executable);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    scriptBytes = bytes;
  } catch { fail('PROTECTED_PAYLOAD_API_UNAVAILABLE'); }
  const compressed = gzipSync(scriptBytes).toString('base64');
  const bootstrap = `$bytes=[Convert]::FromBase64String('${compressed}');$memory=[IO.MemoryStream]::new($bytes);$zip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($zip,[Text.Encoding]::UTF8);try{[ScriptBlock]::Create($reader.ReadToEnd()).InvokeReturnAsIs()}finally{$reader.Dispose();[Array]::Clear($bytes,0,$bytes.Length)}`;
  const encodedCommand = Buffer.from(bootstrap, 'utf16le').toString('base64');
  if (encodedCommand.length + 300 >= 32767) fail('PROTECTED_PAYLOAD_API_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(executable, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encodedCommand], {
      windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' }
    }); } catch { reject(new ProtectedPayloadError('PROTECTED_PAYLOAD_API_UNAVAILABLE')); return; }
    let output = '', count = 0, settled = false, pending;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); output = ''; if (error) reject(error); else resolve(result); };
    const timer = setTimeout(() => { pending = new ProtectedPayloadError('PROTECTED_PAYLOAD_TIMEOUT'); child.kill(); }, 15000);
    child.on('error', () => finish(new ProtectedPayloadError('PROTECTED_PAYLOAD_API_UNAVAILABLE')));
    child.stdin.on('error', () => { pending = new ProtectedPayloadError(); child.kill(); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { count += chunk.length; if (count > 5000000) { pending = new ProtectedPayloadError(); child.kill(); } else output += chunk.toString('utf8'); });
    child.on('close', code => {
      if (settled) return;
      if (pending) { finish(pending); return; }
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) {
          const allowed = ['PROTECTED_PAYLOAD_FAILURE','PROTECTED_PAYLOAD_UNSAFE_PATH','PROTECTED_PAYLOAD_LOGGING_POLICY','PROTECTED_PAYLOAD_API_UNAVAILABLE','PROTECTED_PAYLOAD_QUOTA','PROTECTED_PAYLOAD_MISMATCH','PROTECTED_PAYLOAD_REF_COLLISION'];
          finish(new ProtectedPayloadError(allowed.includes(result.code) ? result.code : 'PROTECTED_PAYLOAD_FAILURE')); return;
        }
        finish(undefined, result);
      } catch { finish(new ProtectedPayloadError()); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
/** Dedicated payload root; no token-store reuse, platform fallback or public RPC.
 * Callers own durable intent, authorization, output lifecycle and SQL integration;
 * separate payload-file and SQLite commits are NOT atomic. */
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
    const stableInput = Object.freeze({ kind: value.payload.kind, context: value.payload.context, text: value.payload.text });
    const estimate = (await this.estimate([stableInput]))[0];
    if (!estimate) fail('PROTECTED_PAYLOAD_FAILURE');
    await this.createManyWithRefs([{ ref, input: stableInput, reserveBytes: estimate.cipherBytes }]);
    return Object.freeze({ ref, kind: value.payload.kind, digest: value.digest, byteLength: value.bytes.length });
  }
  async estimate(inputs) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 200) fail('INVALID_PAYLOAD');
    const values = inputs.map(input => canonical(input));
    const result = await privateCall({ operation: 'estimate', root: this.#root, values: values.map(value => value.bytes.toString('base64')) });
    if (!Array.isArray(result.sizes) || result.sizes.length !== values.length) fail('PROTECTED_PAYLOAD_FAILURE');
    return Object.freeze(values.map((value, index) => {
      const cipherBytes = result.sizes[index];
      if (!integer(cipherBytes) || cipherBytes < value.bytes.length || cipherBytes > 131072) fail('PROTECTED_PAYLOAD_FAILURE');
      return Object.freeze({ digest: value.digest, byteLength: value.bytes.length, cipherBytes });
    }));
  }
  async createWithRef(ref, input, reserveBytes) {
    if (!hex(ref)) fail('INVALID_PAYLOAD_REF');
    if (!integer(reserveBytes) || reserveBytes < 1 || reserveBytes > 131072) fail('INVALID_PAYLOAD');
    const value = canonical(input);
    if (reserveBytes < value.bytes.length) fail('PROTECTED_PAYLOAD_QUOTA');
    await this.createManyWithRefs([{ ref, input, reserveBytes }]);
  }
  async createManyWithRefs(inputs) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 200) fail('INVALID_PAYLOAD');
    const refs = new Set();
    const values = inputs.map(entry => {
      if (!entry || !hex(entry.ref) || refs.has(entry.ref) || !integer(entry.reserveBytes) || entry.reserveBytes < 1 || entry.reserveBytes > 131072) fail('INVALID_PAYLOAD');
      refs.add(entry.ref);
      const value = canonical(entry.input);
      if (entry.reserveBytes < value.bytes.length) fail('PROTECTED_PAYLOAD_QUOTA');
      return { ref: entry.ref, value: value.bytes.toString('base64'), maxBytes: entry.reserveBytes, byteLength: value.bytes.length };
    });
    const result = await privateCall({ operation: 'putBatch', root: this.#root, items: values });
    if (!Array.isArray(result.results) || result.results.length !== values.length || result.results.some((item, index) => item.ref !== values[index].ref || item.bytes !== values[index].maxBytes)) fail('PROTECTED_PAYLOAD_FAILURE');
  }
  async stats() {
    const result = await privateCall({ operation: 'stats', root: this.#root });
    if (!Array.isArray(result.files) || result.files.length > 32768 || !integer(result.bytes)) fail('PROTECTED_PAYLOAD_FAILURE');
    const refs = new Set(); let bytes = 0;
    const files = result.files.map(file => {
      if (!file || !hex(file.ref) || refs.has(file.ref) || !integer(file.bytes) || file.bytes < 1 || file.bytes > 131072) fail('PROTECTED_PAYLOAD_FAILURE');
      refs.add(file.ref); bytes += file.bytes; return Object.freeze({ ref: file.ref, bytes: file.bytes });
    });
    if (bytes !== result.bytes || bytes > 128 * 1024 * 1024) fail('PROTECTED_PAYLOAD_QUOTA');
    return Object.freeze({ bytes, files: Object.freeze(files) });
  }
  async delete(ref) {
    await this.deleteMany([ref]);
  }
  async deleteMany(refs) {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 200 || refs.some((ref, index) => !hex(ref) || refs.indexOf(ref) !== index)) fail('INVALID_PAYLOAD_REF');
    const result = await privateCall({ operation: 'deleteBatch', root: this.#root, items: refs });
    if (!Array.isArray(result.results) || result.results.length !== refs.length || result.results.some((item, index) => item.ref !== refs[index] || typeof item.deleted !== 'boolean' || !integer(item.bytes))) fail('PROTECTED_PAYLOAD_FAILURE');
    return Object.freeze(result.results.map(item => Object.freeze({ ref: item.ref, deleted: item.deleted, bytes: item.bytes })));
  }
  async read(ref, expected) {
    const values = await this.readMany([{ ref, expected }]);
    return values[0];
  }
  async readMany(inputs) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 200 || inputs.some(item => !item || !hex(item.ref))) fail('INVALID_PAYLOAD_REF');
    const refs = inputs.map(item => item.ref);
    if (new Set(refs).size !== refs.length) fail('INVALID_PAYLOAD_REF');
    const pins = inputs.map(item => expectedSnapshot(item.expected));
    const result = await privateCall({ operation: 'readBatch', root: this.#root, items: refs });
    if (!Array.isArray(result.results) || result.results.length !== inputs.length) fail('PROTECTED_PAYLOAD_FAILURE');
    return Object.freeze(result.results.map((item, index) => {
      if (item.ref !== refs[index]) fail('PROTECTED_PAYLOAD_FAILURE');
      return verifiedPayload(item.value, pins[index]);
    }));
  }
}
