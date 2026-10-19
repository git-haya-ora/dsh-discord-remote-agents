import { realpath, stat } from 'node:fs/promises';
import { normalize, isAbsolute } from 'node:path';
import type { Config } from './config.js';
import { AppError } from './errors.js';
export class Policy {
  private paths = new Set<string>();
  private realms: Map<string, Policy> | undefined;
  static combine(policies: Policy[]): Policy {
    const first = policies[0];
    if (!first || new Set(policies.map(p => p.config.guildId)).size !== policies.length) throw new AppError('CONFIG_INVALID', '操作元の許可設定が重複しています。');
    const combined = new Policy(first.config); combined.paths = first.paths;
    combined.realms = new Map(policies.map(p => [p.config.guildId, p])); return combined;
  }
  private scope(guildId?: string): Policy {
    if (!this.realms) return this;
    const policy = this.realms.get(guildId ?? this.config.guildId);
    if (!policy) throw new AppError('NOT_AUTHORIZED', 'この操作元では利用できません。');
    return policy;
  }
  private constructor(private readonly config: Config) {}
  static async create(config: Config): Promise<Policy> {
    const policy = new Policy(config);
    try { for (const path of Object.values(config.workspaces)) policy.paths.add(await policy.directoryKey(path)); }
    catch { throw new AppError('CONFIG_INVALID', '許可作業フォルダーが存在しません。絶対パスを確認してください。'); }
    return policy;
  }
  private canonical(path: string): string { const p = normalize(path); return process.platform === 'win32' ? p.toLowerCase() : p; }
  private async directoryKey(path: string): Promise<string> {
    const actual = await realpath(path);
    const info = await stat(actual, { bigint: true });
    if (!info.isDirectory()) throw new Error('not a directory');
    // Identity prevents case-folded collisions in Windows case-sensitive directories.
    return `${this.canonical(actual)}|${info.dev}:${info.ino}`;
  }
  authorize(userId: string, guildId: string | null, channelId: string | null): void {
    if (this.realms) { this.scope(guildId ?? '').authorize(userId, guildId, channelId); return; }
    if (guildId !== this.config.guildId || !channelId || !this.config.allowedChannelIds.has(channelId) || !this.config.allowedUserIds.has(userId)) {
      throw new AppError('NOT_AUTHORIZED', 'このユーザー・サーバー・チャンネルでは操作できません。');
    }
  }
  stillAuthorized(userId: string, guildId: string, channelId: string): boolean {
    try { this.authorize(userId, guildId, channelId); return true; } catch { return false; }
  }
  async allowsCwd(cwd: string | undefined, guildId?: string): Promise<boolean> {
    if (this.realms) return this.scope(guildId).allowsCwd(cwd);
    if (!cwd || (guildId !== undefined && guildId !== this.config.guildId)) return false;
    try { return this.paths.has(await this.directoryKey(cwd)); } catch { return false; }
  }
  async requireCwd(cwd: string | undefined, guildId?: string): Promise<void> {
    if (!await this.allowsCwd(cwd, guildId)) throw new AppError('WORKSPACE_FORBIDDEN', 'このセッションの作業フォルダーは許可されていません。');
  }
  async addWorkspace(name: string, path: string, guildId: string, persist: () => void): Promise<void> {
    if (this.realms) return this.scope(guildId).addWorkspace(name, path, guildId, persist);
    if (guildId !== this.config.guildId) throw new AppError('NOT_AUTHORIZED', 'この操作元では利用できません。');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name) || typeof path !== 'string' || !isAbsolute(path) || path.length > 1024 || /[\0\r\n]/.test(path)) throw new AppError('WORKSPACE_INVALID', '別名と、このPCの既存フォルダーの絶対パスを指定してください。');
    if (Object.hasOwn(this.config.workspaces, name) || Object.keys(this.config.workspaces).length >= 32) throw new AppError('WORKSPACE_CONFLICT', '別名は上書きできません。新しい別名を指定してください（最大32件）。');
    let key: string;
    try { key = await this.directoryKey(path); } catch { throw new AppError('WORKSPACE_INVALID', '既存の作業フォルダーを指定してください。'); }
    if (Object.hasOwn(this.config.workspaces, name) || Object.keys(this.config.workspaces).length >= 32) throw new AppError('WORKSPACE_CONFLICT', '作業フォルダーの登録が競合しました。');
    // Persist and reauthorize synchronously after the filesystem await, before granting access.
    persist();
    Object.defineProperty(this.config.workspaces, name, { value: path, enumerable: true, configurable: true, writable: true });
    this.paths.add(key);
  }
  workspace(name: string, guildId?: string): string {
    if (this.realms) return this.scope(guildId).workspace(name);
    if (guildId !== undefined && guildId !== this.config.guildId) throw new AppError('NOT_AUTHORIZED', 'この操作元では利用できません。');
    const cwd = Object.hasOwn(this.config.workspaces, name) ? this.config.workspaces[name] : undefined;
    if (!cwd) throw new AppError('WORKSPACE_FORBIDDEN', '設定済みの作業フォルダー別名を指定してください。');
    return cwd;
  }
}
