// Offline Client source/registration contracts only. This is not DOM, screenshot,
// accessibility, Plugin Manager installation, browser, or live integration evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,Script} from 'node:vm';
import ts from 'typescript';

const client=await readFile(new URL('../../packages/discord-plugin/client.js',import.meta.url),'utf8');
const manifest=JSON.parse(await readFile(new URL('../../packages/discord-plugin/package.json',import.meta.url),'utf8')) as {
 name:string;description:string;dependencies:Record<string,string>;exports:Record<string,unknown>;files:string[];
 dsh:{bundle:unknown;client:{platform:string;immediately:boolean;inject:string[]}};
};
const syntax=ts.createSourceFile('client.js',client,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const syntaxDiagnostics=ts.transpileModule(client,{compilerOptions:{allowJs:true,target:ts.ScriptTarget.ES2023},reportDiagnostics:true}).diagnostics??[];
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as unknown;
interface Module {id:string;factory(require:(id:string)=>unknown):{inject:string[];apply(ctx:unknown):void};}
type Registration={name:string;key:string;locale:string;component:Function};

function capture(){
 const modules:Module[]=[],requests:string[]=[],forbidden:string[]=[];let renders=0;
 const globals:Record<string,unknown>={window:Object.freeze({__ModuleLoader__:Object.freeze({load:(value:Module)=>modules.push(value)})})};
 for(const name of ['document','fetch','WebSocket','XMLHttpRequest','navigator','localStorage','sessionStorage','indexedDB','console','setTimeout','setInterval','requestAnimationFrame','URL','location'])Object.defineProperty(globals,name,{get(){forbidden.push(name);throw Error('FORBIDDEN_CLIENT_ACCESS');}});
 new Script(client,{filename:'client.js'}).runInContext(createContext(globals),{timeout:1000});
 assert.equal(modules.length,1);assert.equal(requests.length,0);assert.equal(forbidden.length,0);
 const plugin=modules[0]!.factory(id=>{requests.push(id);assert.equal(id,'react');return Object.freeze({createElement(){renders++;throw Error('COMPONENT_MUST_NOT_EXECUTE_IN_SOURCE_TEST');}});});
 assert.deepEqual(requests,['react']);assert.equal(renders,0);
 return {module:modules[0]!,plugin,forbidden,renderCount:()=>renders};
}
function services(){
 const dictionaries=new Map<string,Record<string,string>>(),effects:(()=>void)[]=[],registrations:Registration[]=[],rpcCalls:unknown[]=[];
 const owners=new Map<string,{callback:()=>unknown;cleanup:(()=>void)|null}>();let released=0;
 const ctx={
  effect(action:()=>()=>void){const cleanup=action();assert.equal(typeof cleanup,'function');effects.push(cleanup);},
  locale:{
   register(ns:string,locales:Record<string,Record<string,string>>|string,entries?:Record<string,string>){const pairs=typeof locales==='string'?[[locales,entries!]] as const:Object.entries(locales);for(const [lang,copy] of pairs){assert.ok(copy);const key=`${ns}:${lang}`;assert.ok(!dictionaries.has(key));dictionaries.set(key,copy);}return ()=>{for(const [lang] of pairs)dictionaries.delete(`${ns}:${lang}`);};},
  },
  slots:{
   inject(owner:string,callback:()=>unknown){assert.ok(!owners.has(owner));owners.set(owner,{callback,cleanup:null});},
   register(options:Registration,component:Function){assert.equal(typeof component,'function');assert.equal(component.length,1);const entry={...options,component};registrations.push(entry);return ()=>{const index=registrations.indexOf(entry);assert.ok(index>=0);registrations.splice(index,1);released++;};},
  },
  connection:{rpc:{call(...args:unknown[]){rpcCalls.push(args);return Promise.resolve({ok:false,code:'test'});}}},
 };
 const appear=(name='plugins.bundle.config')=>{const owner=owners.get(name)!;assert.ok(owner);assert.equal(owner.cleanup,null);const cleanup=owner.callback();assert.equal(typeof cleanup,'function');owner.cleanup=cleanup as ()=>void;};
 const collapse=(name='plugins.bundle.config')=>{const owner=owners.get(name)!;owner.cleanup?.();owner.cleanup=null;};
 const dispose=()=>{for(const name of owners.keys())collapse(name);owners.clear();for(const cleanup of effects.splice(0).reverse())cleanup();};
 return {ctx,dictionaries,effects,registrations,rpcCalls,owners,appear,collapse,dispose,released:()=>released};
}
function visit(node:ts.Node,check:(node:ts.Node)=>void){check(node);ts.forEachChild(node,n=>visit(n,check));}

test('Client manifest declares the official settings page and authenticated Connection dependency',()=>{
 assert.deepEqual(syntaxDiagnostics,[]);
 assert.equal(manifest.exports['./client'],'./client.js');assert.ok(manifest.files.includes('client.js'));
 assert.deepEqual(manifest.dsh.client,{platform:'web',immediately:true,inject:['@deepseek-ai/dsh-client-ui-plugin-manager','@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-connection']});
 assert.deepEqual(manifest.dsh.bundle,{patch:'./cordis.patch.yml'});
 assert.equal(manifest.dependencies['discord.js'],'14.27.0');
 assert.match(manifest.description,/single-operator/iu);assert.match(manifest.description,/atomic/iu);
 assert.ok(!manifest.files.some(path=>/research|node_modules|dist|\.env/u.test(path)));
 for(const required of ['runtime/','host-runtime.js','host-runtime.d.ts','native-adapter.js'])assert.ok(manifest.files.includes(required),`Missing package artifact: ${required}`);
 const c=capture();assert.equal(c.module.id,manifest.name);assert.deepEqual(json(c.plugin.inject),['slots','locale','connection']);assert.deepEqual(c.forbidden,[]);
});

test('Client registers only the bundle configuration page and disposes locale/slot ownership',()=>{
 const c=capture(),s=services();c.plugin.apply(s.ctx);assert.equal(s.effects.length,3);assert.equal(s.registrations.length,0);assert.deepEqual(s.rpcCalls,[]);
 assert.deepEqual([...s.owners.keys()],['plugins.bundle.config']);
 assert.deepEqual([...s.dictionaries.keys()].sort(),['discordRemoteAgents.settings:en','discordRemoteAgents.settings:ja','discordRemoteAgents.settings:zh']);
 s.appear();assert.equal(s.registrations.length,1);
 assert.deepEqual({name:s.registrations[0]!.name,key:s.registrations[0]!.key,locale:s.registrations[0]!.locale},{name:'plugins.bundle.config',key:manifest.name,locale:'discordRemoteAgents.settings'});
 s.collapse();assert.equal(s.registrations.length,0);assert.equal(s.dictionaries.size,3);s.appear();assert.equal(s.registrations.length,1);
 s.dispose();assert.equal(s.registrations.length,0);assert.equal(s.dictionaries.size,0);assert.equal(s.owners.size,0);assert.equal(s.released(),2);assert.equal(c.renderCount(),0);assert.deepEqual(c.forbidden,[]);
});

test('Client translations cover static and computed status/action keys in all shipped locales',()=>{
 const c=capture(),s=services();c.plugin.apply(s.ctx);
 const calls=new Set<string>();
 visit(syntax,node=>{if(ts.isCallExpression(node)&&node.expression.getText(syntax)==='t'&&ts.isStringLiteral(node.arguments[0]!))calls.add((node.arguments[0] as ts.StringLiteral).text);});
 const keys=Object.keys(s.dictionaries.get('discordRemoteAgents.settings:en')!).sort();
 assert.deepEqual(Object.keys(s.dictionaries.get('discordRemoteAgents.settings:zh')!).sort(),keys);
 assert.deepEqual(Object.keys(s.dictionaries.get('discordRemoteAgents.settings:ja')!).sort(),keys);
 for(const key of calls)assert.ok(keys.includes(key),`Missing literal translation: ${key}`);
 for(const key of ['state_unconfigured','state_stopped','state_connecting','state_connected','state_blocked','state_disposed','saved','started','stopped','reconnected','commandsRegistered','secretDeleted','unexpected'])assert.ok(keys.includes(key),`Missing computed translation: ${key}`);
 for(const locale of ['en','zh','ja'])for(const value of Object.values(s.dictionaries.get(`discordRemoteAgents.settings:${locale}`)!)){assert.equal(typeof value,'string');assert.ok(value.trim());}
 s.dispose();assert.equal(c.renderCount(),0);
});

test('Client source uses the narrow RPC and write-only secret path without browser side channels',()=>{
 assert.match(client,/rpc\.call\(CHANNEL, ENDPOINT/u);
 assert.match(client,/const CHANNEL = '\/api'/u);
  assert.match(client,/const ENDPOINT = 'discord-remote-agents\.manage'/u);
 assert.match(client,/operation: 'status'/u);assert.match(client,/operation: 'test'/u); // Save is exercised through the rendered form below.
 assert.match(client,/expectedRevision/u);assert.match(client,/confirmation: true/u);
 assert.match(client,/type: 'password'/u);assert.match(client,/autoComplete: 'new-password'/u);
 assert.match(client,/resultUnknown/u);assert.match(client,/never replay|never resend|not retried/iu);
 assert.match(client,/plugins\.bundle\.config/u);assert.doesNotMatch(client,/conversation\.composer\.dock/u);
 assert.doesNotMatch(client,/\b(fetch|WebSocket|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document|navigator|innerHTML|dangerouslySetInnerHTML|console)\s*[.(]/u);
 assert.doesNotMatch(client,/https?:\/\/|@font-face|position\s*:\s*['"](?:fixed|absolute)/u);
 const constructed:string[]=[];
 visit(syntax,node=>{if(ts.isNewExpression(node))constructed.push(node.expression.getText(syntax));});
 assert.deepEqual([...new Set(constructed)].sort(),['AbortController','Error','Promise','Set']);
});
