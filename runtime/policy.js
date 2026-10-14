import { realpath, stat } from 'node:fs/promises';
import { normalize } from 'node:path';
import { AppError } from './errors.js';
export class Policy {
    config;
    paths = new Set();
    realms;
    static combine(policies) {
        const first = policies[0];
        if (!first || new Set(policies.map(p => p.config.guildId)).size !== policies.length)
            throw new AppError('CONFIG_INVALID', '操作元の許可設定が重複しています。');
        const combined = new Policy(first.config);
        combined.paths = first.paths;
        combined.realms = new Map(policies.map(p => [p.config.guildId, p]));
        return combined;
    }
    scope(guildId) {
        if (!this.realms)
            return this;
        const policy = this.realms.get(guildId ?? this.config.guildId);
        if (!policy)
            throw new AppError('NOT_AUTHORIZED', 'この操作元では利用できません。');
        return policy;
    }
    constructor(config) {
        this.config = config;
    }
    static async create(config) {
        const policy = new Policy(config);
        try {
            for (const path of Object.values(config.workspaces))
                policy.paths.add(await policy.directoryKey(path));
        }
        catch {
            throw new AppError('CONFIG_INVALID', '許可作業フォルダーが存在しません。絶対パスを確認してください。');
        }
        return policy;
    }
    canonical(path) { const p = normalize(path); return process.platform === 'win32' ? p.toLowerCase() : p; }
    async directoryKey(path) {
        const actual = await realpath(path);
        const info = await stat(actual, { bigint: true });
        if (!info.isDirectory())
            throw new Error('not a directory');
        // Identity prevents case-folded collisions in Windows case-sensitive directories.
        return `${this.canonical(actual)}|${info.dev}:${info.ino}`;
    }
    authorize(userId, guildId, channelId) {
        if (this.realms) {
            this.scope(guildId ?? '').authorize(userId, guildId, channelId);
            return;
        }
        if (guildId !== this.config.guildId || !channelId || !this.config.allowedChannelIds.has(channelId) || !this.config.allowedUserIds.has(userId)) {
            throw new AppError('NOT_AUTHORIZED', 'このユーザー・サーバー・チャンネルでは操作できません。');
        }
    }
    stillAuthorized(userId, guildId, channelId) {
        try {
            this.authorize(userId, guildId, channelId);
            return true;
        }
        catch {
            return false;
        }
    }
    async allowsCwd(cwd, guildId) {
        if (this.realms)
            return this.scope(guildId).allowsCwd(cwd);
        if (!cwd || (guildId !== undefined && guildId !== this.config.guildId))
            return false;
        try {
            return this.paths.has(await this.directoryKey(cwd));
        }
        catch {
            return false;
        }
    }
    async requireCwd(cwd, guildId) {
        if (!await this.allowsCwd(cwd, guildId))
            throw new AppError('WORKSPACE_FORBIDDEN', 'このセッションの作業フォルダーは許可されていません。');
    }
    workspace(name, guildId) {
        if (this.realms)
            return this.scope(guildId).workspace(name);
        if (guildId !== undefined && guildId !== this.config.guildId)
            throw new AppError('NOT_AUTHORIZED', 'この操作元では利用できません。');
        const cwd = Object.hasOwn(this.config.workspaces, name) ? this.config.workspaces[name] : undefined;
        if (!cwd)
            throw new AppError('WORKSPACE_FORBIDDEN', '設定済みの作業フォルダー別名を指定してください。');
        return cwd;
    }
}
//# sourceMappingURL=policy.js.map