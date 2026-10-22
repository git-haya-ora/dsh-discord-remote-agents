import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, rm, link, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import type { ProtectedPayloadInput, ExpectedPayload } from '../packages/discord-plugin/protected-payloads.js';
const { WindowsProtectedPayloadStore: Store, ProtectedPayloadError: E, describePayload: describe } = await import(new URL('../../packages/discord-plugin/protected-payloads.js', import.meta.url).href) as typeof import('../packages/discord-plugin/protected-payloads.js');
const { SQLiteRunOutboxJournal: Journal } = await import(new URL('../../packages/discord-plugin/run-outbox-journal.js', import.meta.url).href) as typeof import('../packages/discord-plugin/run-outbox-journal.js');
const { WindowsSecretStore } = await import(new URL('../../packages/discord-plugin/windows-secrets.js', import.meta.url).href) as typeof import('../packages/discord-plugin/windows-secrets.js');
function prompt() {
  return { kind: 'prompt' as const, context: { backendIdentity: 'backend', nativeSessionId: 'native-session', agentId: 'agent', transport: 'discord' as const, botId: 'bot', inputId: 'input', guildId: 'guild', channelId: 'channel', threadId: null as string|null, actorId: 'actor', bindingId: 'binding', bindingVersion: 0, workspaceAlias: 'workspace with spaces' }, text: 'Synthetic prompt 日本語 😀\r\n\tcode e\u0301' };
}
function notification() {
  return { kind: 'notification' as const, context: { backendIdentity: 'backend', nativeSessionId: 'native-session', agentId: 'agent', runId: 'local-run', clientRequestId: 'request', nativeRunIdOrEquivalent: 'native-run', promptDigest: describe(prompt()).digest, eventId: 'event', revision: 'revision', checkpoint: 'checkpoint with spaces', occurredAt: '2026-10-14T00:00:00.000Z', state: 'completed' as const, transport: 'discord' as const, botId: 'bot', guildId: 'guild', channelId: 'channel', threadId: null as string|null, ownerId: 'actor', bindingId: 'binding', bindingVersion: 0, workspaceAlias: 'workspace with spaces' }, text: 'Synthetic result 日本語 😀\nNo external transmission.' };
}
function bridgeOutput(text = 'Synthetic durable result 日本語 😀\nNo external transmission.') {
  const itemDigest = createHash('sha256').update(text, 'utf8').digest('hex');
  return { kind: 'bridge-output' as const, context: { profile: 'local-bridge-output-v1' as const, transport: 'discord' as const,
    applicationId: 'application', botId: 'bot', nativeSessionId: 'native-session', bridgeRunId: 'bridge-run', clientRequestId: 'request', promptDigest: 'a'.repeat(64),
    observedTurn: 3, bridgeStartSeq: 10, lastObservedSeq: 17, completionSource: 'native-turn' as const, terminalState: 'succeeded' as const,
    ownerId: 'actor', guildId: 'guild', channelId: 'channel', threadId: null as null, bindingMode: 'actor' as const, bindingId: 'binding', bindingVersion: 2,
    destination: 'dm' as const, preRedactionDigest: 'b'.repeat(64), redactedBodyDigest: 'c'.repeat(64), deliveryPlanDigest: 'd'.repeat(64),
    itemKind: 'body' as const, itemIndex: 0, itemCount: 2, itemDigest }, text };
}
function invalid(value: unknown) { assert.throws(() => describe(value as ProtectedPayloadInput), (error: unknown) => { assert.ok(error instanceof E); assert.equal(error.code, 'INVALID_PAYLOAD'); assert.equal(error.message, 'INVALID_PAYLOAD'); return true; }); }
function expected(input: ProtectedPayloadInput): ExpectedPayload { return { kind: input.kind, digest: describe(input).digest, context: input.context } as ExpectedPayload; }
test('payload helper pin and namespace ship independently with reproducible LF bytes', async () => {
  const source = await readFile(new URL('../../packages/discord-plugin/protected-payloads.js', import.meta.url), 'utf8');
  const pins = [...source.matchAll(/^const helperHash = '([a-f0-9]{64})';$/gm)]; assert.equal(pins.length, 1);
  const helper = await readFile(new URL('../../packages/discord-plugin/protected-payloads.ps1', import.meta.url));
  assert.equal(helper.includes(13), false); assert.equal(createHash('sha256').update(helper).digest('hex'), pins[0]![1]);
  // Windows CreateProcess has a 32767-character command-line cap; no path-script fallback.
  const compressed = gzipSync(helper).toString('base64');
  const bootstrap = `$bytes=[Convert]::FromBase64String('${compressed}');$memory=[IO.MemoryStream]::new($bytes);$zip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($zip,[Text.Encoding]::UTF8);try{[ScriptBlock]::Create($reader.ReadToEnd()).InvokeReturnAsIs()}finally{$reader.Dispose();[Array]::Clear($bytes,0,$bytes.Length)}`;
  assert.ok(Buffer.from(bootstrap, 'utf16le').toString('base64').length + 300 < 32767);
  const attrs = await readFile(new URL('../../.gitattributes', import.meta.url), 'utf8');
  assert.ok(attrs.split('\n').includes('packages/discord-plugin/protected-payloads.ps1 text eol=lf'));
  const manifest = JSON.parse(await readFile(new URL('../../packages/discord-plugin/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.exports['./protected-payloads'], { types: './protected-payloads.d.ts', default: './protected-payloads.js' });
  for (const name of ['protected-payloads.js','protected-payloads.d.ts','protected-payloads.ps1']) assert.ok(manifest.files.includes(name));
  const ps = helper.toString('utf8');
  assert.ok(ps.includes('dsh-discord-remote-agents/payload/v1')); assert.ok(!ps.includes('dsh-discord-remote-agents/dpapi/v1'));
  assert.ok(ps.includes('GetFileInformationByHandle')); assert.ok(ps.includes('return i.links == 1 && (i.attributes & 0x410) == 0;')); assert.ok(ps.includes('^payload-[a-f0-9]{64}\\.dpapi$'));
  assert.equal([...ps.matchAll(/failureCode = 'PROTECTED_PAYLOAD_UNSAFE_PATH'/g)].length,1,'only explicit observed unsafe predicates classify a refusal');
  assert.ok(ps.includes("$script:failureCode = 'PROTECTED_PAYLOAD_UNSAFE_PATH'"));
  assert.ok(ps.includes('if (!GetFileInformationByHandle(h,out i)) throw new Exception("file-api");'));
  assert.ok(!ps.includes('|| i.links'),'Win32 API failure must not be conflated with observed file mismatch');
  const host = await readFile(new URL('../../packages/discord-plugin/index.js', import.meta.url), 'utf8'); assert.ok(!host.includes('protected-payloads'));
});
test('canonical metadata description preserves Unicode/newlines and ignores object insertion order', () => {
  const p = prompt(), first = describe(p), reversed = Object.fromEntries(Object.entries(p.context).reverse());
  assert.deepEqual(describe({ text: p.text, context: reversed, kind: p.kind } as unknown as ProtectedPayloadInput), first);
  assert.ok(Object.isFrozen(first)); assert.deepEqual(Object.keys(first), ['kind','digest','byteLength']);
  assert.match(first.digest, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(first).includes(p.text), false);
  const canonical = JSON.stringify({ schemaVersion: 1, ...p });
  assert.equal(first.digest, createHash('sha256').update(canonical, 'utf8').digest('hex')); assert.equal(first.byteLength, Buffer.byteLength(canonical));
  for (const text of [p.text.replace('\r\n','\n'), p.text.normalize('NFC'), p.text+' ']) assert.notEqual(describe({ ...p, text }).digest, first.digest);
  assert.notEqual(describe(notification()).digest, first.digest);
  const output = bridgeOutput();
  assert.match(describe(output).digest, /^[a-f0-9]{64}$/); assert.notEqual(describe({ ...output, text: output.text + ' changed' }).digest, describe(output).digest);
  assert.notEqual(describe({ ...output, context: { ...output.context, destination: 'origin' } }).digest, describe(output).digest);
  invalid({ ...output, context: { ...output.context, itemCount: 0 } });
  invalid({ ...output, context: { ...output.context, unexpectedNativeReceipt: 'fabricated' } });
});
test('text limits count Unicode scalars, reject invalid types/Unicode/controls and never truncate', () => {
  const p = prompt(); const upper = describe({ ...p, text: '😀'.repeat(20000) }); assert.ok(upper.byteLength > 80000 && upper.byteLength <= 98304);
  assert.ok(describe({ ...p, text: 'a'.repeat(20000) }).byteLength > 20000);
  assert.ok(describe({ ...p, text: '\\'.repeat(20000) }).byteLength > 40000);
  for (const text of ['', '😀'.repeat(20001), 'a'.repeat(20001), '\ud800', '\udfff', 'x\u0000', 'x\u0001', 'x\u007f', 'x\u0085', 42, null, new String('text')]) invalid({ ...p, text });
  assert.ok(describe({ ...p, text: '\t\r\n😀' }));
  for (const [field, value] of [['bindingVersion',-1],['bindingVersion',0.1],['bindingVersion',Number.MAX_SAFE_INTEGER-1],['backendIdentity',''],['actorId','x\ud800'],['workspaceAlias',' leading'],['agentId','trailing '],['inputId','x\n'],['guildId','a'.repeat(257)],['transport','telegram'],['threadId',42]]) invalid({ ...p, context: { ...p.context, [field as string]: value } });
  assert.ok(describe({ ...p, context: { ...p.context, bindingVersion: Number.MAX_SAFE_INTEGER-2, workspaceAlias: 'space inside' } }));
  for (const value of [null,[],{...p,attachments:[]},{...p,context:{...p.context,attachments:[]}},{...p,schemaVersion:1},{...p,kind:'token'}]) invalid(value);
  const n = notification();
  for (const value of ['2026-02-30T00:00:00.000Z','2026-10-14T00:00:00Z','2026-10-14T00:00:00.000+00:00','2026-10-14T24:00:00.000Z']) invalid({ ...n, context: { ...n.context, occurredAt: value } });
  invalid({ ...n, context: { ...n.context, state: 'running' } }); invalid({ ...n, context: { ...n.context, promptDigest: 'A'.repeat(64) } });
});
test('own-data snapshots reject accessors, hidden/symbol fields and proxies without invoking traps', () => {
  let calls = 0; const trap = () => { calls++; throw Error('synthetic-private-value'); };
  const p = prompt(); const getter = { ...p }; Object.defineProperty(getter,'text',{ enumerable:true, get:trap }); invalid(getter);
  const c = { ...p.context }; Object.defineProperty(c,'actorId',{ enumerable:true, get:trap }); invalid({ ...p,context:c });
  for (const value of [new Proxy(p,{get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap,getPrototypeOf:trap}),{...p,context:new Proxy(p.context,{get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap})},{...p,text:{toString:trap,toJSON:trap}}, {...p, toJSON:trap}]) invalid(value);
  const revoked = Proxy.revocable(p,{}); revoked.revoke(); invalid(revoked.proxy);
  const hidden = { ...p }; Object.defineProperty(hidden,'secret',{value:'unused',enumerable:false}); invalid(hidden);
  invalid({ ...p,[Symbol('hidden')]: 'unused' });
  const prototype = new Proxy({toJSON:trap},{ get:trap }); const inherited = Object.assign(Object.create(prototype),p);
  assert.deepEqual(describe(inherited),describe(p)); assert.equal(calls,0);
});
test('digest binds every pinned context field and text, with no authority or lease fields', () => {
  for (const payload of [prompt(), notification(), bridgeOutput()]) {
    const digest = describe(payload).digest;
    for (const [field,value] of Object.entries(payload.context)) {
      if (payload.kind === 'bridge-output' && field === 'completionSource') {
        const alternate = { ...payload, context: { ...payload.context, completionSource: 'bridge-rejection', observedTurn: null, terminalState: 'failed' } };
        assert.notEqual(describe(alternate as unknown as ProtectedPayloadInput).digest, digest, field); continue;
      }
      const replacement = field === 'bindingVersion' ? (value === 1 ? 2 : 1)
        : field === 'threadId' ? 'thread' : ['promptDigest','redactedBodyDigest','deliveryPlanDigest','itemDigest','preRedactionDigest'].includes(field) ? (value === 'a'.repeat(64) ? 'e'.repeat(64) : 'a'.repeat(64))
        : field === 'state' || field === 'terminalState' ? 'failed'
        : field === 'occurredAt' ? '2026-10-14T00:00:01.000Z'
        : field === 'transport' || field === 'profile' ? undefined
        : field === 'observedTurn' ? 4 : field === 'bridgeStartSeq' ? 11 : field === 'lastObservedSeq' ? 18
        : field === 'completionSource' ? 'bridge-rejection' : field === 'bindingMode' ? 'shared' : field === 'destination' ? 'origin'
        : field === 'itemKind' ? 'part' : field === 'itemIndex' ? 1 : field === 'itemCount' ? 3
        : field === 'kind' ? 'failed' : `${value}-changed`;
      if (replacement === undefined) continue;
      assert.notEqual(describe({ ...payload, context: { ...payload.context, [field]: replacement } } as ProtectedPayloadInput).digest, digest, field);
    }
    invalid({ ...payload, context: { ...payload.context, receiverGeneration: 1 } }); invalid({ ...payload, context: { ...payload.context, leaseEpoch: 1 } });
  }
});
test('memory journal accepts stable canonical digest with fresh mock ref and pins original local metadata only', () => {
  const p=prompt(),d=describe(p),journal=Journal.memoryForTests(),ref=randomBytes(32).toString('hex');
  const input={...p.context,payloadDigest:'a'.repeat(64),protectedPayloadDigest:d.digest,payloadRef:ref,receiverGeneration:1,leaseEpoch:1};
  try {
    assert.equal(journal.durable,false);
    const first=journal.enqueue(input),replayed=journal.enqueue({...input,payloadRef:randomBytes(32).toString('hex'),receiverGeneration:2,leaseEpoch:2});
    assert.equal(first.duplicate,false);assert.equal(replayed.duplicate,true);assert.equal(replayed.run.id,first.run.id);assert.equal(replayed.run.metadata.payloadRef,ref);
    assert.throws(()=>journal.enqueue({...input,protectedPayloadDigest:describe({...p,text:p.text+' changed'}).digest}),/RUN_OUTBOX_INPUT_CONFLICT/);
    // Mock refs prove only local compatibility, not DPAPI/SQL distributed atomicity.
  } finally { journal.close(); }
});
test('Host provider fails closed on unsupported platform and invalid roots/refs/expected snapshots', async () => {
  if(process.platform!=='win32'){assert.throws(()=>new Store('/tmp/payload'),/PROTECTED_PAYLOAD_API_UNAVAILABLE/);return;}
  for(const root of ['C:\\','relative','\\\\server\\share','C:\\bad:ads','C:\\x\\..\\y','C:\\bad.','C:\\bad\u0000']) assert.throws(()=>new Store(root),/INVALID_PAYLOAD_PATH/);
  const store=new Store('C:\\unused-synthetic-payload-path');
  for(const ref of ['../escape','A'.repeat(64),'a'.repeat(64)+'\n',{}]) await assert.rejects(store.read(ref as string,expected(prompt())),/INVALID_PAYLOAD_REF/);
  await assert.rejects(store.read('a'.repeat(64),{...expected(prompt()),digest:'bad'}),/INVALID_PAYLOAD/);
  await assert.rejects(store.create({...prompt(),attachments:[]} as ProtectedPayloadInput),/INVALID_PAYLOAD/);
});
/** Synthetic fixture uses the SAME pinned logging/ACL/DPAPI helper, not an emulator.
 * Deliberately encrypt malformed logical bytes to test the production reader. */
async function invokeFixtureHelper(helper:Buffer,request:Record<string,unknown>):Promise<{ok:boolean;code?:string;sizes?:number[]}>{
 const compressed=gzipSync(helper).toString('base64'),bootstrap=`$bytes=[Convert]::FromBase64String('${compressed}');$memory=[IO.MemoryStream]::new($bytes);$zip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($zip,[Text.Encoding]::UTF8);try{[ScriptBlock]::Create($reader.ReadToEnd()).InvokeReturnAsIs()}finally{$reader.Dispose();[Array]::Clear($bytes,0,$bytes.Length)}`;
 const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows'}});
 return new Promise((resolvePromise,reject)=>{
  let output='';const timer=setTimeout(()=>{child.kill();reject(Error('SYNTHETIC_HELPER_TIMEOUT'));},15000);
  child.on('error',()=>{clearTimeout(timer);reject(Error('SYNTHETIC_HELPER_FAILURE'));});child.stdin.on('error',()=>{child.kill();});child.stderr.on('data',()=>{});child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');});
  child.on('close',code=>{clearTimeout(timer);try{const result=JSON.parse(output) as {ok:boolean;code?:string;sizes?:number[]};if(code===0&&result.ok===true||code!==0&&result.ok===false){resolvePromise(result);return;}reject(Error('SYNTHETIC_HELPER_FAILURE'));}catch{reject(Error('SYNTHETIC_HELPER_FAILURE'));}});
  child.stdin.end(JSON.stringify(request));
 });
}
async function putFixtureBytes(root:string,bytes:Buffer,ref=randomBytes(32).toString('hex')):Promise<string>{
 assert.match(ref,/^[a-f0-9]{64}$/);
 const helper=await readFile(new URL('../../packages/discord-plugin/protected-payloads.ps1',import.meta.url));
 const value=bytes.toString('base64'),estimate=await invokeFixtureHelper(helper,{operation:'estimate',root,values:[value]});
 if(!estimate.ok) throw new E(estimate.code);
 const maxBytes=estimate.sizes?.[0];assert.ok(Number.isSafeInteger(maxBytes)&&maxBytes!>0);
 const stored=await invokeFixtureHelper(helper,{operation:'putBatch',root,items:[{ref,value,maxBytes}]});
 if(!stored.ok) throw new E(stored.code);
 return ref;
}
test('synthetic native DPAPI restart/binding/canonical corruption/mixed namespace/hardlink refusal', {skip:process.platform!=='win32'}, async t=>{
 const parent=resolve(await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT??tmpdir(),'dsh-payload-test-'))),root=join(parent,'payloads');assert.ok(basename(parent).startsWith('dsh-payload-test-'));
 const input=prompt(),original=prompt(),store=new Store(root);let descriptor:Awaited<ReturnType<InstanceType<typeof Store>['create']>>;
 try{
  // Only the INITIAL genuine ancestor/private-path refusal may skip, and NEVER
  // when a safe parent was configured. All subsequent failures are assertions.
  try{const pending=store.create(input);input.text='mutated after snapshot';input.context.actorId='mutated';descriptor=await pending;}
  catch(error){assert.ok(error instanceof E);assert.equal(error.code,'PROTECTED_PAYLOAD_UNSAFE_PATH');assert.ok(!process.env.DSH_DISCORD_TEST_PRIVATE_PARENT,'configured safe parent must not skip');assert.deepEqual(await readdir(parent),[]);t.skip('initial private hierarchy gate refused; no native DPAPI roundtrip evidence');return;}
  assert.ok(Object.isFrozen(descriptor));assert.deepEqual(Object.keys(descriptor),['ref','kind','digest','byteLength']);assert.equal(descriptor.digest,describe(original).digest);
  const restarted=new Store(root),pin=expected(original),restored=await restarted.read(descriptor.ref,pin);
  assert.deepEqual(restored,{schemaVersion:1,...original});assert.ok(Object.isFrozen(restored)&&Object.isFrozen(restored.context));
  const notificationInput=notification(),n=await restarted.create(notificationInput);assert.deepEqual(await restarted.read(n.ref,expected(notificationInput)),{schemaVersion:1,...notificationInput});
   const outputInput=bridgeOutput(),estimate=(await restarted.estimate([outputInput]))[0]!;assert.equal(estimate.digest,describe(outputInput).digest);assert.equal(estimate.byteLength,describe(outputInput).byteLength);
   const outputRef=randomBytes(32).toString('hex');
   const outputWrite=[{ref:outputRef,input:outputInput,reserveBytes:estimate.cipherBytes}];
   await restarted.createManyWithRefs(outputWrite);await restarted.createManyWithRefs(outputWrite); // Exact refs and content are idempotent after a partial/crash restart.
   assert.equal((await restarted.stats()).files.find(file=>file.ref===outputRef)?.bytes,estimate.cipherBytes);
   assert.deepEqual(await restarted.readMany([{ref:outputRef,expected:expected(outputInput)}]),[{schemaVersion:1,...outputInput}]);
   await assert.rejects(restarted.createManyWithRefs([{ref:outputRef,input:bridgeOutput(outputInput.text.replace('Synthetic','Synthetix')),reserveBytes:estimate.cipherBytes}]),/PROTECTED_PAYLOAD_MISMATCH/);
   const deleted=await restarted.deleteMany([outputRef]);assert.deepEqual(deleted,[{ref:outputRef,deleted:true,bytes:estimate.cipherBytes}]);
   assert.deepEqual(await restarted.deleteMany([outputRef]),[{ref:outputRef,deleted:false,bytes:0}]);
  const fresh=await restarted.create(original);assert.notEqual(fresh.ref,descriptor.ref);assert.equal(fresh.digest,descriptor.digest);
  const path=join(root,`payload-${descriptor.ref}.dpapi`),blob=await readFile(path);assert.equal(blob.includes(Buffer.from(original.text)),false);assert.equal(blob.includes(Buffer.from(JSON.stringify(original.context))),false);
  await assert.rejects(restarted.read(descriptor.ref,{...pin,digest:'a'.repeat(64)}),/PROTECTED_PAYLOAD_MISMATCH/);
  await assert.rejects(restarted.read(descriptor.ref,expected({...original,context:{...original.context,nativeSessionId:'wrong-session'}})),/PROTECTED_PAYLOAD_MISMATCH/);
  await assert.rejects(restarted.read(descriptor.ref,expected(notificationInput)),/PROTECTED_PAYLOAD_MISMATCH/);
  // Raw fixture bytes are DPAPI-protected by the genuine helper; malformed UTF8,
  // BOM/noncanonical whitespace, duplicate keys and schema/content tampering reject.
  const valid=Buffer.from(JSON.stringify({schemaVersion:1,...original}));
  // Malformed roots and exact CreateNew collisions are never a skippable refusal,
  // observed-private-path refusal. Neither operation overwrites the blob.
  const collision=Buffer.from(valid),lastByte=collision.length-1;collision[lastByte]=collision[lastByte]!^1;
   const unsafePathFailure=(error:unknown)=>{assert.ok(error instanceof E);assert.equal(error.code,'PROTECTED_PAYLOAD_UNSAFE_PATH');return true;};
   const storageFailure=(error:unknown)=>{assert.ok(error instanceof E);assert.equal(error.code,'PROTECTED_PAYLOAD_MISMATCH');return true;};
  await assert.rejects(putFixtureBytes(`${root}\u0000invalid`,valid),unsafePathFailure);
  await assert.rejects(putFixtureBytes(root,collision,descriptor.ref),storageFailure);
  assert.deepEqual(await readFile(path),blob);
  const largeInput={...original,text:'😀'.repeat(20000)},large=await restarted.create(largeInput);
  assert.equal((await restarted.read(large.ref,expected(largeInput))).text,largeInput.text);
  for(const bytes of [Buffer.from([0xff,0xfe,0x80]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),valid]),Buffer.concat([Buffer.from(' '),valid]),Buffer.from(valid.toString('utf8').replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1')),Buffer.from(valid.toString('utf8').replace('"schemaVersion":1','"schemaVersion":2'))]){const ref=await putFixtureBytes(root,bytes);await assert.rejects(restarted.read(ref,pin),/PROTECTED_PAYLOAD_(FAILURE|MISMATCH)/);}
  // Host cannot consume payload via old token filename/entropy namespace.
  await assert.rejects(new WindowsSecretStore(root).read(descriptor.ref));
  const tokenPath=join(root,`${'c'.repeat(64)}.dpapi`);await writeFile(tokenPath,Buffer.from('synthetic-not-a-token'));
  const count=(await readdir(root)).length;await assert.rejects(restarted.create(original),/PROTECTED_PAYLOAD_UNSAFE_PATH/);assert.equal((await readdir(root)).length,count);
  await assert.rejects(restarted.read(descriptor.ref,pin),/PROTECTED_PAYLOAD_UNSAFE_PATH/);
  // Remove only the exact synthetic contamination file, verified within fixture.
  assert.equal(resolve(tokenPath),join(parent,'payloads',`${'c'.repeat(64)}.dpapi`));await rm(tokenPath);
  const linkedPath=join(root,`payload-${'d'.repeat(64)}.dpapi`);await link(path,linkedPath);await assert.rejects(restarted.read(descriptor.ref,pin),/PROTECTED_PAYLOAD_UNSAFE_PATH/);await assert.rejects(restarted.create(original),/PROTECTED_PAYLOAD_UNSAFE_PATH/);
  assert.equal(resolve(linkedPath),join(parent,'payloads',`payload-${'d'.repeat(64)}.dpapi`));await rm(linkedPath);
  // Even renamed token ciphertext is rejected by payload-specific DPAPI entropy.
  const tokenRoot=join(parent,'tokens'),secretStore=new WindowsSecretStore(tokenRoot),tokenRef=await secretStore.create('synthetic-noncredential');const copiedRef='e'.repeat(64);
  await copyFile(join(tokenRoot,`${tokenRef}.dpapi`),join(root,`payload-${copiedRef}.dpapi`));await assert.rejects(restarted.read(copiedRef,pin),/PROTECTED_PAYLOAD_FAILURE/);
  await writeFile(path,randomBytes(80));await assert.rejects(restarted.read(descriptor.ref,pin),/PROTECTED_PAYLOAD_FAILURE/);
 }finally{assert.equal(resolve(parent),parent);assert.ok(basename(parent).startsWith('dsh-payload-test-'));await rm(parent,{recursive:true,force:true});}
});
