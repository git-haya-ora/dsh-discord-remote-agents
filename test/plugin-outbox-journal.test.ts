// INTERNAL DESIGN fixtures, never live Discord/DSH integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { OutboxMetadata, OutboxFence, OutboxRow } from '../packages/discord-plugin/outbox-journal.js';
const source = new URL('../../packages/discord-plugin/outbox-journal.js',import.meta.url);
const { SQLiteOutboxJournal: Journal, OutboxJournalError } = await import(source.href) as typeof import('../packages/discord-plugin/outbox-journal.js');
const metadata = (logicalEventKey='event',override:Partial<OutboxMetadata>={}) => ({transport:'discord' as const,botId:'bot',guildId:'guild',channelId:'channel',threadId:null,logicalEventKey,runId:'run',ownerId:'owner',bindingId:'binding',bindingVersion:1,workspaceAlias:'workspace',payloadRef:'a'.repeat(64),payloadDigest:'b'.repeat(64),...override});
const lease = (override:Partial<OutboxFence>={}) => ({botId:'bot',generation:1,leaseEpoch:1,settingsRevision:1,...override});
const code = (expected:string) => (e:unknown) => { assert.ok(e instanceof OutboxJournalError);assert.equal(e.code,expected);assert.equal(e.message,expected);return true; };
test('mock pinned destination metadata dedupe cannot retarget or leak body/ref paths',() => {
  const j=Journal.memoryForTests();try {
    const first=j.enqueue(metadata()).row; assert.ok(Object.isFrozen(first.metadata));assert.equal(j.durable,false);
    assert.deepEqual(j.enqueue(metadata()),{duplicate:true,row:first});
    for (const override of [{payloadRef:'c'.repeat(64)},{payloadDigest:'d'.repeat(64)},{ownerId:'other'},{bindingVersion:2}]) assert.throws(()=>j.enqueue(metadata('event',override)),code('OUTBOX_EVENT_CONFLICT'));
    assert.notEqual(j.enqueue(metadata('event',{channelId:'different'})).row.id,first.id);
    let calls=0;
    for(const value of [{...metadata(),body:'synthetic-private'},{...metadata(),payloadRef:'../private'},{...metadata(),[Symbol('extra')]:true},{...metadata(),get ownerId():string {calls++;throw Error('private');}},new Proxy(metadata(),{ownKeys(){calls++;throw Error('private');}})]) assert.throws(()=>j.enqueue(value),code('OUTBOX_INVALID_INPUT'));
    assert.equal(calls,0);
  }finally{j.close();}
});
test('mock claim/CAS sends exact message ID; fence change holds in-flight with no release',() => {
  const j=Journal.memoryForTests();try{
    const f=j.advanceLease(null,lease());const first=j.enqueue(metadata()).row;
    const sending=j.claim(first.id,0,f,0);
    assert.throws(()=>j.applyResult(first.id,0,f,{kind:'sent',messageId:'message'},1),code('OUTBOX_CAS_CONFLICT'));
    const next=j.advanceLease(f,lease({generation:2,leaseEpoch:2,settingsRevision:2}));
    const held=j.get(first.id)!;assert.equal(held.state,'delivery_unknown');assert.equal(held.reason,'LEASE_CHANGED');
    assert.throws(()=>j.applyResult(first.id,sending.version,f,{kind:'sent',messageId:'message'},1),code('OUTBOX_FENCE_CONFLICT'));
    assert.throws(()=>j.claim(first.id,held.version,next,2),code('OUTBOX_CAS_CONFLICT'));assert.deepEqual(j.get(first.id),held);
    const second=j.enqueue(metadata('second')).row;const current=j.claim(second.id,0,next,2);
    const sent=j.applyResult(second.id,current.version,next,{kind:'sent',messageId:'message'},3);assert.equal(sent.state,'sent');assert.equal(sent.messageId,'message');assert.equal(sent.failures,0);
    assert.throws(()=>j.advanceLease(f,lease({generation:3,leaseEpoch:3})),code('OUTBOX_FENCE_CONFLICT'));
  }finally{j.close();j.close();}
});
test('mock lease snapshots reject accessors/proxies, rollback on invalid monotonic changes, and never transfer Bot',()=>{
  const j=Journal.memoryForTests();try{
    const f=j.advanceLease(null,lease());let calls=0;
    const accessor={...f,get generation():number{calls++;throw Error('private');}};
    for(const bad of [accessor,new Proxy(f,{ownKeys(){calls++;throw Error('private');}}),{...f,extra:true}]) assert.throws(()=>j.advanceLease(bad,lease({leaseEpoch:2})),code('OUTBOX_INVALID_INPUT'));
    for(const next of [lease({generation:0,leaseEpoch:2}),lease({leaseEpoch:1}),lease({leaseEpoch:2,settingsRevision:0}),lease({botId:'other',leaseEpoch:2})]) assert.throws(()=>j.advanceLease(f,next),code('OUTBOX_INVALID_INPUT'));
    assert.equal(calls,0);assert.deepEqual(j.getLease('bot'),f);
    const row=j.enqueue(metadata()).row;
    const other=j.advanceLease(null,lease({botId:'other'}));assert.throws(()=>j.claim(row.id,0,other,0),code('OUTBOX_FENCE_CONFLICT'));assert.deepEqual(j.get(row.id),row);
  }finally{j.close();}
});
test('mock permanent refusal blocked; network/malformed RetryAfter and hostile replies stay unknown',()=>{
  const j=Journal.memoryForTests();try{
    const f=j.advanceLease(null,lease());let calls=0;
    const cases:unknown[]=[{kind:'http',status:401},{kind:'http',status:403},{kind:'http',status:404},undefined,{kind:'network'},...[-1,0,0.5,Infinity,Number.MAX_SAFE_INTEGER].map(retryAfterMs=>({kind:'http',status:429,retryAfterMs})),{kind:'http',status:429},{kind:'sent',get messageId(){calls++;throw Error('private');}},new Proxy({kind:'sent',messageId:'private'},{getOwnPropertyDescriptor(){calls++;throw Error('private');}})];
    cases.forEach((result,i)=>{const row=j.claim(j.enqueue(metadata(String(i))).row.id,0,f,0);const applied=j.applyResult(row.id,row.version,f,result,1);assert.equal(applied.state,i<3?'blocked':'delivery_unknown');assert.throws(()=>j.claim(row.id,applied.version,f,999999),code('OUTBOX_CAS_CONFLICT'));});assert.equal(calls,0);
  }finally{j.close();}
});
test('mock retry deadlines freeze exact 429 >60s and bounded jittered 5xx; tenth failure dead letters',()=>{
  const j=Journal.memoryForTests();try{
    const f=j.advanceLease(null,lease());let row=j.claim(j.enqueue(metadata()).row.id,0,f,0);
    row=j.applyResult(row.id,row.version,f,{kind:'http',status:429,retryAfterMs:65000},100);assert.equal(row.nextAt,65100);assert.equal(row.failures,1);
    assert.throws(()=>j.claim(row.id,row.version,f,65099),code('OUTBOX_NOT_DUE'));assert.deepEqual(j.get(row.id),row);
    for(let failure=2;failure<=10;failure++){
      const now=row.nextAt!;row=j.claim(row.id,row.version,f,now);
      row=j.applyResult(row.id,row.version,f,{kind:'http',status:503},now,1);
      assert.equal(row.failures,failure);
      if(failure<10){assert.equal(row.state,'retry_wait');assert.ok(row.nextAt!-now>=1000&&row.nextAt!-now<=60000);}else{assert.equal(row.state,'dead_letter');assert.equal(row.nextAt,null);}
    }
    assert.throws(()=>j.claim(row.id,row.version,f,900000),code('OUTBOX_CAS_CONFLICT'));
    let overflow=j.claim(j.enqueue(metadata('overflow')).row.id,0,f,0);
    overflow=j.applyResult(overflow.id,overflow.version,f,{kind:'http',status:429,retryAfterMs:10},8640000000000000);assert.equal(overflow.state,'delivery_unknown');
  }finally{j.close();}
});
test('native Outbox private lock/crash/recovery/schema/data byte-refusal; production gate may refuse fixture',async t=>{
  const temp=resolve(await mkdtemp(join(process.env.DSH_DISCORD_TEST_PRIVATE_PARENT??tmpdir(),'dsh-outbox-test-')));assert.ok(basename(temp).startsWith('dsh-outbox-test-'));
  const root=join(temp,'private');let j:import('../packages/discord-plugin/outbox-journal.js').SQLiteOutboxJournal|undefined;
  try{
    try{j=await Journal.open(root);}catch(e){assert.ok(e instanceof OutboxJournalError);assert.equal(e.code,'OUTBOX_PRIVATE_PATH_UNSAFE');t.skip('Production private hierarchy refused; real Outbox durability unverified');return;}
    assert.equal(j.durable,true);const f=j.advanceLease(null,lease());const row=j.enqueue(metadata()).row;
    await assert.rejects(Journal.open(root),code('OUTBOX_WRITER_BUSY'));j.close();j=undefined;
    const script=`import {SQLiteOutboxJournal} from ${JSON.stringify(source.href)};const j=await SQLiteOutboxJournal.open(${JSON.stringify(root)});j.claim(${JSON.stringify(row.id)},0,${JSON.stringify(f)},0);process.exit(0);`;
    await new Promise<void>((done,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});child.once('error',reject);child.once('close',exit=>exit===0?done():reject(Error('OUTBOX_CRASH_FIXTURE_FAILED')));});
    j=await Journal.open(root);const held=j.get(row.id)!;assert.equal(held.state,'delivery_unknown');assert.equal(held.version,2);assert.throws(()=>j!.claim(row.id,held.version,f,10),code('OUTBOX_CAS_CONFLICT'));
    const sentRow=j.claim(j.enqueue(metadata('sent')).row.id,0,f,0);const sent=j.applyResult(sentRow.id,sentRow.version,f,{kind:'sent',messageId:'message'},1);j.close();j=await Journal.open(root);assert.deepEqual(j.get(sent.id),sent);j.close();j=undefined;
    const file=join(root,'outbox-journal.sqlite');
    j=await Journal.open(root);
    let near=j.claim(j.enqueue(metadata('near-version')).row.id,0,f,0);
    near=j.applyResult(near.id,near.version,f,{kind:'http',status:429,retryAfterMs:1},0);
    const pending=j.enqueue(metadata('pending-version')).row;
    j.close();j=undefined;
    const nearDb=new DatabaseSync(file);nearDb.prepare('UPDATE outbox_rows SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER-3,near.id);nearDb.close();
    j=await Journal.open(root);const nearBefore=await readFile(file);
    assert.throws(()=>j!.claim(near.id,Number.MAX_SAFE_INTEGER-3,f,1),code('OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),nearBefore);
    j.close();j=await Journal.open(root);assert.equal(j.get(near.id)!.state,'retry_wait');j.close();j=undefined;
    const pendingDb=new DatabaseSync(file);pendingDb.prepare('UPDATE outbox_rows SET version=1 WHERE id=?').run(pending.id);pendingDb.close();
    const pendingBefore=await readFile(file);await assert.rejects(Journal.open(root),code('OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),pendingBefore);
    const pendingRepair=new DatabaseSync(file);pendingRepair.prepare('UPDATE outbox_rows SET version=0 WHERE id=?').run(pending.id);pendingRepair.close();
    for(const [state,version,failures,messageId,reason] of [['sent',1,0,'message',null],['blocked',1,0,null,'HTTP_401'],['delivery_unknown',1,0,null,'AMBIGUOUS'],['sending',2,1,null,null],['blocked',3,1,null,'HTTP_401'],['delivery_unknown',3,1,null,'AMBIGUOUS']] as const){
      const unreachable=new DatabaseSync(file);unreachable.prepare('UPDATE outbox_rows SET state=?,version=?,failures=?,message_id=?,reason=? WHERE id=?').run(state,version,failures,messageId,reason,row.id);unreachable.close();
      const unreachableBefore=await readFile(file);await assert.rejects(Journal.open(root),code('OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),unreachableBefore);
    }
    const reachableRepair=new DatabaseSync(file);reachableRepair.prepare("UPDATE outbox_rows SET state='delivery_unknown',version=2,failures=0,message_id=NULL,reason='INTERRUPTED' WHERE id=?").run(row.id);reachableRepair.close();
    const sequence=new DatabaseSync(file);sequence.exec(`UPDATE sqlite_sequence SET seq=${Number.MAX_SAFE_INTEGER-2} WHERE name='outbox_rows'`);sequence.close();
    j=await Journal.open(root);const beforeSequence=await readFile(file);assert.throws(()=>j!.enqueue(metadata('fullsequence')),code('OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),beforeSequence);j.close();j=undefined;
    const stateCorrupt=new DatabaseSync(file);stateCorrupt.prepare("UPDATE outbox_rows SET reason='HTTP_401' WHERE id=?").run(sent.id);stateCorrupt.close();
    const stateBefore=await readFile(file);await assert.rejects(Journal.open(root),code('OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),stateBefore);
    const stateRepair=new DatabaseSync(file);stateRepair.prepare('UPDATE outbox_rows SET reason=NULL WHERE id=?').run(sent.id);stateRepair.close();
    const exhausted=new DatabaseSync(file);exhausted.prepare("UPDATE outbox_rows SET state='sending',fence=?,version=?,failures=0,message_id=NULL,reason=NULL WHERE id=?").run(JSON.stringify(f),Number.MAX_SAFE_INTEGER-2,row.id);exhausted.close();
    let before=await readFile(file);await assert.rejects(Journal.open(root),code('OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),before);
    const corrupt=new DatabaseSync(file);corrupt.exec("UPDATE outbox_rows SET version=0,metadata='{}'");corrupt.close();before=await readFile(file);await assert.rejects(Journal.open(root),code('OUTBOX_DATA_INVALID'));assert.deepEqual(await readFile(file),before);
    for(const applicationId of [12345,0]){const foreign=new DatabaseSync(file);foreign.exec(`DROP TABLE IF EXISTS outbox_rows;DROP TABLE IF EXISTS outbox_schema;DROP TABLE IF EXISTS outbox_leases;PRAGMA user_version=0;PRAGMA application_id=${applicationId}`);foreign.close();before=await readFile(file);await assert.rejects(Journal.open(root),code('OUTBOX_SCHEMA_INCOMPATIBLE'));assert.deepEqual(await readFile(file),before);}
  }finally{j?.close();assert.equal(resolve(temp),temp);await rm(temp,{recursive:true,force:true});}
});
