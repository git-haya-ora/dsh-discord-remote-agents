import { loadConfig } from './config.js';
import { loadTelegramConfig } from './telegram-config.js';
import { Policy } from './policy.js';
import { Store } from './store.js';
import { DshAdapter } from './dsh.js';
import { Engine } from './engine.js';
import { DiscordBot } from './bot.js';
import { TelegramBot } from './telegram.js';
import { AppError, safeError } from './errors.js';
async function main(): Promise<void> {
  const discordConfig = await loadConfig(); const telegramConfig = await loadTelegramConfig();
  if (discordConfig.databasePath !== telegramConfig.databasePath) throw new AppError('CONFIG_INVALID', '同時起動は両設定のdatabasePathを同じパスにしてください。実行排他を共有します。');
  const policy = Policy.combine([await Policy.create(discordConfig), await Policy.create(telegramConfig)]);
  const store = new Store(discordConfig.databasePath);
  const engine = new Engine(new DshAdapter(discordConfig.dshUrl, discordConfig.dshToken), store, policy, [discordConfig.token, telegramConfig.token, discordConfig.dshToken]);
  const telegram = new TelegramBot(telegramConfig, engine);
  const discord: DiscordBot = new DiscordBot(discordConfig, engine, run => run.guildId === 'telegram' ? telegram.notify(run) : discord.notify(run));
  let running: Promise<void[]>; let tasks: Promise<void>[]; let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => { await Promise.all([discord.stop(), telegram.stop()]); await Promise.allSettled(tasks); store.close(); console.log('[STOPPED] 両Bot停止。DSH側の実行は停止していません。'); })();
    return closing;
  };
  tasks = [discord.start(), telegram.run(false)]; running = Promise.all(tasks);
  const signal = (): void => { void close().catch(error => { console.error(safeError(error)); process.exitCode = 1; }); };
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  try { await running; }
  catch (error) { if (!closing) throw error; }
  finally { await close(); }
}
void main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
