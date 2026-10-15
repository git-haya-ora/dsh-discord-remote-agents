import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import type {UnprotectedAdmissionInput,UnprotectedTerminalEvent} from '../packages/discord-plugin/protected-run-outbox.js';
import type {ProtectedPayload,ProtectedPayloadInput,ExpectedPayload} from '../packages/discord-plugin/protected-payloads.js';
import type {UnifiedRun,SQLiteRunOutboxJournal,ProtectedAdmissionInput} from '../packages/discord-plugin/run-outbox-journal.js';
const {ProtectedRunOutbox:Adapter,ProtectedRunOutboxError:E}=await import(new URL('../../packages/discord-plugin/protected-run-outbox.js',import.meta.url).href) as typeof import('../packages/discord-plugin/protected-run-outbox.js');
const journalSource=new URL('../../packages/discord-plugin/run-outbox-journal.js',import.meta.url);
const {SQLiteRunOutboxJournal:J,RunOutboxJournalError:JE}=await import(journalSource.href) as typeof import('../packages/discord-plugin/run-outbox-journal.js');
const {WindowsProtectedPayloadStore:Store,describePayload:describe}=await import(new URL('../../packages/discord-plugin/protected-payloads.js',import.meta.url).href) as typeof import('../packages/discord-plugin/protected-payloads.js');
const input=(inputId='input',extra:Partial<UnprotectedAdmissionInput>={}):UnprotectedAdmissionInput=>({backendIdentity:'backend',nativeSessionId:'session',agentId:'agent',transport:'discord',botId:'bot',inputId,payloadDigest:'a'.repeat(64),guildId:'guild',channelId:'channel',threadId:null,actorId:'owner',bindingId:'binding',bindingVersion:0,workspaceAlias:'workspace with spaces',receiverGeneration:1,leaseEpoch:1,...extra});
const text='SYNTHETIC private prompt 日本語 😀\r\n\tcode e\u0301';
const output='SYNTHETIC private notification 日本語 😀\nNo external transmission.';
const receipt=(r:UnifiedRun)=>({clientRequestId:r.clientRequestId,payloadDigest:r.metadata.payloadDigest,run:{backendIdentity:r.metadata.backendIdentity,nativeSessionId:r.metadata.nativeSessionId,nativeRunIdOrEquivalent:`native-${r.id}`},acceptedAt:'2026-10-14T00:00:00.000Z',admissionRevision:'admitted',durable:true as const});
const event=(r:UnifiedRun,eventId='event'):UnprotectedTerminalEvent=>({backendIdentity:r.metadata.backendIdentity,nativeSessionId:r.metadata.nativeSessionId,clientRequestId:r.clientRequestId,payloadDigest:r.metadata.payloadDigest,nativeRunIdOrEquivalent:receipt(r).run.nativeRunIdOrEquivalent,eventId,revision:'opaque revision',checkpoint:'opaque checkpoint',occurredAt:'2026-10-14T00:01:00.000Z',state:'completed'});
const fence={botId:'bot',generation:1,leaseEpoch:1,settingsRevision:1};
const errorCode=(code:string)=>(error:unknown)=>{assert.ok(error instanceof E||error instanceof JE);assert.equal(error.code,code);assert.equal(error.message,code);return true;};
/** Explicit nondurable trusted dependency fixture, NOT DPAPI/Native/auth proof. */
function fixture(){
 const values=new Map<string,ProtectedPayload>(),calls:string[]=[];
 const store={
  async create(payload:ProtectedPayloadInput){calls.push('create');const ref=randomBytes(32).toString('hex');values.set(ref,Object.freeze({schemaVersion:1,...payload}));return Object.freeze({ref,...describe(payload)});},
  async read(ref:string,_expected:ExpectedPayload){calls.push('read');const p=values.get(ref);if(!p)throw Error('synthetic-private-missing');return p;}
 };
 return {store,values,calls};
}
function accept(j:SQLiteRunOutboxJournal,r:UnifiedRun){const claimed=j.claim(r.id,r.version);return j.applyResponse(claimed.id,claimed.version,{kind:'accepted',receipt:receipt(claimed)});}
test('integrated adapter protects/read-validates before local SQL, separates both fingerprints and pins replay refs',async()=>{
 const f=fixture(),j=J.memoryForTests(),a=new Adapter(j,f.store),enqueue=j.enqueue.bind(j),commit=j.commitTerminal.bind(j);
 j.enqueue=m=>{f.calls.push('sql-enqueue');return enqueue(m);};j.commitTerminal=(id,v,e)=>{f.calls.push('sql-terminal');return commit(id,v,e);};
 try{
  const q=await a.enqueue(input(),text);assert.equal(j.durable,false);assert.deepEqual(f.calls,['create','read','sql-enqueue']);assert.equal(q.run.metadata.payloadDigest,'a'.repeat(64));assert.notEqual(q.run.metadata.protectedPayloadDigest,q.run.metadata.payloadDigest);
  const duplicate=await a.enqueue(input('input',{receiverGeneration:2,leaseEpoch:2}),text);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.run.metadata.payloadRef,q.run.metadata.payloadRef);assert.equal(f.values.size,2);
  await assert.rejects(a.enqueue(input(),text+' changed'),errorCode('RUN_OUTBOX_INPUT_CONFLICT'));assert.equal(f.values.size,3);assert.deepEqual(j.get(q.run.id),q.run);
  await assert.rejects(a.enqueue(input('input',{payloadDigest:'b'.repeat(64)}),text),errorCode('RUN_OUTBOX_INPUT_CONFLICT'));assert.deepEqual(j.get(q.run.id),q.run);
  let r=j.claim(q.run.id,0);assert.equal((await a.readPrompt(r.id,r.version)).text,text);r=j.applyResponse(r.id,r.version,{kind:'accepted',receipt:receipt(r)});assert.equal(r.receipt!.payloadDigest,r.metadata.payloadDigest);
  const pair=await a.commitTerminal(r.id,r.version,event(r),output);assert.equal(pair.run.state,'completed');assert.equal(pair.delivery.state,'pending');
  const body=f.values.get(pair.delivery.metadata.payloadRef)!;assert.equal(body.kind,'notification');
  assert.equal((body.context as {promptDigest:string}).promptDigest,r.metadata.protectedPayloadDigest);assert.notEqual((body.context as {promptDigest:string}).promptDigest,r.metadata.payloadDigest);
  assert.equal(pair.run.terminal!.payloadDigest,r.metadata.payloadDigest);assert.equal(pair.run.terminal!.notificationDigest,pair.delivery.metadata.payloadDigest);
  const again=await a.commitTerminal(r.id,0,event(r),output);assert.equal(again.duplicate,true);assert.equal(again.delivery.metadata.payloadRef,pair.delivery.metadata.payloadRef);assert.equal(again.run.metadata.payloadRef,q.run.metadata.payloadRef);
  await assert.rejects(a.commitTerminal(r.id,0,event(r),output+' changed'),errorCode('RUN_OUTBOX_EVENT_CONFLICT'));assert.deepEqual(j.get(r.id),pair.run);assert.deepEqual(j.getDelivery(pair.delivery.id),pair.delivery);
  assert.equal(f.calls.filter(c=>c==='sql-terminal').length,3);
  await assert.rejects(a.readDelivery(pair.delivery.id,0,fence),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));
  j.advanceLease(null,fence);const sending=j.claimDelivery(pair.delivery.id,0,fence,0);assert.equal((await a.readDelivery(sending.id,sending.version,fence)).text,output);assert.deepEqual(j.getDelivery(sending.id),sending);
 }finally{j.close();}
});
test('adapter creation/readback/descriptor failures cannot commit Run or terminal/Outbox; raw errors sanitized',async()=>{
 for(const mode of ['create','read','descriptor','body','scope','kind'] as const){
  const f=fixture(),j=J.memoryForTests(),a=new Adapter(j,f.store),originalCreate=f.store.create,originalRead=f.store.read;
  let enabled=false,sqlCalls=0;const sql=j.enqueue.bind(j),terminalSql=j.commitTerminal.bind(j);j.enqueue=m=>{sqlCalls++;return sql(m);};j.commitTerminal=(id,v,e)=>{sqlCalls++;return terminalSql(id,v,e);};
  f.store.create=async p=>{if(enabled&&mode==='create')throw Error('synthetic-private-do-not-return');const d=await originalCreate(p);return enabled&&mode==='descriptor'?{...d,digest:'0'.repeat(64)}:d;};
  f.store.read=async(ref,pin)=>{if(enabled&&mode==='read')throw Error('synthetic-private-do-not-return');const p=await originalRead(ref,pin);if(!enabled)return p;return mode==='body'?{...p,text:p.text+' changed'}:mode==='scope'?{...p,context:{...p.context,channelId:'retarget'}} as ProtectedPayload:mode==='kind'?{...p,kind:'token'} as unknown as ProtectedPayload:p;};
  try{
   enabled=true;await assert.rejects(a.enqueue(input(),text),errorCode(['create','read'].includes(mode)?'PROTECTED_RUN_PAYLOAD_FAILURE':'PROTECTED_RUN_PAYLOAD_MISMATCH'));assert.equal(sqlCalls,0);assert.deepEqual(j.listSession('backend','session'),[]);
   enabled=false;const r=accept(j,(await a.enqueue(input(),text)).run),before=j.get(r.id),count=sqlCalls;enabled=true;
   await assert.rejects(a.commitTerminal(r.id,r.version,event(r),output),errorCode(['create','read'].includes(mode)?'PROTECTED_RUN_PAYLOAD_FAILURE':'PROTECTED_RUN_PAYLOAD_MISMATCH'));assert.equal(sqlCalls,count);assert.deepEqual(j.get(r.id),before);assert.equal(j.getDelivery('not-created'),null);
  }finally{j.close();}
 }
});
test('own-data snapshots/attachment refusal and post-await input mutation never execute getters or proxy traps',async()=>{
 const f=fixture(),j=J.memoryForTests(),a=new Adapter(j,f.store);let traps=0;const trap=()=>{traps++;throw Error('synthetic-private-getter');};
 try{
  const getter={...input()};Object.defineProperty(getter,'actorId',{enumerable:true,get:trap});
  for(const bad of [getter,new Proxy(input(),{get:trap,ownKeys:trap,getOwnPropertyDescriptor:trap}),{...input(),attachments:[]},{...input(),payloadRef:'b'.repeat(64)},{...input(),protectedPayloadDigest:'b'.repeat(64)},{...input(),authority:true}]) await assert.rejects(a.enqueue(bad as UnprotectedAdmissionInput,text),errorCode('PROTECTED_RUN_INVALID_INPUT'));
  assert.equal(traps,0);assert.equal(f.calls.length,0);
  const mutable=input(),pending=a.enqueue(mutable,text);(mutable as {actorId:string}).actorId='mutated';const result=await pending;assert.equal(result.run.metadata.actorId,'owner');
  const r=accept(j,result.run),badEvent={...event(r)};Object.defineProperty(badEvent,'eventId',{enumerable:true,get:trap});await assert.rejects(a.commitTerminal(r.id,r.version,badEvent,output),errorCode('PROTECTED_RUN_INVALID_INPUT'));
  await assert.rejects(a.commitTerminal(r.id,r.version,{...event(r),attachments:[]} as UnprotectedTerminalEvent,output),errorCode('PROTECTED_RUN_INVALID_INPUT'));assert.equal(traps,0);
  const originalCreate=f.store.create;f.store.create=async p=>{const d=await originalCreate(p);const getterDescriptor={...d};Object.defineProperty(getterDescriptor,'ref',{enumerable:true,get:trap});return getterDescriptor;};
  await assert.rejects(a.enqueue(input('second'),text),errorCode('PROTECTED_RUN_PAYLOAD_MISMATCH'));assert.equal(traps,0);
 }finally{j.close();}
});
test('prompt and delivery reads are version/state/current-lease fenced before and after await',async()=>{
 const f=fixture(),j=J.memoryForTests(),a=new Adapter(j,f.store),original=f.store.read;let duringRead:(()=>void)|null=null;
 f.store.read=async(ref,pin)=>{const result=await original(ref,pin);duringRead?.();return result;};
 try{
  const q=(await a.enqueue(input(),text)).run;const calls=f.calls.length;await assert.rejects(a.readPrompt(q.id,0),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));assert.equal(f.calls.length,calls);
  let r=j.claim(q.id,0);await assert.rejects(a.readPrompt(r.id,0),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));
  duringRead=()=>{j.markUnknown(r.id,r.version);};await assert.rejects(a.readPrompt(r.id,r.version),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));r=j.get(r.id)!;assert.equal(r.state,'unknown');duringRead=null;
  await assert.rejects(a.readPrompt(r.id,r.version),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));r=j.reconcileLookup(r.id,r.version,{kind:'accepted',receipt:receipt(r)});
  await assert.rejects(a.readPrompt(r.id,r.version),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));
  const pair=await a.commitTerminal(r.id,r.version,event(r),output);await assert.rejects(a.readPrompt(r.id,pair.run.version),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));
  j.advanceLease(null,fence);let d=j.claimDelivery(pair.delivery.id,0,fence,0);await assert.rejects(a.readDelivery(d.id,d.version,{...fence,leaseEpoch:2}),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));
  duringRead=()=>{j.advanceLease(fence,{...fence,leaseEpoch:2});};await assert.rejects(a.readDelivery(d.id,d.version,fence),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));duringRead=null;d=j.getDelivery(d.id)!;assert.equal(d.state,'delivery_unknown');
  await assert.rejects(a.readDelivery(d.id,d.version,{...fence,leaseEpoch:2}),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));assert.deepEqual(j.getDelivery(d.id),d);
 }finally{j.close();}
});
test('mandatory internal fingerprint rejects malformed/absent fields and local queue failure retains only encrypted-orphan responsibility',async()=>{
 const f=fixture(),j=J.memoryForTests(),a=new Adapter(j,f.store);
 try{
  for(const fingerprint of ['', 'x'.repeat(64),'A'.repeat(64),'0'.repeat(63),null]) assert.throws(()=>j.enqueue({...input(),payloadRef:'b'.repeat(64),protectedPayloadDigest:fingerprint} as ProtectedAdmissionInput),errorCode('RUN_OUTBOX_INVALID_INPUT'));
  assert.throws(()=>j.enqueue({...input(),payloadRef:'b'.repeat(64)} as ProtectedAdmissionInput),errorCode('RUN_OUTBOX_INVALID_INPUT'));
  for(let n=0;n<10;n++)await a.enqueue(input(String(n)),text);
  const before=j.listSession('backend','session');await assert.rejects(a.enqueue(input('overflow'),text),errorCode('RUN_OUTBOX_QUEUE_FULL'));assert.deepEqual(j.listSession('backend','session'),before);assert.equal(f.values.size,11);
 }finally{j.close();}
});
async function child(script:string,code:number,input:string){await new Promise<void>((done,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','ignore','ignore']});p.once('error',reject);p.stdin.on('error',reject);p.stdin.end(input);p.once('close',actual=>actual===code?done():reject(Error(`FIXTURE_CHILD_EXIT_${actual}`)));});}
test('native integrated private DPAPI+SQLite restart, distinct fingerprints, original refs, tamper and fail-before-SQL', {skip:process.platform!=='win32'},async t=>{
 const parent=resolve(await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT??tmpdir(),'dsh-integrated-payload-test-'))),root=join(parent,'journal'),payloadRoot=join(parent,'payloads');assert.ok(basename(parent).startsWith('dsh-integrated-payload-test-'));let j:SQLiteRunOutboxJournal|undefined;
 try{
  try{j=await J.open(root);}catch(error){assert.ok(error instanceof JE);assert.equal(error.code,'RUN_OUTBOX_PRIVATE_PATH_UNSAFE');assert.ok(!process.env.DSH_DISCORD_TEST_PRIVATE_PARENT,'configured safe parent must not skip');t.skip('initial private journal hierarchy refused; integrated durability unverified');return;}
  const store=new Store(payloadRoot);let a=new Adapter(j,store),q=(await a.enqueue(input(),text)).run;
  assert.notEqual(q.metadata.payloadDigest,q.metadata.protectedPayloadDigest);assert.equal(q.metadata.payloadDigest,'a'.repeat(64));
  const replay=await a.enqueue(input(),text);assert.equal(replay.run.metadata.payloadRef,q.metadata.payloadRef);assert.equal(replay.duplicate,true);
  j.close();j=undefined;j=await J.open(root);a=new Adapter(j,new Store(payloadRoot));q=j.get(q.id)!;assert.equal(q.state,'queued');let r=j.claim(q.id,q.version);assert.equal((await a.readPrompt(r.id,r.version)).text,text);
  j.close();j=undefined;j=await J.open(root);a=new Adapter(j,new Store(payloadRoot));r=j.get(r.id)!;assert.equal(r.state,'unknown');await assert.rejects(a.readPrompt(r.id,r.version),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));
  r=j.reconcileLookup(r.id,r.version,{kind:'accepted',receipt:receipt(r)});const pair=await a.commitTerminal(r.id,r.version,event(r),output),replayed=await a.commitTerminal(r.id,0,event(r),output);assert.equal(replayed.delivery.metadata.payloadRef,pair.delivery.metadata.payloadRef);
  j.close();j=undefined;j=await J.open(root);a=new Adapter(j,new Store(payloadRoot));const terminal=j.get(r.id)!;assert.equal(terminal.metadata.protectedPayloadDigest,q.metadata.protectedPayloadDigest);assert.equal(terminal.terminal!.payloadDigest,q.metadata.payloadDigest);
  j.advanceLease(null,fence);let sending=j.claimDelivery(pair.delivery.id,0,fence,0);const notification=await a.readDelivery(sending.id,sending.version,fence);assert.equal(notification.text,output);assert.equal((notification.context as {promptDigest:string}).promptDigest,q.metadata.protectedPayloadDigest);
  const dbFile=join(root,'run-outbox-journal.sqlite'),dbBytes=await readFile(dbFile),sensitiveMarkers=[text,output,'SYNTHETIC private prompt','SYNTHETIC private notification'];
  for(const marker of sensitiveMarkers)assert.equal(dbBytes.includes(Buffer.from(marker)),false);
  for(const file of await readdir(payloadRoot)){const blob=await readFile(join(payloadRoot,file));for(const marker of sensitiveMarkers)assert.equal(blob.includes(Buffer.from(marker)),false);}
  // Real protected ref substitution/corruption: availability cannot release sending.
  const notificationPath=join(payloadRoot,`payload-${pair.delivery.metadata.payloadRef}.dpapi`),goodBlob=await readFile(notificationPath);await writeFile(notificationPath,randomBytes(80));await assert.rejects(a.readDelivery(sending.id,sending.version,fence),errorCode('PROTECTED_RUN_PAYLOAD_FAILURE'));assert.deepEqual(j.getDelivery(sending.id),sending);await writeFile(notificationPath,goodBlob);
  // Actual mixed-root protection failure leaves Run/terminal/Outbox SQL untouched.
  const contamination=join(payloadRoot,`${'f'.repeat(64)}.dpapi`);await writeFile(contamination,Buffer.from('synthetic-not-a-token'));
  const before=j.listSession('backend','session'),beforeBytes=await readFile(dbFile);await assert.rejects(a.enqueue(input('protection-failed',{nativeSessionId:'new-session'}),text),errorCode('PROTECTED_RUN_PAYLOAD_FAILURE'));assert.deepEqual(j.listSession('backend','session'),before);assert.deepEqual(await readFile(dbFile),beforeBytes);
  assert.equal(resolve(contamination),join(parent,'payloads',`${'f'.repeat(64)}.dpapi`));await rm(contamination);
  const second=accept(j,(await a.enqueue(input('second'),text)).run);await writeFile(contamination,Buffer.from('synthetic-not-a-token'));const terminalBefore=await readFile(dbFile);await assert.rejects(a.commitTerminal(second.id,second.version,event(second,'second'),output),errorCode('PROTECTED_RUN_PAYLOAD_FAILURE'));assert.deepEqual(await readFile(dbFile),terminalBefore);assert.equal(j.get(second.id)!.terminal,null);assert.equal(j.getDelivery(pair.delivery.id)!.id,pair.delivery.id);assert.equal(resolve(contamination),join(parent,'payloads',`${'f'.repeat(64)}.dpapi`));await rm(contamination);
  // Injected trusted readback failure wraps the actual native store and creates a
  // real protected orphan, never SQL terminal/Outbox. No fake durability claim.
  const beforeReadback=await readFile(dbFile),blobsBeforeReadback=(await readdir(payloadRoot)).length,nativeFailRead={create:store.create.bind(store),async read(){throw Error('synthetic-readback-fault');}};
  await assert.rejects(new Adapter(j,nativeFailRead).commitTerminal(second.id,second.version,event(second,'second'),output),errorCode('PROTECTED_RUN_PAYLOAD_FAILURE'));assert.deepEqual(await readFile(dbFile),beforeReadback);assert.equal(j.get(second.id)!.terminal,null);assert.equal((await readdir(payloadRoot)).length,blobsBeforeReadback+1);
  // Actual adapter product-path SQL rollback after successful native protection
  // retains the new encrypted orphan and neither terminal nor delivery mutation.
  const inject=new DatabaseSync(dbFile);inject.exec("CREATE TRIGGER reject_protected_terminal BEFORE INSERT ON outbox_rows BEGIN SELECT RAISE(ABORT,'synthetic'); END");inject.close();
  const beforeSqlFault=await readFile(dbFile),blobsBeforeSqlFault=(await readdir(payloadRoot)).length,acceptedBeforeSqlFault=j.get(second.id);
  await assert.rejects(a.commitTerminal(second.id,second.version,event(second,'second'),output),errorCode('RUN_OUTBOX_STORAGE_UNAVAILABLE'));assert.deepEqual(await readFile(dbFile),beforeSqlFault);assert.deepEqual(j.get(second.id),acceptedBeforeSqlFault);assert.equal((await readdir(payloadRoot)).length,blobsBeforeSqlFault+1);
  const removeTrigger=new DatabaseSync(dbFile);removeTrigger.exec('DROP TRIGGER reject_protected_terminal');removeTrigger.close();
  j.close();j=undefined;j=await J.open(root);a=new Adapter(j,new Store(payloadRoot));sending=j.getDelivery(pair.delivery.id)!;assert.equal(sending.state,'delivery_unknown');await assert.rejects(a.readDelivery(sending.id,sending.version,fence),errorCode('PROTECTED_RUN_FENCE_CONFLICT'));
 }finally{j?.close();assert.equal(resolve(parent),parent);assert.ok(basename(parent).startsWith('dsh-integrated-payload-test-'));await rm(parent,{recursive:true,force:true});}
});
test('native new internal profile rejects old identity/missing fingerprint before mutations; both database bytes preserved',async t=>{
 const parent=resolve(await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT??tmpdir(),'dsh-integrated-profile-test-'))),root=join(parent,'journal');let j:SQLiteRunOutboxJournal|undefined;
 try{
  try{j=await J.open(root);}catch(error){assert.ok(error instanceof JE);assert.equal(error.code,'RUN_OUTBOX_PRIVATE_PATH_UNSAFE');assert.ok(!process.env.DSH_DISCORD_TEST_PRIVATE_PARENT,'configured safe parent must not skip');t.skip('initial private profile hierarchy refused; byte-refusal unverified');return;}
  j.enqueue({...input(),payloadRef:'b'.repeat(64),protectedPayloadDigest:'c'.repeat(64)});j.close();j=undefined;
  const file=join(root,'run-outbox-journal.sqlite'),guard=join(root,'run-outbox-guard.sqlite'),raw=new DatabaseSync(file),row=raw.prepare('SELECT metadata FROM admission_runs').get()!;const legacyMetadata=JSON.parse(row.metadata as string);delete legacyMetadata.protectedPayloadDigest;raw.prepare('UPDATE admission_runs SET metadata=?').run(JSON.stringify(legacyMetadata));raw.prepare('UPDATE run_outbox_schema SET identity=?').run('discord-run-outbox-journal');raw.close();
  const oldData=await readFile(file),oldGuard=await readFile(guard);await assert.rejects(J.open(root),errorCode('RUN_OUTBOX_SCHEMA_INCOMPATIBLE'));assert.deepEqual(await readFile(file),oldData);assert.deepEqual(await readFile(guard),oldGuard);
  const update=new DatabaseSync(file);update.prepare('UPDATE run_outbox_schema SET identity=?').run('discord-run-outbox-protected-journal');const missing=JSON.parse(row.metadata as string);delete missing.protectedPayloadDigest;update.prepare('UPDATE admission_runs SET metadata=?').run(JSON.stringify(missing));update.close();
  const missingData=await readFile(file),missingGuard=await readFile(guard);await assert.rejects(J.open(root),errorCode('RUN_OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),missingData);assert.deepEqual(await readFile(guard),missingGuard);
  const corrupt=new DatabaseSync(file);corrupt.prepare('UPDATE admission_runs SET metadata=?').run(JSON.stringify({...JSON.parse(row.metadata as string),protectedPayloadDigest:'x'.repeat(64)}));corrupt.close();
  const corruptData=await readFile(file),corruptGuard=await readFile(guard);await assert.rejects(J.open(root),errorCode('RUN_OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),corruptData);assert.deepEqual(await readFile(guard),corruptGuard);
  const repair=new DatabaseSync(file);repair.prepare('UPDATE admission_runs SET metadata=?').run(row.metadata as string);repair.close();
  // Compatibility diagnostic executes previous inspect identity behavior in an
  // isolated child module, NOT a migration/public service or runtime dependency.
  const source=await readFile(journalSource,'utf8');assert.ok(source.includes("const identity='discord-run-outbox-protected-journal';"));
  const legacy=source.replace("const identity='discord-run-outbox-protected-journal';","const identity='discord-run-outbox-journal';");
  const childScript=`let data='';for await(const chunk of process.stdin)data+=chunk;const {source,name,root}=JSON.parse(data);const text=source.replace(/from '([^']+)'/g,(_,p)=>'from '+JSON.stringify(p.startsWith('.')?new URL(p,name).href:p));const m=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));try{await m.SQLiteRunOutboxJournal.open(root);process.exit(3);}catch(e){process.exit(e.code==='RUN_OUTBOX_SCHEMA_INCOMPATIBLE'?0:4);}`;
  const newData=await readFile(file),newGuard=await readFile(guard);await child(childScript,0,JSON.stringify({source:legacy,name:journalSource.href,root}));assert.deepEqual(await readFile(file),newData);assert.deepEqual(await readFile(guard),newGuard);
 }finally{j?.close();assert.equal(resolve(parent),parent);assert.ok(basename(parent).startsWith('dsh-integrated-profile-test-'));await rm(parent,{recursive:true,force:true});}
});
