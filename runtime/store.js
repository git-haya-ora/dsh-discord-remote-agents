import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.js';
export const bindingKey = (guildId, channelId, userId) => `${guildId}:${channelId}:${userId}`;
export class Store {
    metadataOnly;
    db;
    bodies = new Map();
    constructor(path, metadataOnly = false) {
        this.metadataOnly = metadataOnly;
        if (metadataOnly && path !== ':memory:' && existsSync(path)) {
            // Never claim, migrate or even configure an existing unmarked database.
            // Read-only validation MUST precede all PRAGMAs/schema writes.
            const stat = lstatSync(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1)
                throw new AppError('PROFILE_CONFLICT', '専用プロファイルのデータベースではありません。');
            let probe;
            try {
                probe = new DatabaseSync(path, { readOnly: true });
                const version = probe.prepare('PRAGMA user_version').get()?.user_version;
                const marker = probe.prepare('SELECT value FROM settings WHERE key=?').get('restricted-storage-profile')?.value;
                if (version !== 1 || marker !== 'single-operator-text-v1')
                    throw new Error('Profile mismatch');
                for (const table of ['runs', 'bindings', 'receipts'])
                    probe.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
            }
            catch {
                throw new AppError('PROFILE_CONFLICT', '既存データベースの専用プロファイルを確認できません。移行は行いません。');
            }
            finally {
                probe?.close();
            }
        }
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        try {
            // One process per database, enforced by SQLite rather than a stale PID file.
            this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT;');
            const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
            if (version !== 0 && version !== 1)
                throw new AppError('DB_VERSION', 'このデータベースは未対応バージョンです。');
            this.db.exec(`CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, user_id TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(session_id) WHERE state IN ('dispatching','accepted','running','unknown');
        PRAGMA user_version=1;`);
        }
        catch (error) {
            this.db.close();
            if (error instanceof AppError)
                throw error;
            throw new AppError('DB_UNAVAILABLE', 'データベースを開けません。同じBotの二重起動やファイル権限を確認してください。');
        }
    }
    close() { this.bodies.clear(); if (this.db.isOpen)
        this.db.close(); }
    encode(run) {
        if (!this.metadataOnly)
            return JSON.stringify(run);
        // Host restricted profile: no prompt, assistant or notification body reaches SQLite.
        // Native history is the only durable body source. Disk carries correlation/intent only.
        if (run.bodyMissing)
            this.bodies.delete(run.id);
        else
            this.bodies.set(run.id, { output: run.output, result: run.result, finalText: run.finalText });
        return JSON.stringify({ ...run, output: '', result: '', finalText: undefined, bodyMissing: true });
    }
    allRuns() { return this.db.prepare('SELECT payload FROM runs ORDER BY rowid').all().map(row => this.decode(row)); }
    compareSetting(key, previous, value) {
        if (previous === undefined)
            return this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(key, value).changes === 1;
        return this.db.prepare('UPDATE settings SET value=? WHERE key=? AND value=?').run(value, key, previous).changes === 1;
    }
    setting(key) {
        const value = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
        return typeof value === 'string' ? value : undefined;
    }
    clearSetting(key) { this.db.prepare('DELETE FROM settings WHERE key=?').run(key); }
    setSetting(key, value) {
        this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    }
    claimReceipt(key) {
        return this.db.prepare('INSERT OR IGNORE INTO receipts(key) VALUES (?)').run(key).changes === 1;
    }
    binding(key) {
        const value = this.db.prepare('SELECT session_id FROM bindings WHERE key=?').get(key)?.session_id;
        return typeof value === 'string' ? value : undefined;
    }
    bindingVersion(key) {
        const raw = this.setting(`binding-version:${key}`) ?? '0';
        const value = Number(raw);
        if (!/^(0|[1-9][0-9]*)$/u.test(raw) || !Number.isSafeInteger(value))
            throw new AppError('DB_CORRUPT', 'Binding versionを確認できません。');
        return value;
    }
    bind(key, sessionId, expectedVersion, unique = false) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const version = this.bindingVersion(key);
            if (version === Number.MAX_SAFE_INTEGER)
                throw new AppError('BINDING_VERSION_EXHAUSTED', 'Binding version上限です。記録を保全してください。');
            if (expectedVersion !== undefined && version !== expectedVersion)
                throw new AppError('BINDING_CONFLICT', '選択が変更されました。再確認してください。');
            if (unique && this.db.prepare('SELECT key FROM bindings WHERE session_id=? AND key<>? LIMIT 1').get(sessionId, key))
                throw new AppError('SESSION_BOUND', 'このSessionは別の会話で選択されています。先に明示解除してください。');
            this.db.prepare('INSERT INTO bindings(key,session_id) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET session_id=excluded.session_id').run(key, sessionId);
            this.setSetting(`binding-version:${key}`, String(this.bindingVersion(key) + 1));
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    unbind(key, expectedVersion) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const version = this.bindingVersion(key);
            if (version === Number.MAX_SAFE_INTEGER)
                throw new AppError('BINDING_VERSION_EXHAUSTED', 'Binding version上限です。記録を保全してください。');
            if (expectedVersion !== undefined && version !== expectedVersion)
                throw new AppError('BINDING_CONFLICT', '選択が変更されました。再確認してください。');
            this.db.prepare('DELETE FROM bindings WHERE key=?').run(key);
            this.setSetting(`binding-version:${key}`, String(this.bindingVersion(key) + 1));
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    get(id) { return this.decode(this.db.prepare('SELECT payload FROM runs WHERE id=?').get(id)); }
    decode(row) {
        if (!row)
            return undefined;
        try {
            const run = JSON.parse(String(row.payload));
            if (this.metadataOnly) {
                const body = this.bodies.get(run.id);
                if (body) {
                    run.output = body.output;
                    run.result = body.result;
                    run.finalText = body.finalText;
                    delete run.bodyMissing;
                }
                else {
                    run.output = '';
                    run.result = '';
                    delete run.finalText;
                    run.bodyMissing = true;
                }
            }
            return run;
        }
        catch {
            throw new AppError('DB_CORRUPT', '実行履歴を読み込めません。データベースを保全してください。');
        }
    }
    create(run) {
        try {
            this.db.prepare('INSERT INTO runs(id,session_id,state,user_id,payload) VALUES (?,?,?,?,?)').run(run.id, run.sessionId, run.state, run.userId, this.encode(run));
        }
        catch {
            throw new AppError('RUN_BUSY', '同じセッションに未確定の実行があります。/agent statusで確認してください。');
        }
    }
    save(run) {
        const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(run.id);
        const current = row ? JSON.parse(String(row.payload)) : undefined;
        const revision = current?.revision ?? 0;
        if (!Number.isSafeInteger(revision) || revision < 0)
            throw new AppError('DB_CORRUPT', 'Run revisionを確認できません。');
        if (!current || revision !== (run.revision ?? 0))
            throw new AppError('RUN_REVISION_CONFLICT', '実行情報が更新されました。再確認してください。');
        if (revision === Number.MAX_SAFE_INTEGER)
            throw new AppError('RUN_VERSION_EXHAUSTED', 'Run revision上限です。記録を保全してください。');
        run.revision = revision + 1;
        this.db.prepare('UPDATE runs SET state=?,payload=? WHERE id=?').run(run.state, this.encode(run), run.id);
    }
    active() {
        return this.db.prepare("SELECT payload FROM runs WHERE state IN ('dispatching','accepted','running','unknown') ORDER BY rowid").all().map(row => this.decode(row));
    }
    pendingNotifications(now = Date.now()) {
        return this.db.prepare("SELECT payload FROM runs WHERE state IN ('succeeded','failed','interrupted') ORDER BY rowid").all()
            .map(row => this.decode(row)).filter(run => run.notification === 'pending' && run.nextNotifyAt <= now);
    }
    latest(userId, guildId, channelId) {
        return this.db.prepare('SELECT payload FROM runs WHERE user_id=? ORDER BY rowid DESC').all(userId)
            .map(row => this.decode(row)).find(run => run.guildId === guildId && run.channelId === channelId);
    }
    recoverDispatches() {
        for (const run of this.allRuns()) {
            if (run.delivery) {
                let changed = false;
                for (const part of run.delivery.parts)
                    if (part.state === 'sending') {
                        part.state = 'unknown';
                        part.lastError = 'RESTART_DURING_DELIVERY';
                        changed = true;
                    }
                if (changed) {
                    run.notification = 'unknown';
                    run.lastError = 'NOTIFICATION_UNKNOWN';
                    this.save(run);
                }
            }
            if (run.state === 'dispatching') {
                run.state = 'unknown';
                run.lastError = 'RESTART_DURING_DISPATCH';
                run.updatedAt = Date.now();
                this.save(run);
            }
        }
    }
}
//# sourceMappingURL=store.js.map