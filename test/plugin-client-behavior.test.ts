// Offline Hook-runtime behavior fixture; not React DOM, visual, or live DSH proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
const source = await readFile(new URL('../../packages/discord-plugin/client.js', import.meta.url), 'utf8');
type Node = { type: unknown; props: Record<string, any>; children: any[] };
function harness(call: (...args: any[]) => Promise<any>) {
  const values: any[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = [];
  let cursor = 0, component: any, tree: Node, module: any;
  const React = {
    createElement(type: unknown, props: any, ...children: any[]): Node { return { type, props: props ?? {}, children }; },
    useState(initial: any) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], (next: any) => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
    useRef(initial: any) { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; },
    useEffect(action: () => () => void) { const i = cursor++; if (!(i in values)) { values[i] = true; effects.push(() => cleanups.push(action())); } },
  };
  new Script(source).runInContext(createContext({ AbortController, window: { __ModuleLoader__: { load(value: any) { module = value; } } } }));
  const ctx = { effect(action: any) { action(); }, locale: { register() { return () => {}; } }, connection: { rpc: { async call(...args: any[]) { return { ok: true, value: await call(...args) }; } } }, slots: { inject(_name: string, action: any) { action(); }, register(_options: any, value: any) { component = value; return () => {}; } } };
  module.factory(() => React).apply(ctx);
  function render() { cursor = 0; tree = component({ t: (key: string) => key, view: 'page' }); for (const effect of effects.splice(0)) effect(); return tree; }
  function all(node: any = tree): Node[] { return node && typeof node === 'object' && 'type' in node ? [node, ...node.children.flat(Infinity).flatMap((child: any) => all(child))] : []; }
  const id = (name: string) => { const node = all().find(node => node.props.id === name); assert.ok(node, name); return node; };
  const button = (key: string) => { const node = all().find(node => node.type === 'button' && node.children.includes(key)); assert.ok(node, key); return node; };
  const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); render(); };
  render();
  return { render, all, id, button, settle, unmount() { for (const cleanup of cleanups) cleanup(); } };
}
const status = (revision = 1, autoStart = false) => ({ profile: 'single-operator-text-v1', revision, state: 'stopped', tokenConfigured: true, settings: { guildId: '11111111111111111', applicationId: '22222222222222222', allowedUserIds: ['33333333333333333'], allowedChannelIds: ['44444444444444444'], workspaces: { main: 'C:\\Work' }, autoStart }, capabilities: {} });
test('Japanese delivery warning does not label a connected receiver as failed or disable settings', async () => {
  const h = harness(async () => ({ ok: true, value: { ...status(), state: 'connected', lastError: 'CONNECTION_NOTICE_UNCONFIRMED' } })); await h.settle();
  h.id('dra-language').props.onChange({ target: { value: 'ja' } }); h.render();
  assert.ok(h.all().some(n => n.children.some((text: unknown) => typeof text === 'string' && text.includes('接続通知の送達を確認できません'))));
  assert.equal(h.button('設定を保存').props.disabled, false); h.unmount();
});
test('connection notices are opt-in, independent, and saved only through explicit settings submission', async () => {
  const calls: any[] = []; const h = harness(async (...args) => { calls.push(args[2]); return { ok: true, value: status() }; }); await h.settle();
  assert.equal(h.id('dra-connection-dm').props.checked, false); assert.equal(h.id('dra-connection-channels').props.checked, false);
  h.id('dra-connection-dm').props.onChange({ target: { checked: true } }); h.render();
  h.id('dra-connection-channels').props.onChange({ target: { checked: true } }); h.render();
  assert.equal(calls.length, 1); h.all().find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.equal(calls[1].operation, 'save'); assert.equal(calls[1].settings.connectionNotifications.dm, true); assert.equal(calls[1].settings.connectionNotifications.channels, true);
  assert.equal(calls[1].token, undefined); h.unmount();
});
test('Japanese page selection translates actions without RPC, persistence, or losing unsaved fields', async () => {
  const calls: any[] = [];
  const h = harness(async (...args) => { calls.push(args[2]); return { ok: true, value: status() }; });
  await h.settle();
  h.id('dra-token').props.onChange({ target: { value: 'synthetic-input-only' } }); h.render();
  h.id('dra-language').props.onChange({ target: { value: 'ja' } }); h.render();
  assert.ok(h.all().some(n => n.children.includes('DiscordからDSHを使う')));
  assert.equal(h.button('設定を保存').props.disabled, false);
  assert.equal(h.id('dra-token').props.value, 'synthetic-input-only');
  assert.deepEqual(calls.map(r => r.operation), ['status']);
  h.id('dra-language').props.onChange({ target: { value: '__proto__' } }); h.render();
  assert.equal(h.id('dra-language').props.value, 'ja');
  h.id('dra-language').props.onChange({ target: { value: 'system' } }); h.render();
  assert.ok(h.all().some(n => n.children.includes('title')));
  assert.equal(calls.length, 1); h.unmount();
});
test('empty workspace row saves an empty allowlist and does not block connection setup', async () => {
  const calls: any[] = [];
  const empty = { ...status(), settings: { ...status().settings, workspaces: {} } };
  const h = harness(async (...args) => { calls.push(args[2]); return { ok: true, value: empty }; });
  await h.settle();
  assert.equal(h.id('dra-workspace-0-alias').props.value, '');
  assert.equal(h.id('dra-workspace-0-path').props.value, '');
  h.all().find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} });
  await h.settle();
  assert.equal(calls[1].operation, 'save');
  assert.equal(Object.keys(calls[1].settings.workspaces).length, 0);
  h.unmount();
});

test('rendered settings consent and save send revision, write-only token, and prototype-safe aliases', async () => {
  const calls: any[][] = [];
  const h = harness(async (...args) => { calls.push(args); return { ok: true, value: status(calls.length) }; });
  await h.settle();
  h.id('dra-auto-start').props.onChange({ target: { checked: true } }); h.render();
  assert.equal(h.id('dra-confirm-auto-start').props.checked, false);
  const submit = () => h.all().find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} });
  submit(); await h.settle(); assert.equal(calls.length, 1);
  h.id('dra-confirm-auto-start').props.onChange({ target: { checked: true } });
  h.id('dra-workspace-0-alias').props.onChange({ target: { value: '__proto__' } });
  h.id('dra-token').props.onChange({ target: { value: 'synthetic-input-only' } }); h.render();
  submit(); h.render(); assert.equal(h.id('dra-token').props.value, ''); await h.settle();
  assert.equal(calls.length, 2); const [channel, endpoint, request, signal] = calls[1]!;
  assert.equal(channel, '/api'); assert.equal(endpoint, 'discord-remote-agents.manage'); assert.ok(signal instanceof AbortSignal);
  assert.equal(request.operation, 'save'); assert.equal(request.expectedRevision, 1); assert.equal(request.settings.autoStart, true);
  assert.equal(request.token, 'synthetic-input-only'); assert.equal(Object.getPrototypeOf(request.settings.workspaces), null);
  assert.equal(request.settings.workspaces.__proto__, 'C:\\Work'); h.unmount();
});
test('malformed mutation status and failed safe refresh never display success or permit mutation', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; if (calls === 1) return { ok: true, value: status() }; if (calls === 2) return { ok: true, value: { profile: 'single-operator-text-v1', tokenConfigured: true } }; throw Error('offline'); });
  await h.settle(); h.id('dra-confirm-exclusive').props.onChange({ target: { checked: true } }); h.render();
  h.button('start').props.onClick(); await h.settle();
  assert.equal(calls, 4); // mutation plus safe refresh and one catch-path status refresh, never mutation replay
  assert.ok(!h.all().some(n => n.props['data-kind'] === 'success'));
  assert.ok(h.all().some(n => n.children.includes('resultUnknown'))); assert.equal(h.button('start').props.disabled, true); h.unmount();
});
for (const operation of ['refresh', 'start'] as const) test(`unmount aborts pending ${operation} even after initial load`, async () => {
  let pendingSignal: AbortSignal | undefined, resolve: ((value: any) => void) | undefined, calls = 0;
  const h = harness(async (...args) => { calls++; if (calls === 1) return { ok: true, value: status() }; pendingSignal = args[3]; return await new Promise(done => { resolve = done; }); });
  await h.settle();
  if (operation === 'start') { h.id('dra-confirm-exclusive').props.onChange({ target: { checked: true } }); h.render(); }
  h.button(operation).props.onClick(); assert.ok(pendingSignal); assert.equal(pendingSignal.aborted, false);
  h.unmount(); assert.equal(pendingSignal.aborted, true); resolve!({ ok: true, value: status(2) }); await h.settle(); assert.equal(calls, 2);
});

 test('setup order, native folds, and a single primary action follow saved state', async () => {
 const h = harness(async () => ({ ok: true, value: status() })); await h.settle();
 const headings = h.all().filter(n => n.type === 'h3').map(n => n.children[0]);
 assert.ok(headings.indexOf('stepSave') < headings.indexOf('stepCommands')); assert.ok(headings.indexOf('stepCommands') < headings.indexOf('stepStart'));
 assert.ok(h.all().filter(n => n.type === 'details').length >= 4); assert.ok(h.all().filter(n => n.type === 'details').every(n => !n.props.open));
 assert.equal(h.all().filter(n => n.type === 'button' && n.props['data-kind'] === 'primary').length, 1);
 h.id('dra-token').props.onChange({ target: { value: 'synthetic-only' } }); h.render();
 assert.equal(h.button('save').props['data-kind'], 'primary'); assert.equal(h.button('start').props['data-kind'], undefined); h.unmount();
 });
 test('dirty settings and entered token block saved-config actions until explicit discard', async () => {
 const calls: any[] = []; const h = harness(async (...args) => { calls.push(args[2]); return { ok: true, value: { ...status(), state: 'connected' } }; }); await h.settle();
 h.id('dra-confirm-commands').props.onChange({ target: { checked: true } }); h.id('dra-confirm-exclusive').props.onChange({ target: { checked: true } }); h.id('dra-token').props.onChange({ target: { value: 'synthetic-only' } }); h.render();
 for (const key of ['start', 'registerCommands', 'reconnect']) { assert.equal(h.button(key).props.disabled, true); h.button(key).props.onClick(); }
 await h.settle(); assert.equal(calls.length, 1); assert.equal(h.id('dra-token').props.value, 'synthetic-only');
 h.button('discard').props.onClick(); h.render(); assert.equal(h.id('dra-token').props.value, '');
 h.id('dra-confirm-exclusive').props.onChange({ target: { checked: true } }); h.render(); h.button('reconnect').props.onClick(); await h.settle();
 assert.equal(calls[1].confirmation, true); assert.equal(calls[1].expectedRevision, 1); assert.equal(h.id('dra-confirm-exclusive').props.checked, false); h.unmount();
 });
 test('first-save errors appear at required fields without sending token or settings', async () => {
 let calls = 0; const h = harness(async () => { calls++; return { ok: true, value: { ...status(), tokenConfigured: false, settings: { autoStart: false } } }; }); await h.settle();
 h.all().find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} }); h.render();
 for (const id of ['dra-guildId', 'dra-applicationId', 'dra-allowedUserIds', 'dra-allowedChannelIds', 'dra-token']) assert.equal(h.id(id).props['aria-invalid'], true);
 assert.ok(!h.all().some(n => n.children.includes('requiredWorkspace'))); assert.equal(calls, 1); h.unmount();
 });
 test('multiple workspace rows and multiple allowed IDs round-trip without alias parsing', async () => {
 const calls: any[] = []; const settings = { ...status().settings, workspaces: JSON.parse('{"__proto__":"C:\\\\One","second_name":"D:\\\\Two"}'), allowedUserIds: ['33333333333333333', '55555555555555555'], allowedChannelIds: ['44444444444444444', '66666666666666666'] };
 const h = harness(async (...args) => { calls.push(args[2]); return { ok: true, value: { ...status(), settings } }; }); await h.settle();
 assert.equal(h.id('dra-workspace-1-alias').props.value, 'second_name');
 h.all().find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} }); await h.settle();
 assert.equal(Object.getPrototypeOf(calls[1].settings.workspaces), null); assert.equal(calls[1].settings.workspaces['second_name'], 'D:\\Two');
 assert.deepEqual(Array.from(calls[1].settings.allowedUserIds), ['33333333333333333', '55555555555555555']); assert.deepEqual(Array.from(calls[1].settings.allowedChannelIds), ['44444444444444444', '66666666666666666']); h.unmount();
 });
 for (const operation of ['save', 'test', 'deleteSecret', 'registerCommands', 'reconnect'] as const) test(`pending ${operation} is aborted on unmount; secret submissions clear immediately`, async () => {
 let signal: AbortSignal | undefined, calls = 0; const h = harness(async (...args) => { calls++; if (calls === 1) return { ok: true, value: { ...status(), state: 'connected' } }; signal = args[3]; return await new Promise(() => {}); }); await h.settle();
 if (operation === 'save' || operation === 'test') { h.id('dra-token').props.onChange({ target: { value: 'synthetic-only' } }); h.render(); }
 if (operation === 'save') h.all().find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} });
 else { if (operation === 'deleteSecret') h.id('dra-confirm-delete').props.onChange({ target: { checked: true } }); if (operation === 'registerCommands') h.id('dra-confirm-commands').props.onChange({ target: { checked: true } }); if (operation === 'reconnect') h.id('dra-confirm-exclusive').props.onChange({ target: { checked: true } }); h.render(); h.button(operation === 'test' ? 'testToken' : operation).props.onClick(); }
 h.render(); assert.ok(signal); if (operation === 'save' || operation === 'test') assert.equal(h.id('dra-token').props.value, ''); h.unmount(); assert.equal(signal.aborted, true); assert.equal(calls, 2);
 });

test('fresh Host null settings can save without optional token testing', async () => {
  const calls: any[] = [];
  const h = harness(async (...args) => { calls.push(args[2]); return { ok: true, value: calls.length === 1 ? { ...status(), state: 'unconfigured', tokenConfigured: false, settings: null } : status(2) }; });
  await h.settle();
  assert.equal(h.button('save').props.disabled, false);
  assert.equal(h.id('dra-workspace-0-alias').props.value, '');
  for (const [key, value] of Object.entries({ guildId: '11111111111111111', applicationId: '22222222222222222', allowedUserIds: '33333333333333333', allowedChannelIds: '44444444444444444', token: 'synthetic-only' })) h.id(`dra-${key}`).props.onChange({ target: { value } });
  h.render(); // First setup deliberately leaves both optional folder fields blank.
  h.all().find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} }); await h.settle();
  assert.deepEqual(calls.map(r => r.operation), ['status', 'save']);
  assert.equal(h.id('dra-token').props.value, ''); h.unmount();
});
for (const [field, value] of [
  ['guildId', '123'],
  ['allowedUserIds', '33333333333333333\n33333333333333333'],
  ['allowedChannelIds', Array.from({ length: 101 }, (_, i) => '7' + String(i).padStart(16, '0')).join('\n')],
  ['workspace-0-alias', 'invalid=name'], ['workspace-0-path', 'relative-folder'],
] as const) test(`invalid ${field} stays local without submitting the secret`, async () => {
  let calls = 0; const h = harness(async () => { calls++; return { ok: true, value: status() }; }); await h.settle();
  h.id(`dra-${field}`).props.onChange({ target: { value } }); h.id('dra-token').props.onChange({ target: { value: 'synthetic-only' } }); h.render();
  h.all().find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} }); h.render();
  assert.equal(calls, 1); assert.equal(h.id('dra-token').props.value, 'synthetic-only');
  assert.equal(h.id(`dra-${field}`).props['aria-invalid'], true); h.unmount();
});
