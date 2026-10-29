import test from 'node:test';
import assert from 'node:assert/strict';
import { Events, type ChatInputCommandInteraction } from 'discord.js';
import { DiscordBot } from '../src/bot.js';
import { AppError } from '../src/errors.js';
import type { Config } from '../src/config.js';
import type { Engine } from '../src/engine.js';

function fixture(options: { deny?: boolean; deferFails?: boolean; editFails?: boolean; handlerFails?: boolean } = {}) {
  const calls: string[] = [];
  const engine = {
    policy: { authorize() { if (options.deny) throw new AppError('NOT_AUTHORIZED', 'denied'); } },
    async contextMetrics() { return undefined; },
    async tick() { calls.push('tick'); }
  } as unknown as Engine;
  const bot = new DiscordBot({ guildId: 'guild', pollIntervalMs: 1000 } as Config, engine);
  const interaction = {
    user: { id: 'user', bot: false }, guildId: 'guild', channelId: 'channel', commandName: 'agent',
    options: { getSubcommandGroup: () => options.handlerFails ? null : 'context', getSubcommand: () => options.handlerFails ? 'history' : 'show' },
    async reply() { calls.push('reply'); },
    async deferReply() { calls.push('defer'); if (options.deferFails) throw new Error('ambiguous'); },
    async editReply() { calls.push('edit'); if (options.editFails) throw new Error('ambiguous'); }
  };
  const handle = () => (bot as unknown as { handle(i: ChatInputCommandInteraction): Promise<void> }).handle(interaction as unknown as ChatInputCommandInteraction);
  return { bot, interaction, calls, handle };
}

test('authorization denial sends one reply without deferral', async () => {
  const f = fixture({ deny: true }); await f.handle(); assert.deepEqual(f.calls, ['reply']); await f.bot.stop();
});

test('ambiguous defer never sends a second acknowledgement', async () => {
  const f = fixture({ deferFails: true }); await f.handle(); assert.deepEqual(f.calls, ['defer']); await f.bot.stop();
});

test('handler failure sends exactly one edit', async () => {
  const f = fixture({ handlerFails: true, editFails: true }); await f.handle(); assert.deepEqual(f.calls, ['defer', 'edit']); await f.bot.stop();
});

test('ambiguous result edit is not retried', async () => {
  const f = fixture({ editFails: true }); await f.handle(); assert.deepEqual(f.calls, ['defer', 'edit']); await f.bot.stop();
});

test('stopping while deferral is pending prevents handler execution', async () => {
  const f = fixture(); let release!: () => void;
  f.interaction.deferReply = async () => { f.calls.push('defer'); await new Promise<void>(resolve => { release = resolve; }); };
  const task = f.handle(); const stop = f.bot.stop(); release(); await task; await stop;
  assert.deepEqual(f.calls, ['defer']);
});

test('ready after stop does not start the polling timer', async () => {
  const f = fixture(); await f.bot.stop();
  f.bot.client.emit(Events.ClientReady, f.bot.client as never);
  assert.deepEqual(f.calls, []);
  assert.equal((f.bot as unknown as { timer?: NodeJS.Timeout }).timer, undefined);
});
