import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// tsc does not copy the dependency-free JS bundle; exercise the shipped source.
const bundleUrl = new URL('../../packages/discord-plugin/index.js', import.meta.url);
const { apply, FoundationHost, inject } = await import(bundleUrl.href) as typeof import('../packages/discord-plugin/index.js');
import type { ManagementRequest, SecretUpdate } from '../packages/discord-plugin/contracts.js';

test('bundle uses documented patch and pinned self-contained Host dependencies', async () => {
  const root = new URL('../../packages/discord-plugin/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.deepEqual(inject, ['connection', 'sessionController']);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.exports['.'].default, './index.js');
  assert.deepEqual(manifest.dependencies, { 'discord.js': '14.27.0' });
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.name, 'dsh-discord-remote-agents');
  assert.equal(manifest.private, true);
  assert.equal(Object.hasOwn(manifest, 'publishConfig'), false);
  const installManifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(installManifest.private, true);
  assert.equal(Object.hasOwn(installManifest, 'publishConfig'), false);
  assert.deepEqual(installManifest.dsh, manifest.dsh);
  assert.deepEqual(installManifest.exports, manifest.exports);
  assert.match(await readFile(new URL('cordis.patch.yml', root), 'utf8'), /name: 'dsh-discord-remote-agents'/);
});
test('unconfigured foundation never starts receivers or declares unverified capabilities', () => {
  const status = new FoundationHost().status();
  assert.equal(status.state, 'unconfigured');
  assert.equal(status.receiverStarted, false);
  assert.equal(status.nativeRunsTouched, false);
  assert.equal(status.compatibility, 'unverified');
  assert.ok(Object.values(status.capabilities).every(value => value.supported === false));
  assert.ok(Object.isFrozen(status.capabilities));
});
test('unknown activation config fails closed without retaining or disclosing input', () => {
  for (const config of [null, [], 'invalid', { autoStart: true }, { token: 'synthetic-not-a-credential' }]) {
    const status = new FoundationHost(config).status();
    assert.equal(status.state, 'blocked');
    assert.equal(status.receiverStarted, false);
    assert.ok(!JSON.stringify(status).includes('synthetic-not-a-credential'));
  }
});
test('management operations reject without authority; no mock authority grants success', async () => {
  const host = new FoundationHost();
  const update: SecretUpdate = { action: 'keep' };
  const requests: ManagementRequest[] = [
    ...(['status', 'diagnose', 'start', 'stop', 'reconnect'] as const).map(operation => ({ operation })),
    { operation: 'updateSecret', update },
    { operation: 'migrate', confirmed: true, legacyReceiverStopped: true, preserveOwnersAndDestinations: true }
  ];
  for (const request of requests) assert.deepEqual(await host.dispatch(request), { ok: false, code: 'MANAGEMENT_AUTHORIZATION_UNAVAILABLE' });
});
test('Cordis effects own management RPC and idempotent disposal with blocked invalid config', async () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  let calls = 0;
  let handler: Parameters<Parameters<typeof apply>[0]['connection']['rpc']['handle']>[1] | undefined;
  const ctx = {
    effect(factory: () => (() => void) | (() => Promise<void>)) { cleanups.push(factory()); },
    connection: { rpc: { handle(channel: string, callback: Parameters<Parameters<typeof apply>[0]['connection']['rpc']['handle']>[1]) {
      assert.equal(arguments.length, 2);
      assert.equal(channel, '/discord-remote-agents');
      handler = callback;
      calls++; return () => { calls--; };
    } } },
    sessionController: {
      list() { throw new Error('Native should not run'); }, create() { throw new Error('Native should not run'); },
      page() { throw new Error('Native should not run'); }, projections() { throw new Error('Native should not run'); }, prompt() { throw new Error('Native should not run'); }
    }
  };
  apply(ctx, { dataRoot: 'relative-invalid' });
  assert.equal(calls, 1); assert.equal(cleanups.length, 2);
  assert.ok(handler);
  assert.deepEqual(await handler('not-manage', { operation: 'status' }, new AbortController().signal, {}), { ok: false, code: 'INVALID_REQUEST' });
  assert.equal((await handler('manage', { operation: 'status' }, new AbortController().signal, {})).ok, true);
  assert.deepEqual(await handler('status', 'manage', new AbortController().signal, {}), { ok: false, code: 'INVALID_REQUEST' });
  for (const cleanup of cleanups) await cleanup();
  assert.equal(calls, 0); await cleanups[1]!();
  const host = new FoundationHost();
  await host.dispose(); await host.dispose();
  assert.equal(host.status().state, 'disposed');
  assert.deepEqual(await host.dispatch({ operation: 'start' }), { ok: false, code: 'DISPOSED' });
});
