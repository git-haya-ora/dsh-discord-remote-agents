// INTERNAL DESIGN: real SQLite product-path crash tests are NOT live Native/Discord proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import type {ProtectedAdmissionInput as AdmissionInput} from '../packages/discord-plugin/run-outbox-journal.js';
import type {TerminalEvent,UnifiedRun,SQLiteRunOutboxJournal} from '../packages/discord-plugin/run-outbox-journal.js';
const source=new URL('../../packages/discord-plugin/run-outbox-journal.js',import.meta.url);
const {SQLiteRunOutboxJournal:J,RunOutboxJournalError:E}=await import(source.href) as typeof import('../packages/discord-plugin/run-outbox-journal.js');
const input=(inputId='input',extra:Partial<AdmissionInput>={}):AdmissionInput=>({backendIdentity:'backend',nativeSessionId:'session',agentId:'agent',transport:'discord',botId:'bot',inputId,payloadDigest:'a'.repeat(64),protectedPayloadDigest:'f'.repeat(64),payloadRef:'b'.repeat(64),guildId:'guild',channelId:'channel',threadId:null,actorId:'owner',bindingId:'binding',bindingVersion:1,workspaceAlias:'workspace',receiverGeneration:1,leaseEpoch:1,...extra});
const receipt=(r:UnifiedRun)=>({clientRequestId:r.clientRequestId,payloadDigest:r.metadata.payloadDigest,run:{backendIdentity:r.metadata.backendIdentity,nativeSessionId:r.metadata.nativeSessionId,nativeRunIdOrEquivalent:`native-${r.id}`},acceptedAt:'2026-10-13T09:00:00.000Z',admissionRevision:'admitted',durable:true as const});
const event=(r:UnifiedRun,extra:Partial<TerminalEvent>={}):TerminalEvent=>({backendIdentity:r.metadata.backendIdentity,nativeSessionId:r.metadata.nativeSessionId,clientRequestId:r.clientRequestId,payloadDigest:r.metadata.payloadDigest,nativeRunIdOrEquivalent:receipt(r).run.nativeRunIdOrEquivalent,eventId:'event',revision:'opaque-revision',checkpoint:'opaque-checkpoint',occurredAt:'2026-10-13T10:00:00.000Z',state:'completed',notificationRef:'c'.repeat(64),notificationDigest:'d'.repeat(64),...extra});
const accepted=(j:SQLiteRunOutboxJournal,i=input())=>{const d=j.claim(j.enqueue(i).run.id,0,10);return j.applyResponse(d.id,d.version,{kind:'accepted',receipt:receipt(d)});};
const code=(c:string)=>(e:unknown)=>{assert.ok(e instanceof E);assert.equal(e.code,c);assert.equal(e.message,c);return true;};
const fence={botId:'bot',generation:1,leaseEpoch:1,settingsRevision:1};
test('unified local terminal transaction pins destination, scope-dedupes and cannot roll back terminal',()=>{
 const j=J.memoryForTests();try{
  const r=accepted(j);assert.equal(r.state,'accepted');assert.equal(r.terminal,null);assert.equal(j.durable,false);
  const pair=j.commitTerminal(r.id,r.version,event(r));assert.equal(pair.run.state,'completed');assert.equal(pair.run.version,r.version+1);assert.equal(pair.delivery.state,'pending');
  assert.deepEqual(pair.run.terminal,event(r));assert.ok(Object.isFrozen(pair.run.terminal));
  assert.deepEqual(pair.delivery.metadata,{transport:'discord',botId:'bot',guildId:'guild',channelId:'channel',threadId:null,logicalEventKey:`terminal:${r.id}`,runId:r.id,ownerId:'owner',bindingId:'binding',bindingVersion:1,workspaceAlias:'workspace',payloadRef:'c'.repeat(64),payloadDigest:'d'.repeat(64)});
  const duplicate=j.commitTerminal(r.id,0,event(r));assert.equal(duplicate.duplicate,true);assert.deepEqual(duplicate.run,pair.run);assert.deepEqual(duplicate.delivery,pair.delivery);
  const recreatedBlob=j.commitTerminal(r.id,0,event(r,{notificationRef:'e'.repeat(64)}));assert.equal(recreatedBlob.duplicate,true);assert.deepEqual(recreatedBlob.run,pair.run);assert.deepEqual(recreatedBlob.delivery,pair.delivery);assert.equal(recreatedBlob.delivery.metadata.payloadRef,'c'.repeat(64));
  for(const extra of [{state:'failed' as const},{notificationDigest:'e'.repeat(64)},{revision:'other'},{checkpoint:'other'},{nativeRunIdOrEquivalent:'other'},{occurredAt:'2026-10-13T11:00:00.000Z'}])assert.throws(()=>j.commitTerminal(r.id,r.version,event(r,extra)),code('RUN_OUTBOX_EVENT_CONFLICT'));
  assert.throws(()=>j.commitTerminal(r.id,pair.run.version,event(r,{eventId:'new'})),code('RUN_OUTBOX_CAS_CONFLICT'));
  assert.throws(()=>j.reconcileLookup(r.id,pair.run.version,{kind:'accepted',receipt:receipt(r)}),code('RUN_OUTBOX_CAS_CONFLICT'));
  assert.deepEqual(j.get(r.id),pair.run);assert.deepEqual(j.getDelivery(pair.delivery.id),pair.delivery);
  const next=accepted(j,input('after-rebind',{channelId:'new-channel',bindingVersion:2}));
  assert.throws(()=>j.commitTerminal(next.id,next.version,event(next)),code('RUN_OUTBOX_EVENT_CONFLICT'));
  const another=j.commitTerminal(next.id,next.version,event(next,{eventId:'next'}));assert.equal(another.delivery.metadata.channelId,'new-channel');assert.equal(j.getDelivery(pair.delivery.id)!.metadata.channelId,'channel');
  // event IDs need not be globally unique: backend+Session is the explicit stable scope.
  const other=accepted(j,input('other-session',{nativeSessionId:'other-session'}));assert.equal(j.commitTerminal(other.id,other.version,event(other)).duplicate,false);
 }finally{j.close();j.close();}
});
test('unified receipt correlation, no-replay unknown, pre-admission failed and hostile event data',()=>{
 const j=J.memoryForTests();try{
  let r=j.claim(j.enqueue(input()).run.id,0);r=j.applyResponse(r.id,r.version,undefined);assert.equal(r.state,'unknown');
  assert.throws(()=>j.commitTerminal(r.id,r.version,event(r)),code('RUN_OUTBOX_RECEIPT_CONFLICT'));assert.throws(()=>j.claim(r.id,r.version),code('RUN_OUTBOX_CAS_CONFLICT'));
  r=j.reconcileLookup(r.id,r.version,{kind:'accepted',receipt:receipt(r)});r=j.markUnknown(r.id,r.version);
  for(const extra of [{nativeRunIdOrEquivalent:'other'},{clientRequestId:'other'},{payloadDigest:'e'.repeat(64)},{backendIdentity:'other'},{nativeSessionId:'other'}]){assert.throws(()=>j.commitTerminal(r.id,r.version,event(r,extra)),code('RUN_OUTBOX_RECEIPT_CONFLICT'));assert.equal(j.get(r.id)!.terminal,null);}
  assert.throws(()=>j.commitTerminal(r.id,0,event(r)),code('RUN_OUTBOX_CAS_CONFLICT'));
  let calls=0;const getter={...event(r)};Object.defineProperty(getter,'revision',{enumerable:true,get(){calls++;return 'fake';}});
  for(const bad of [getter,new Proxy(event(r),{}),{...event(r),verified:true},{...event(r),occurredAt:'2026-10-13T10:00:00+00:00'},{...event(r),notificationRef:'plaintext'}])assert.throws(()=>j.commitTerminal(r.id,r.version,bad as TerminalEvent),code('RUN_OUTBOX_INVALID_INPUT'));
  assert.equal(calls,0);const pair=j.commitTerminal(r.id,r.version,event(r,{state:'failed'}));assert.equal(pair.run.state,'failed');assert.notEqual(pair.run.terminal,null);
  let rejected=j.claim(j.enqueue(input('rejected')).run.id,0);rejected=j.applyResponse(rejected.id,rejected.version,{kind:'rejected',code:'INVALID_INPUT',accepted:false});
  assert.equal(rejected.state,'failed');assert.equal(rejected.terminal,null);assert.equal(rejected.receipt,null);assert.throws(()=>j.commitTerminal(rejected.id,rejected.version,event(rejected,{eventId:'rejected'})),code('RUN_OUTBOX_CAS_CONFLICT'));
 }finally{j.close();}
});
test('unified notification retry/lease changes never replay Native admission',()=>{
 const j=J.memoryForTests();try{
  const r=accepted(j),p=j.commitTerminal(r.id,r.version,event(r));j.advanceLease(null,fence);
  let d=j.claimDelivery(p.delivery.id,0,fence,0);d=j.applyDeliveryResult(d.id,d.version,fence,{kind:'http',status:429,retryAfterMs:100},0);
  assert.equal(d.state,'retry_wait');assert.throws(()=>j.claimDelivery(d.id,d.version,fence,99),code('RUN_OUTBOX_NOT_DUE'));
  assert.throws(()=>j.claim(r.id,p.run.version),code('RUN_OUTBOX_CAS_CONFLICT'));
  d=j.claimDelivery(d.id,d.version,fence,100);d=j.applyDeliveryResult(d.id,d.version,fence,{kind:'sent',messageId:'message'},101);
  assert.equal(d.state,'sent');assert.deepEqual(j.get(r.id),p.run);assert.equal(j.commitTerminal(r.id,0,event(r)).delivery.id,d.id);
  const second=accepted(j,input('second'));const secondPair=j.commitTerminal(second.id,second.version,event(second,{eventId:'second'}));let held=j.claimDelivery(secondPair.delivery.id,0,fence,0);
  j.advanceLease(fence,{...fence,leaseEpoch:2});held=j.getDelivery(held.id)!;assert.equal(held.state,'delivery_unknown');assert.throws(()=>j.claimDelivery(held.id,held.version,{...fence,leaseEpoch:2},1),code('RUN_OUTBOX_CAS_CONFLICT'));
  assert.throws(()=>j.claimDelivery(d.id,d.version,fence,102),code('RUN_OUTBOX_FENCE_CONFLICT'));
 }finally{j.close();}
});
test('unified façade persists definite-negative jittered retries, tenth-failure dead letter and success reset',()=>{
 const j=J.memoryForTests();try{
  j.advanceLease(null,fence);
  for(const [name,attempts,success] of [['dead',10,false],['retry-success',9,true]] as const){
   const r=accepted(j,input(name)),p=j.commitTerminal(r.id,r.version,event(r,{eventId:name}));let d=p.delivery,now=0;
   for(let failure=1;failure<=attempts;failure++){
    d=j.claimDelivery(d.id,d.version,fence,now);const claimed=d;
    d=j.applyDeliveryResult(d.id,d.version,fence,{kind:'http',status:503},now,0.5);
    assert.equal(d.failures,failure);assert.equal(d.version,2*failure);
    if(failure<10){const delay=Math.min(60000,Math.floor(1000*2**Math.min(failure-1,6)*1.5));assert.equal(d.state,'retry_wait');assert.equal(d.nextAt,now+delay);assert.deepEqual(j.getDelivery(d.id),d);
     assert.throws(()=>j.applyDeliveryResult(claimed.id,claimed.version,fence,{kind:'http',status:503},now,1),code('RUN_OUTBOX_CAS_CONFLICT'));assert.equal(j.getDelivery(d.id)!.nextAt,d.nextAt);now=d.nextAt!;
    }else{assert.equal(d.state,'dead_letter');assert.equal(d.nextAt,null);assert.throws(()=>j.claimDelivery(d.id,d.version,fence,now+60000),code('RUN_OUTBOX_CAS_CONFLICT'));}
   }
   if(success){d=j.claimDelivery(d.id,d.version,fence,now);assert.equal(d.version,19);d=j.applyDeliveryResult(d.id,d.version,fence,{kind:'sent',messageId:'message-after-nine-retries'},now);assert.equal(d.state,'sent');assert.equal(d.failures,0);assert.equal(d.version,20);assert.deepEqual(j.getDelivery(d.id),d);}
   assert.deepEqual(j.get(r.id),p.run);assert.throws(()=>j.claim(r.id,p.run.version),code('RUN_OUTBOX_CAS_CONFLICT'));
  }
 }finally{j.close();}
});
test('unified façade holds blocked and ambiguous outcomes without Native resend or unsafe delivery retry',()=>{
 const j=J.memoryForTests();try{
  j.advanceLease(null,fence);
  const outcomes:[unknown,string,string|null][]=[...[401,403,404].map(status=>[{kind:'http',status},'blocked',`HTTP_${status}`] as [unknown,string,string]),
   [undefined,'delivery_unknown','AMBIGUOUS'],[{kind:'network'},'delivery_unknown','AMBIGUOUS'],[{kind:'sent',messageId:''},'delivery_unknown','AMBIGUOUS'],[{kind:'http',status:400},'delivery_unknown','AMBIGUOUS'],[{kind:'http',status:500,notSent:true},'delivery_unknown','AMBIGUOUS'],[{kind:'http',status:429,retryAfterMs:-1},'delivery_unknown','AMBIGUOUS']];
  let index=0;for(const [result,state,reason] of outcomes){const name=`outcome-${index++}`,r=accepted(j,input(name)),p=j.commitTerminal(r.id,r.version,event(r,{eventId:name}));let d=j.claimDelivery(p.delivery.id,0,fence,0);d=j.applyDeliveryResult(d.id,d.version,fence,result,0,0.5);
   assert.equal(d.state,state);assert.equal(d.reason,reason);assert.equal(d.failures,0);assert.equal(d.version,2);assert.equal(d.nextAt,null);assert.throws(()=>j.claimDelivery(d.id,d.version,fence,100000),code('RUN_OUTBOX_CAS_CONFLICT'));assert.throws(()=>j.claim(r.id,p.run.version),code('RUN_OUTBOX_CAS_CONFLICT'));assert.deepEqual(j.get(r.id),p.run);assert.deepEqual(j.getDelivery(d.id),d);
  }
 }finally{j.close();}
});
test('unified admission FIFO/Agent budget reserves waiting capacity until authoritative terminal',()=>{
 const j=J.memoryForTests();try{
  const runs=Array.from({length:10},(_,i)=>j.enqueue(input(String(i))).run);
  assert.throws(()=>j.enqueue(input('full')),code('RUN_OUTBOX_QUEUE_FULL'));assert.throws(()=>j.claim(runs[1]!.id,0),code('RUN_OUTBOX_NOT_FIFO_HEAD'));
  let head=j.claim(runs[0]!.id,0);assert.throws(()=>j.enqueue(input('reserved')),code('RUN_OUTBOX_QUEUE_FULL'));
  head=j.applyResponse(head.id,head.version,{kind:'busy',activeRun:receipt(head).run,accepted:false});assert.equal(head.state,'queued');assert.equal(head.sequence,runs[0]!.sequence);
  head=j.claim(head.id,head.version);head=j.applyResponse(head.id,head.version,{kind:'accepted',receipt:receipt(head)});
  const elsewhere=j.enqueue(input('elsewhere',{backendIdentity:'elsewhere',nativeSessionId:'elsewhere'})).run;assert.throws(()=>j.claim(elsewhere.id,0),code('RUN_OUTBOX_AGENT_CAPACITY'));
  assert.throws(()=>j.claim(runs[1]!.id,0),code('RUN_OUTBOX_SESSION_BLOCKED'));
  j.commitTerminal(head.id,head.version,event(head,{state:'cancelled'}));assert.equal(j.claim(runs[1]!.id,0).state,'dispatching');
 }finally{j.close();}
});
async function child(script:string,exit:number){await new Promise<void>((resolveChild,reject)=>{const c=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});c.once('error',reject);c.once('close',actual=>actual===exit?resolveChild():reject(Error(`PRODUCT_CRASH_FIXTURE_EXIT_${actual}`)));});}
test('native private unified product transaction crash before/after COMMIT; interrupted dispatch/sender held',async t=>{
 const temp=await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT??tmpdir(),'dsh-run-outbox-test-')),root=join(temp,'private');let j:SQLiteRunOutboxJournal|undefined;
 try{
  try{j=await J.open(root);}catch(e){assert.ok(e instanceof E);assert.equal(e.code,'RUN_OUTBOX_PRIVATE_PATH_UNSAFE');assert.ok(!process.env.DSH_DISCORD_TEST_PRIVATE_PARENT,'configured safe parent must not skip');t.skip('parent is not verifiably private; no durable claim');return;}
  const r=accepted(j),ev=event(r);j.close();j=undefined;
  // Test-only monkeypatches are confined to the owned child. All state changes execute
  // PRODUCT commitTerminal, not handwritten equivalent SQL; no production fault hook.
  const base=`import {DatabaseSync} from 'node:sqlite';const {SQLiteRunOutboxJournal:J}=await import(${JSON.stringify(source.href)});const j=await J.open(${JSON.stringify(root)});`;
  const commit=`j.commitTerminal(${JSON.stringify(r.id)},${r.version},${JSON.stringify(ev)});process.exit(90);`;
  await child(base+`const original=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){const statement=original.call(this,sql);if(sql.startsWith('UPDATE admission_runs SET state=?,terminal=')){const run=statement.run.bind(statement);statement.run=(...args)=>{run(...args);process.exit(71);};}return statement;};`+commit,71);
  j=await J.open(root);assert.equal(j.get(r.id)!.state,'accepted');assert.equal(j.get(r.id)!.terminal,null);j.close();j=undefined;
  await child(base+`const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql==='COMMIT')process.exit(72);return original.call(this,sql);};`+commit,72);
  j=await J.open(root);assert.equal(j.get(r.id)!.state,'accepted');assert.equal(j.get(r.id)!.terminal,null);j.close();j=undefined;
  await child(base+`const original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const value=original.call(this,sql);if(sql==='COMMIT')process.exit(73);return value;};`+commit,73);
  j=await J.open(root);const p=j.commitTerminal(r.id,0,{...ev,notificationRef:'e'.repeat(64)});assert.equal(p.duplicate,true);assert.equal(p.run.state,'completed');assert.equal(p.delivery.state,'pending');assert.equal(p.delivery.metadata.payloadRef,ev.notificationRef);assert.equal(p.run.terminal!.notificationRef,ev.notificationRef);j.close();j=undefined;
  const interruptedScript=base+`const d=j.claimDelivery(${JSON.stringify(p.delivery.id)},0,j.advanceLease(null,${JSON.stringify(fence)}),0);const q=j.enqueue(${JSON.stringify(input('crash-dispatch',{nativeSessionId:'other'}))}).run;j.claim(q.id,0);process.exit(74);`;
  await child(interruptedScript,74);j=await J.open(root);assert.equal(j.getDelivery(p.delivery.id)!.state,'delivery_unknown');const unknown=j.listSession('backend','other')[0]!;assert.equal(unknown.state,'unknown');assert.equal(unknown.receipt,null);assert.throws(()=>j!.claim(unknown.id,unknown.version),code('RUN_OUTBOX_CAS_CONFLICT'));assert.equal(j.get(r.id)!.terminal!.checkpoint,'opaque-checkpoint');
 }finally{j?.close();assert.equal(resolve(temp),temp);await rm(temp,{recursive:true,force:true});}
});
test('native unified cross-table corruption and legacy/schema/overflow refusals preserve bytes',async t=>{
 const temp=await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT??tmpdir(),'dsh-run-outbox-test-')),root=join(temp,'private');let j:SQLiteRunOutboxJournal|undefined;
 try{
  try{j=await J.open(root);}catch(e){assert.ok(e instanceof E);assert.equal(e.code,'RUN_OUTBOX_PRIVATE_PATH_UNSAFE');assert.ok(!process.env.DSH_DISCORD_TEST_PRIVATE_PARENT,'configured safe parent must not skip');t.skip('parent is not verifiably private; no durable claim');return;}
  const r=accepted(j);j.close();j=undefined;const file=join(root,'run-outbox-journal.sqlite');
  // Exactly TWO counters of the same name, with no Outbox counter or terminal.
  // This must be rejected for duplicate identity, not the three-row length guard.
  const duplicateCounter=new DatabaseSync(file);
  assert.deepEqual(duplicateCounter.prepare('SELECT name,seq FROM sqlite_sequence').all().map(v=>({...v})),[{name:'admission_runs',seq:1}]);
  assert.equal(duplicateCounter.prepare('SELECT count(*) AS count FROM outbox_rows').get()!.count,0);
  duplicateCounter.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run('admission_runs',1);
  assert.equal(duplicateCounter.prepare('SELECT count(*) AS count FROM sqlite_sequence').get()!.count,2);duplicateCounter.close();
  const duplicateBefore=await readFile(file);await assert.rejects(J.open(root),code('RUN_OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),duplicateBefore);
  const counterRepair=new DatabaseSync(file);counterRepair.exec("DELETE FROM sqlite_sequence WHERE rowid=(SELECT max(rowid) FROM sqlite_sequence WHERE name='admission_runs')");counterRepair.close();
  j=await J.open(root);assert.deepEqual(j.get(r.id),r);const p=j.commitTerminal(r.id,r.version,event(r));j.close();j=undefined;
  const raw=new DatabaseSync(file),eventRow=raw.prepare('SELECT * FROM terminal_events').get()!,deliveryRow=raw.prepare('SELECT * FROM outbox_rows').get()!;raw.close();
  const cases=[
   ["UPDATE terminal_events SET snapshot='{}'",'UPDATE terminal_events SET snapshot=?',[eventRow.snapshot as string]],
   ["UPDATE terminal_events SET run_id='orphan'",'UPDATE terminal_events SET run_id=?',[r.id]],
   ["UPDATE terminal_events SET scope='bad'",'UPDATE terminal_events SET scope=?',[eventRow.scope as string]],
   ["UPDATE terminal_events SET delivery_id='orphan'",'UPDATE terminal_events SET delivery_id=?',[p.delivery.id]],
   ["UPDATE outbox_rows SET metadata='{}'",'UPDATE outbox_rows SET metadata=?',[deliveryRow.metadata as string]],
   ["UPDATE admission_runs SET terminal=NULL",'UPDATE admission_runs SET terminal=?',[JSON.stringify(event(r))]],
   ["UPDATE admission_runs SET state='accepted'",'UPDATE admission_runs SET state=?',['completed']],
   ["UPDATE admission_runs SET receipt=NULL",'UPDATE admission_runs SET receipt=?',[JSON.stringify(receipt(r))]],
   ["UPDATE admission_runs SET version=2",'UPDATE admission_runs SET version=?',[p.run.version]],
   [`UPDATE outbox_rows SET metadata='${JSON.stringify({...p.delivery.metadata,channelId:'retarget'})}'`,'UPDATE outbox_rows SET metadata=?',[JSON.stringify(p.delivery.metadata)]],
   [`UPDATE admission_runs SET terminal='${JSON.stringify(event(r,{nativeRunIdOrEquivalent:'wrong-run'}))}'`,'UPDATE admission_runs SET terminal=?',[JSON.stringify(event(r))]],
   ['DELETE FROM terminal_events','INSERT INTO terminal_events VALUES (?,?,?,?)',[eventRow.scope as string,r.id,p.delivery.id,eventRow.snapshot as string]],
   ['DELETE FROM outbox_rows','INSERT INTO outbox_rows(sequence,id,event_key,state,version,metadata,fence,failures,next_at,message_id,reason) VALUES (?,?,?,?,?,?,?, ?,?,?,?)',[p.delivery.sequence,p.delivery.id,deliveryRow.event_key as string,'pending',0,deliveryRow.metadata as string,null,0,null,null,null]],
  ] as const;
  for(const [bad,repair,args] of cases){const db=new DatabaseSync(file);db.exec(bad);db.close();const before=await readFile(file);await assert.rejects(J.open(root),code('RUN_OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),before);const fix=new DatabaseSync(file);fix.prepare(repair).run(...args);fix.close();j=await J.open(root);assert.equal(j.get(r.id)!.state,'completed');j.close();j=undefined;}
  j=await J.open(root);j.advanceLease(null,fence);let sent=j.claimDelivery(p.delivery.id,0,fence,0);sent=j.applyDeliveryResult(sent.id,sent.version,fence,{kind:'sent',messageId:'sent-message'},1);assert.equal(sent.version,2);j.close();j=undefined;
  // v1 has no held-state repair: claim/result alternate exactly; success resets failures.
  for(const sql of ['UPDATE outbox_rows SET version=3','UPDATE outbox_rows SET version=22',"UPDATE outbox_rows SET state='sending',version=3,message_id=NULL"]){
   const corruptVersion=new DatabaseSync(file);corruptVersion.exec(sql);corruptVersion.close();const corruptBefore=await readFile(file);await assert.rejects(J.open(root),code('RUN_OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),corruptBefore);
   const repairVersion=new DatabaseSync(file);repairVersion.prepare("UPDATE outbox_rows SET state='sent',version=2,message_id=?").run(sent.messageId);repairVersion.close();j=await J.open(root);assert.deepEqual(j.getDelivery(sent.id),sent);j.close();j=undefined;
  }
  // Product UPDATE executes before Outbox sequence refusal; rollback preserves BOTH.
  j=await J.open(root);const overflow=accepted(j,input('overflow'));j.close();j=undefined;
  const exhausted=new DatabaseSync(file);exhausted.prepare('UPDATE admission_runs SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER-2,overflow.id);exhausted.close();
  j=await J.open(root);const exhaustedBefore=await readFile(file);assert.throws(()=>j!.commitTerminal(overflow.id,Number.MAX_SAFE_INTEGER-2,event(overflow,{eventId:'overflow'})),code('RUN_OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),exhaustedBefore);j.close();j=undefined;
  const restoreVersion=new DatabaseSync(file);restoreVersion.prepare('UPDATE admission_runs SET version=? WHERE id=?').run(overflow.version,overflow.id);restoreVersion.close();
  const limit=new DatabaseSync(file);limit.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='outbox_rows'").run(Number.MAX_SAFE_INTEGER-2);limit.close();j=await J.open(root);const before=await readFile(file);assert.throws(()=>j!.commitTerminal(overflow.id,overflow.version,event(overflow,{eventId:'overflow'})),code('RUN_OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),before);assert.equal(j.get(overflow.id)!.state,'accepted');j.close();j=undefined;
  const fixCounter=new DatabaseSync(file);fixCounter.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='outbox_rows'").run(1);fixCounter.close();
  // Abort an actual PRODUCT transaction between terminal UPDATE and delivery INSERT.
  j=await J.open(root);const trigger=new DatabaseSync(file);trigger.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON outbox_rows BEGIN SELECT RAISE(ABORT,'fixture'); END");trigger.close();const triggerBefore=await readFile(file);assert.throws(()=>j!.commitTerminal(overflow.id,overflow.version,event(overflow,{eventId:'overflow'})),code('RUN_OUTBOX_STORAGE_UNAVAILABLE'));assert.deepEqual(await readFile(file),triggerBefore);assert.equal(j.get(overflow.id)!.terminal,null);const drop=new DatabaseSync(file);drop.exec('DROP TRIGGER reject_delivery');drop.close();j.close();j=undefined;
  const schemaDb=new DatabaseSync(file);schemaDb.exec('CREATE TABLE legacy_private_store (value TEXT)');schemaDb.close();const legacyBefore=await readFile(file);await assert.rejects(J.open(root),code('RUN_OUTBOX_SCHEMA_INCOMPATIBLE'));assert.deepEqual(await readFile(file),legacyBefore);
 }finally{j?.close();assert.equal(resolve(temp),temp);await rm(temp,{recursive:true,force:true});}
});
