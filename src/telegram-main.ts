import { loadTelegramConfig } from './telegram-config.js';
import { Policy } from './policy.js';
import { Store } from './store.js';
import { DshAdapter } from './dsh.js';
import { Engine } from './engine.js';
import { TelegramBot } from './telegram.js';
import { safeError } from './errors.js';
async function main(): Promise<void> {
  const config = await loadTelegramConfig(); const policy = await Policy.create(config);
  const store = new Store(config.databasePath);
  const bot = new TelegramBot(config, new Engine(new DshAdapter(config.dshUrl, config.dshToken), store, policy, [config.token, config.dshToken]));
  let running: Promise<void>; let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => { await bot.stop(); await running.catch(() => {}); store.close(); console.log('[STOPPED] Telegram Bot停止。DSH側の実行は停止していません。'); })();
    return closing;
  };
  running = bot.run();
  const signal = (): void => { void close().catch(error => { console.error(safeError(error)); process.exitCode = 1; }); };
  process.once('SIGINT', signal); process.once('SIGTERM', signal);
  try { await running; }
  catch (error) { if (!closing) throw error; }
  finally { await close(); }
}
void main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
