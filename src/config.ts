import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { AppError } from './errors.js';
export interface Config {
  token: string; applicationId: string; guildId: string;
  allowedUserIds: Set<string>; allowedChannelIds: Set<string>;
  workspaces: Record<string, string>; dshUrl: string; dshToken: string;
  pollIntervalMs: number; databasePath: string;
}
export function validateLocalUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('CONFIG_INVALID', 'DSH_URLが不正です。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AppError('CONFIG_INVALID', 'DSH_URLはトークンを含まないローカルHTTPルートURLにしてください。');
  }
  return url.origin;
}
const isSnowflake = (x: unknown): x is string => typeof x === 'string' && /^\d{17,20}$/.test(x);
function ids(x: unknown, name: string): Set<string> {
  if (!Array.isArray(x) || !x.length || !x.every(isSnowflake)) throw new AppError('CONFIG_INVALID', `${name}にDiscordのIDを設定してください。`);
  return new Set(x);
}
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(resolve(env.BOT_CONFIG ?? 'config.json'), 'utf8')); }
  catch { throw new AppError('CONFIG_INVALID', '設定JSONを読み込めません。config.example.jsonから作成してください。'); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('CONFIG_INVALID', '設定はJSONオブジェクトにしてください。');
  const obj = raw as Record<string, unknown>;
  if (!isSnowflake(obj.guildId) || !isSnowflake(env.DISCORD_APPLICATION_ID)) throw new AppError('CONFIG_INVALID', 'guildIdとDISCORD_APPLICATION_IDを設定してください。');
  if (!env.DISCORD_BOT_TOKEN?.trim() || !env.DSH_TOKEN?.trim()) throw new AppError('CONFIG_INVALID', 'DISCORD_BOT_TOKENとDSH_TOKENを設定してください。');
  const input = obj.allowedWorkspaces;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw new AppError('CONFIG_INVALID', 'allowedWorkspacesに許可作業フォルダーを設定してください。');
  const workspaces: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, path] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name) || typeof path !== 'string' || !isAbsolute(path)) throw new AppError('CONFIG_INVALID', '作業フォルダーは短い別名と絶対パスで指定してください。');
    workspaces[name] = path;
  }
  const interval = obj.pollIntervalMs ?? 5000;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 2000 || interval > 60000) throw new AppError('CONFIG_INVALID', 'pollIntervalMsは2000〜60000の整数です。');
  if (obj.databasePath !== undefined && (typeof obj.databasePath !== 'string' || !obj.databasePath.trim())) throw new AppError('CONFIG_INVALID', 'databasePathが不正です。');
  return {
    token: env.DISCORD_BOT_TOKEN.trim(), applicationId: env.DISCORD_APPLICATION_ID,
    guildId: obj.guildId, allowedUserIds: ids(obj.allowedUserIds, 'allowedUserIds'),
    allowedChannelIds: ids(obj.allowedChannelIds, 'allowedChannelIds'), workspaces,
    dshUrl: validateLocalUrl(env.DSH_URL ?? 'http://127.0.0.1:19387'), dshToken: env.DSH_TOKEN.trim(),
    pollIntervalMs: interval, databasePath: resolve(typeof obj.databasePath === 'string' ? obj.databasePath : 'data/bot.sqlite')
  };
}
