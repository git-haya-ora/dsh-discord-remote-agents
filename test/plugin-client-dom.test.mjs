// Offline integration: actual React 18 + DOM events; no live DSH or Discord calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.invalid' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const source = await readFile(process.env.DRA_CLIENT_TEST_SOURCE || new URL('../packages/discord-plugin/client.js', import.meta.url), 'utf8');
const savedStatus = () => ({ profile: 'single-operator-text-v1', revision: 2, state: 'stopped', tokenConfigured: true,
  settings: { guildId: '11111111111111111', applicationId: '22222222222222222', allowedUserIds: ['33333333333333333'], allowedChannelIds: ['44444444444444444'], workspaces: {}, autoStart: false }, capabilities: {} });
const freshStatus = () => ({ ...savedStatus(), revision: 1, state: 'unconfigured', tokenConfigured: false, settings: null });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
async function fixture(t, { configured = false, initialStatus } = {}) {
  const calls = [];
  let module, Page;
  new Script(source).runInContext(createContext({ AbortController, setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(value) { module = value; } } } }));
  module.factory(name => { assert.equal(name, 'react'); return React; }).apply({
    effect(action) { action(); }, locale: { register() { return () => {}; } },
    slots: { inject(_name, action) { action(); }, register(_options, value) { Page = value; return () => {}; } },
    connection: { rpc: { async call(_channel, _endpoint, request) {
      calls.push(request);
      const value = request.operation === 'status' ? await (initialStatus || (configured ? savedStatus() : freshStatus()))
        : request.operation === 'test' ? { botName: 'Fixture Bot', botId: '22222222222222222' } : savedStatus();
      return { ok: true, value: { ok: true, value } };
    } } },
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => { root.render(React.createElement(Page, { t: key => key, view: 'page' })); await flush(); });
  const input = id => { const el = container.querySelector('#dra-' + id); assert.ok(el, id); return el; };
  const autofill = value => {
    // Bypass React's value tracker just like an external password manager.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input('token'), value);
  };
  const change = async (id, value) => act(async () => {
    const el = input(id);
    Object.getOwnPropertyDescriptor((el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement).prototype, 'value').set.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true })); await flush();
  });
  const click = async label => act(async () => {
    const button = [...container.querySelectorAll('button')].find(el => el.textContent === label); assert.ok(button, label);
    assert.equal(button.disabled, false, label + ' enabled'); button.click(); await flush();
  });
  const submit = async () => act(async () => {
    container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush();
  });
  const fillSettings = async () => {
    for (const [key, value] of Object.entries({ guildId: '11111111111111111', applicationId: '22222222222222222', allowedUserIds: '33333333333333333', allowedChannelIds: '44444444444444444' })) await change(key, value);
  };
  return { container, input, autofill, change, click, submit, fillSettings, calls };
}

test('native token input -> optional test -> first save keeps the same candidate', async t => {
  const f = await fixture(t); await f.fillSettings(); await f.change('token', 'synthetic-only');
  await f.click('testToken'); assert.equal(f.input('token').value, 'synthetic-only');
  await f.click('save');
  assert.deepEqual(f.calls.map(call => call.operation), ['status', 'test', 'save']);
  assert.equal(f.calls[1].token, 'synthetic-only'); assert.equal(f.calls[2].token, 'synthetic-only');
  assert.equal(f.input('token').value, '');
});

test('DOM-only autofill survives unrelated React renders before first save', async t => {
  const f = await fixture(t); await f.fillSettings(); f.autofill('synthetic-autofill');
  await f.change('guildId', '55555555555555555');
  assert.equal(f.input('token').value, 'synthetic-autofill');
  await f.submit(); assert.equal(f.calls.at(-1).operation, 'save');
  assert.equal(f.calls.at(-1).token, 'synthetic-autofill'); assert.equal(f.input('token').value, '');
});

for (const configured of [false, true]) test(`Test captures DOM-only candidate, configured=${configured}`, async t => {
  const f = await fixture(t, { configured }); if (!configured) await f.fillSettings();
  f.autofill('synthetic-replacement'); await f.click('testToken');
  assert.equal(f.calls.at(-1).operation, 'test'); assert.equal(f.calls.at(-1).token, 'synthetic-replacement');
  assert.equal(f.input('token').value, 'synthetic-replacement');
  await f.submit(); assert.equal(f.calls.at(-1).token, 'synthetic-replacement');
  assert.equal(f.input('token').value, '');
});

test('late initial status does not wipe a DOM-only candidate', async t => {
  let resolveStatus;
  const initialStatus = new Promise(resolve => { resolveStatus = resolve; });
  const f = await fixture(t, { initialStatus }); f.autofill('synthetic-during-load');
  await act(async () => { resolveStatus(freshStatus()); await flush(); });
  assert.equal(f.input('token').value, 'synthetic-during-load');
  await f.fillSettings(); await f.submit(); assert.equal(f.calls.at(-1).token, 'synthetic-during-load');
});

test('discard clears the live candidate; empty first Test does not call Host', async t => {
  const f = await fixture(t); await f.click('testToken'); assert.equal(f.calls.length, 1);
  await f.change('token', 'synthetic-discard'); await f.click('discard');
  assert.equal(f.input('token').value, ''); assert.equal(f.calls.length, 1);
});
