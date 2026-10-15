import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { command } from './commands.js';
import { AppError, safeError } from './errors.js';
async function register(): Promise<void> {
  const config = await loadConfig();
  try {
    // Create/upsert only our command; never bulk-overwrite another application's commands.
    await new REST({ version: '10' }).setToken(config.token).post(
      Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: command.toJSON() });
  } catch { throw new AppError('COMMAND_REGISTER_FAILED', 'コマンドを登録できません。Application ID、Botトークン、サーバーへの招待を確認してください。'); }
  console.log('[REGISTERED] 設定サーバーに/agentを登録しました。');
}
void register().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
