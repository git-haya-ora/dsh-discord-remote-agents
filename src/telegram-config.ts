import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Config } from './config.js';
import { validateLocalUrl } from './config.js';
import { AppError } from './errors.js';
export function telegramId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 2 ** 52;
}
export function validateTelegramToken(value: string): string {
  if (!/^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,}$/.test(value) || !telegramId(Number(value.split(':')[0]))) {
    throw new AppError('CONFIG_INVALID', 'TELEGRAM_BOT_TOKENにBotFatherのトークンを設定してください。');
  }
  return value;
}
function ids(input: unknown, name: string): Set<string> {
  if (!Array.isArray(input) || !input.length || !input.every(x => typeof x === 'string' && /^[1-9]\d{0,15}$/.test(x) && telegramId(Number(x)))) {
    throw new AppError('CONFIG_INVALID', `${name}にTelegramの正の数値IDを文字列で設定してください。グループは利用できません。`);
  }
  return new Set(input as string[]);
}
export async function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(resolve(env.TELEGRAM_CONFIG ?? 'telegram.config.json'), 'utf8')); }
  catch { throw new AppError('CONFIG_INVALID', 'Telegram設定JSONを読み込めません。telegram.config.example.jsonから作成してください。'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('CONFIG_INVALID', 'Telegram設定はJSONオブジェクトにしてください。');
  const obj = raw as Record<string, unknown>; const workspaces: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!obj.allowedWorkspaces || typeof obj.allowedWorkspaces !== 'object' || Array.isArray(obj.allowedWorkspaces) || !Object.keys(obj.allowedWorkspaces).length) throw new AppError('CONFIG_INVALID', 'allowedWorkspacesを設定してください。');
  for (const [name, path] of Object.entries(obj.allowedWorkspaces)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name) || typeof path !== 'string' || !isAbsolute(path)) throw new AppError('CONFIG_INVALID', '作業フォルダーは短い別名と絶対パスで指定してください。');
    workspaces[name] = path;
  }
  const interval = obj.pollIntervalMs ?? 5000;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 2000 || interval > 60000) throw new AppError('CONFIG_INVALID', 'pollIntervalMsは2000〜60000の整数です。');
  if (obj.databasePath !== undefined && (typeof obj.databasePath !== 'string' || !obj.databasePath.trim())) throw new AppError('CONFIG_INVALID', 'databasePathが不正です。');
  if (!env.DSH_TOKEN?.trim()) throw new AppError('CONFIG_INVALID', 'DSH_TOKENを設定してください。');
  const token = validateTelegramToken(env.TELEGRAM_BOT_TOKEN?.trim() ?? '');
  return { token, applicationId: token.split(':')[0]!, guildId: 'telegram',
    allowedUserIds: ids(obj.allowedUserIds, 'allowedUserIds'), allowedChannelIds: ids(obj.allowedChatIds, 'allowedChatIds'), workspaces,
    dshUrl: validateLocalUrl(env.DSH_URL ?? 'http://127.0.0.1:19387'), dshToken: env.DSH_TOKEN.trim(),
    pollIntervalMs: interval, databasePath: resolve(typeof obj.databasePath === 'string' ? obj.databasePath : 'data/bot.sqlite') };
}
