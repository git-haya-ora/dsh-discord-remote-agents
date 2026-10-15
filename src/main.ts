import { loadConfig } from './config.js';
import { Policy } from './policy.js';
import { Store } from './store.js';
import { DshAdapter } from './dsh.js';
import { Engine } from './engine.js';
import { DiscordBot } from './bot.js';
import { safeError } from './errors.js';
async function main(): Promise<void> {
  const config = await loadConfig(); const policy = await Policy.create(config);
  const store = new Store(config.databasePath);
  const adapter = new DshAdapter(config.dshUrl, config.dshToken);
  // Avoid requiring DSH to be online at every restart: durable runs reconcile once it returns.
  const bot = new DiscordBot(config, new Engine(adapter, store, policy, [config.token, config.dshToken]));
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return; closing = true;
    await bot.stop(); store.close(); console.log('[STOPPED] Bot停止。DSH側の実行は停止していません。');
  };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  try { await bot.start(); }
  catch (error) { await close(); throw error; }
}
void main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
