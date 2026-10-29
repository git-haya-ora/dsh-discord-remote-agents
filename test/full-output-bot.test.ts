import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordBot } from '../src/bot.js';
import { AppError } from '../src/errors.js';
import type { Config } from '../src/config.js';
import type { Engine } from '../src/engine.js';
import type { Run } from '../src/types.js';

for (const destination of ['dm', 'origin'] as const) test(`transport rechecks actor after awaited ${destination} lookup; no network send on revoked authorization`, async () => {
  let authorized = true; let sends = 0;
  const engine = { policy: { authorize() { if (!authorized) throw new AppError('NOT_AUTHORIZED', 'revoked'); } } } as unknown as Engine;
  const bot = new DiscordBot({ guildId: 'guild' } as Config, engine, undefined, true);
  const run = { id: 'run', userId: 'user', guildId: 'guild', channelId: 'channel',
    delivery: { destination, userId: 'user', guildId: 'guild', channelId: 'channel' } } as Run;
  const send = async () => { sends++; return { id: 'never' }; };
  if (destination === 'dm') Object.defineProperty(bot.client.users, 'fetch', { value: async () => { authorized = false; return { createDM: async () => ({ send }) }; } });
  else Object.defineProperty(bot.client.channels, 'fetch', { value: async () => { authorized = false; return { isSendable: () => true, guildId: 'guild', send }; } });
  await assert.rejects(bot.notify(run, { index: 1, content: 'PRIVATE_FINAL' }), { code: 'NOT_AUTHORIZED' });
  assert.equal(sends, 0); await bot.client.destroy();
});

for (const action of ['stop', 'revoke'] as const) test(`terminal notice cannot send after ${action} during createDM`, async () => {
  let authorized = true, sends = 0;
  const engine = { policy: { authorize() { if (!authorized) throw new AppError('NOT_AUTHORIZED', 'revoked'); } } } as unknown as Engine;
  const bot = new DiscordBot({ guildId: 'guild' } as Config, engine, undefined, true);
  Object.defineProperty(bot.client, 'destroy', { configurable: true, value: async () => {} });
  let release!: (channel: { send(): Promise<{ id: string }> }) => void; let started!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  const dm = new Promise<{ send(): Promise<{ id: string }> }>(resolve => { release = resolve; });
  Object.defineProperty(bot.client.users, 'fetch', { value: async () => ({ createDM: () => { started(); return dm; } }) });
  const run = { id: 'run', userId: 'user', guildId: 'guild', channelId: 'channel' } as Run;
  const notice = bot.notify(run, { index: 1, content: 'PRIVATE_FINAL' }); const result = notice.then(() => undefined, error => error);
  await opening;
  if (action === 'stop') {
    let deadline: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([bot.stop().then(() => true), new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 250); })]);
    if (deadline) clearTimeout(deadline); assert.equal(stopped, true);
  } else authorized = false;
  release({ send: async () => { sends++; return { id: 'receipt' }; } });
  assert.equal((await result as AppError).code, action === 'stop' ? 'DELIVERY_BLOCKED' : 'NOT_AUTHORIZED');
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(sends, 0); await bot.stop();
});

test('transport sends complete part with mention/embed suppression and returns receipt ID', async () => {
  let options: Record<string, unknown> | undefined;
  const engine = { policy: { authorize() {} } } as unknown as Engine;
  const bot = new DiscordBot({ guildId: 'guild' } as Config, engine, undefined, true);
  Object.defineProperty(bot.client.users, 'fetch', { value: async () => ({ createDM: async () => ({ send: async (payload: Record<string, unknown>) => { options = payload; return { id: 'receipt' }; } }) }) });
  const run = { id: 'run', userId: 'user', guildId: 'guild', channelId: 'channel' } as Run;
  const content = 'run · part 1/1\n日本語😀 @everyone https://example.invalid';
  assert.deepEqual(await bot.notify(run, { index: 1, content }), { messageId: 'receipt' });
  assert.equal(options!.content, content); assert.deepEqual(options!.allowedMentions, { parse: [] });
  assert.equal(options!.flags, 4); assert.deepEqual(options!.files, []); assert.equal(options!.enforceNonce, true);
  await bot.client.destroy();
});
