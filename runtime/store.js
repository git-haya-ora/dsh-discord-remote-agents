import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, lstatSync, openSync, closeSync, fstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.js';
import { terminal } from './types.js';
export const MAX_PROTECTED_STORAGE_BYTES = 128 * 1024 * 1024;
export const MAX_ACTIVE_RUN_METADATA_RESERVE = 64 * 1024;
export const PROTECTED_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const bindingKey = (guildId, channelId, userId) => `${guildId}:${channelId}:${userId}`;
function validOutputContext(context) {
    const identifier = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
    return !!context && context.profile === 'local-bridge-output-v1' && context.transport === 'discord'
        && identifier(context.applicationId, 64) && identifier(context.botId, 64) && identifier(context.nativeSessionId)
        && identifier(context.bridgeRunId, 128) && identifier(context.clientRequestId, 256)
        && /^[a-f0-9]{64}$/u.test(context.promptDigest) && (context.observedTurn === null || Number.isSafeInteger(context.observedTurn) && context.observedTurn >= 0)
        && Number.isSafeInteger(context.bridgeStartSeq) && context.bridgeStartSeq >= 0 && Number.isSafeInteger(context.lastObservedSeq) && context.lastObservedSeq >= context.bridgeStartSeq
        && ['native-turn', 'bridge-rejection'].includes(context.completionSource) && ['succeeded', 'failed', 'interrupted'].includes(context.terminalState)
        && identifier(context.ownerId, 128) && identifier(context.guildId, 128) && identifier(context.channelId, 128) && context.threadId === null
        && ['actor', 'shared'].includes(context.bindingMode) && identifier(context.bindingId, 512)
        && context.bindingId === bindingKey(context.guildId, context.channelId, context.bindingMode === 'shared' ? 'shared' : context.ownerId)
        && Number.isSafeInteger(context.bindingVersion) && context.bindingVersion >= 0 && ['dm', 'origin'].includes(context.destination)
        && (context.preRedactionDigest === null || /^[a-f0-9]{64}$/u.test(context.preRedactionDigest))
        && /^[a-f0-9]{64}$/u.test(context.redactedBodyDigest) && /^[a-f0-9]{64}$/u.test(context.deliveryPlanDigest)
        && ['body', 'part'].includes(context.itemKind) && Number.isSafeInteger(context.itemIndex) && context.itemIndex >= 0
        && Number.isSafeInteger(context.itemCount) && context.itemCount > 0 && context.itemIndex < context.itemCount && /^[a-f0-9]{64}$/u.test(context.itemDigest);
}
function outputScopeKey(context) {
    const { itemKind: _kind, itemIndex: _index, itemCount: _count, itemDigest: _digest, ...scope } = context;
    return JSON.stringify(scope);
}
function validCompactIntent(intent) {
    const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
    if (!intent || intent.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(intent.intentId) || !text(intent.sessionId) || !text(intent.agentId)
        || !text(intent.applicationId, 64) || !text(intent.botId, 64) || !text(intent.ownerId, 128) || !text(intent.guildId, 128) || !text(intent.channelId, 128)
        || !['actor', 'shared'].includes(intent.bindingMode) || !text(intent.bindingId, 512)
        || intent.bindingId !== bindingKey(intent.guildId, intent.channelId, intent.bindingMode === 'shared' ? 'shared' : intent.ownerId)
        || !Number.isSafeInteger(intent.bindingVersion) || intent.bindingVersion < 0 || !/^[a-f0-9]{64}$/u.test(intent.workspaceDigest)
        || intent.definitionId !== '@deepseek-ai/dsh-command-compact' || !['unknown', 'completed', 'noop'].includes(intent.state)
        || !Number.isSafeInteger(intent.dispatchedAt) || intent.dispatchedAt < 0)
        return false;
    const commandIdValid = intent.commandId === undefined || text(intent.commandId, 128);
    const outcomeValid = intent.outcomeAt === undefined || Number.isSafeInteger(intent.outcomeAt) && intent.outcomeAt >= intent.dispatchedAt;
    const sequenceValid = intent.sourceEventSeq === undefined || Number.isSafeInteger(intent.sourceEventSeq) && intent.sourceEventSeq >= 0 && !Object.is(intent.sourceEventSeq, -0);
    if (!commandIdValid || !outcomeValid || !sequenceValid)
        return false;
    if (intent.state === 'completed')
        return text(intent.commandId, 128) && Number.isSafeInteger(intent.sourceEventSeq) && intent.sourceEventSeq >= 0 && !Object.is(intent.sourceEventSeq, -0) && Number.isSafeInteger(intent.outcomeAt);
    if (intent.state === 'noop')
        return text(intent.commandId, 128) && intent.sourceEventSeq === undefined && Number.isSafeInteger(intent.outcomeAt);
    return intent.sourceEventSeq === undefined;
}
export class Store {
    metadataOnly;
    db;
    databasePath;
    bodies = new Map();
    constructor(path, metadataOnly = false) {
        this.metadataOnly = metadataOnly;
        this.databasePath = path;
        let verifyExistingProfile = false;
        let reservedIdentity;
        if (metadataOnly && path !== ':memory:') {
            // Reserve a new path atomically; an existing path is never claimed.
            mkdirSync(dirname(path), { recursive: true });
            try {
                const fd = openSync(path, 'wx');
                try {
                    const stat = fstatSync(fd);
                    reservedIdentity = { dev: stat.dev, ino: stat.ino };
                }
                finally {
                    closeSync(fd);
                }
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
                verifyExistingProfile = true;
            }
        }
        if (verifyExistingProfile) {
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
                if ((version !== 1 && version !== 2) || marker !== 'single-operator-text-v1')
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
            this.db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; COMMIT;');
            const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
            if (reservedIdentity) {
                const stat = lstatSync(path);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== reservedIdentity.dev || stat.ino !== reservedIdentity.ino
                    || version !== 0 || this.db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get())
                    throw new AppError('PROFILE_CONFLICT', '新規データベースを安全に確認できません。');
            }
            if (verifyExistingProfile) {
                // Recheck under the exclusive lock: the read-only probe is not a lock.
                try {
                    const marker = this.db.prepare('SELECT value FROM settings WHERE key=?').get('restricted-storage-profile')?.value;
                    if ((version !== 1 && version !== 2) || marker !== 'single-operator-text-v1')
                        throw new Error('Profile mismatch');
                    for (const table of ['runs', 'bindings', 'receipts'])
                        this.db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
                }
                catch {
                    throw new AppError('PROFILE_CONFLICT', '既存データベースの専用プロファイルを確認できません。移行は行いません。');
                }
            }
            if (version !== 0 && version !== 1 && version !== 2)
                throw new AppError('DB_VERSION', 'このデータベースは未対応バージョンです。');
            if (!metadataOnly) {
                const settingsExist = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
                if (settingsExist && this.db.prepare('SELECT value FROM settings WHERE key=?').get('restricted-storage-profile'))
                    throw new AppError('PROFILE_CONFLICT', '専用プロファイルのデータベースを通常モードで開けません。');
            }
            // Fence older binaries before schema or row writes and Engine recovery.
            // Existing verified profiles can reopen after a crash. A fresh reservation
            // interrupted before the Host writes its marker fails closed on reopening.
            if (version !== 2)
                this.db.exec('PRAGMA user_version=2;');
            this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;');
            this.db.exec(`CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, user_id TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS protected_output_intents (intent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, payload TEXT NOT NULL, reserved_cipher_bytes INTEGER NOT NULL, reserved_metadata_bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS protected_output_state ON protected_output_intents(state);
         CREATE TABLE IF NOT EXISTS compact_intents (intent_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, dispatched_at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS compact_intents_session ON compact_intents(session_id,dispatched_at);
         CREATE UNIQUE INDEX IF NOT EXISTS one_unknown_compact_per_session ON compact_intents(session_id) WHERE state='unknown';
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(session_id) WHERE state IN ('dispatching','accepted','running','unknown');
        PRAGMA user_version=2;`);
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
            this.assertNoUnknownCompactIntent(sessionId);
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
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.assertNoUnknownCompactIntent(run.sessionId);
            this.db.prepare('INSERT INTO runs(id,session_id,state,user_id,payload) VALUES (?,?,?,?,?)').run(run.id, run.sessionId, run.state, run.userId, this.encode(run));
            this.db.exec('COMMIT');
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            if (error instanceof AppError && ['COMPACT_UNKNOWN', 'DB_CORRUPT'].includes(error.code))
                throw error;
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
    sqliteStorageBytes() {
        if (this.databasePath === ':memory:')
            return 0;
        let total = 0;
        try {
            for (const path of [this.databasePath, `${this.databasePath}-journal`, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
                if (!existsSync(path))
                    continue;
                const stat = lstatSync(path);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0)
                    throw new AppError('PROTECTED_STORAGE_UNSAFE', '保護出力の保存領域を安全に確認できません。');
                total += stat.size;
                if (total > MAX_PROTECTED_STORAGE_BYTES)
                    throw new AppError('PROTECTED_OUTPUT_QUOTA', '保護出力の保存上限に達しました。');
            }
            return total;
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            throw new AppError('PROTECTED_STORAGE_UNSAFE', '保護出力の保存領域を確認できません。');
        }
    }
    validateInventory(inventory) {
        if (!inventory || !Array.isArray(inventory.files) || !Number.isSafeInteger(inventory.bytes) || inventory.bytes < 0 || inventory.files.length > 32768)
            throw new AppError('PROTECTED_STORAGE_UNSAFE', '保護出力の保存領域を安全に確認できません。');
        const files = new Map();
        let total = 0;
        for (const file of inventory.files) {
            if (!/^[a-f0-9]{64}$/u.test(file.ref) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 131072 || files.has(file.ref))
                throw new AppError('PROTECTED_STORAGE_UNSAFE', '保護出力の保存領域を安全に確認できません。');
            files.set(file.ref, file.bytes);
            total += file.bytes;
        }
        if (total !== inventory.bytes)
            throw new AppError('PROTECTED_STORAGE_UNSAFE', '保護出力の保存領域を安全に確認できません。');
        return files;
    }
    validateIntentRun(intent, run) {
        const scope = intent.items[0]?.context;
        if (!scope || !run.requiresProtectedOutput || run.id !== intent.runId || run.sessionId !== scope.nativeSessionId || run.requestId !== scope.clientRequestId
            || run.payloadDigest !== scope.promptDigest || run.startSeq !== scope.bridgeStartSeq || run.lastSeq !== scope.lastObservedSeq || run.turn !== scope.observedTurn
            || run.userId !== scope.ownerId || run.guildId !== scope.guildId || run.channelId !== scope.channelId || run.bindingVersion !== scope.bindingVersion
            || (scope.bindingMode === 'shared' ? run.guildId === 'telegram' || scope.bindingId !== bindingKey(run.guildId, run.channelId, 'shared') : scope.bindingId !== bindingKey(run.guildId, run.channelId, run.userId)) || run.notificationPreferences?.destination !== scope.destination
            || run.originalFinalDigest !== (scope.preRedactionDigest ?? undefined) || run.bodyDigest !== intent.bodyDigest
            || (run.originalFinalDigest ?? run.bodyDigest) !== intent.outputDigest || !run.delivery || run.delivery.digest !== intent.deliveryPlanDigest
            || run.delivery.bodyDigest !== intent.outputDigest || run.delivery.destination !== scope.destination
            || run.delivery.userId !== run.userId || run.delivery.guildId !== run.guildId || run.delivery.channelId !== run.channelId
            || scope.terminalState !== run.state || (scope.completionSource === 'native-turn' && (!run.admitted || run.turn === null))
            || (scope.completionSource === 'bridge-rejection' && (run.admitted || run.state !== 'failed'))
            || !terminal(run.state))
            throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力scopeが保存済みRunと一致しません。');
        const body = intent.items.filter(item => item.kind === 'body').sort((a, b) => a.index - b.index);
        const parts = intent.items.filter(item => item.kind === 'part').sort((a, b) => a.index - b.index);
        if (!body.length || body.some((item, index) => item.index !== index || item.count !== body.length)
            || parts.length !== run.delivery.parts.length || parts.some((item, index) => item.index !== index || item.count !== parts.length
            || item.contentDigest !== run.delivery.parts[index].digest || item.index !== run.delivery.parts[index].index - 1))
            throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の項目計画がRunと一致しません。');
        if (run.protectedOutput && (run.protectedOutput.intentId !== intent.intentId || run.protectedOutput.state !== intent.state
            || run.protectedOutput.outputDigest !== intent.outputDigest || run.protectedOutput.bodyDigest !== intent.bodyDigest
            || run.protectedOutput.deliveryPlanDigest !== intent.deliveryPlanDigest || JSON.stringify(run.protectedOutput.items) !== JSON.stringify(intent.items)
            || JSON.stringify(run.protectedOutput.deletedRefs) !== JSON.stringify(intent.deletedRefs)))
            throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力manifestが準備記録と一致しません。');
        if (intent.state === 'prepared' && run.protectedOutput)
            throw new AppError('PROTECTED_OUTPUT_CONFLICT', '準備済み出力が早期に公開されています。');
        if (intent.state !== 'prepared' && !run.protectedOutput)
            throw new AppError('PROTECTED_OUTPUT_CONFLICT', '公開済み出力manifestがありません。');
        if (intent.state === 'retired' && (!run.bodyMissing || run.protectedOutput?.state !== 'retired'))
            throw new AppError('PROTECTED_OUTPUT_CONFLICT', '削除済み本文状態が一致しません。');
        if (intent.resolvedAt !== undefined && (run.bodyResolvedAt !== intent.resolvedAt || run.bodyExpiresAt !== intent.expiresAt
            || run.protectedOutput?.resolvedAt !== intent.resolvedAt || run.protectedOutput.expiresAt !== intent.expiresAt
            || !run.delivery.complete || run.notification !== 'sent' || run.delivery.parts.length < 1 || run.delivery.parts.some(part => part.state !== 'sent' || !part.messageId)))
            throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の解決期限が一致しません。');
    }
    readProtectedIntents() {
        try {
            return this.db.prepare('SELECT payload,state,reserved_cipher_bytes,reserved_metadata_bytes FROM protected_output_intents ORDER BY updated_at').all().map(row => {
                const intent = JSON.parse(String(row.payload));
                const state = String(row.state), reservedCipherBytes = Number(row.reserved_cipher_bytes), reservedMetadataBytes = Number(row.reserved_metadata_bytes);
                if (intent.schemaVersion !== 1 || intent.profile !== 'local-bridge-output-v1' || !/^[a-f0-9]{64}$/u.test(intent.intentId)
                    || typeof intent.runId !== 'string' || !intent.runId || !/^[a-f0-9]{64}$/u.test(intent.outputDigest) || !/^[a-f0-9]{64}$/u.test(intent.bodyDigest)
                    || !/^[a-f0-9]{64}$/u.test(intent.deliveryPlanDigest) || !Array.isArray(intent.items) || intent.items.length < 1 || intent.items.length > 200
                    || !['prepared', 'published', 'retiring', 'retired'].includes(intent.state) || !Array.isArray(intent.deletedRefs) || !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0
                    || state !== intent.state || !Number.isSafeInteger(reservedCipherBytes) || reservedCipherBytes < 0 || !Number.isSafeInteger(reservedMetadataBytes) || reservedMetadataBytes < 0
                    || reservedMetadataBytes !== intent.reservedMetadataBytes || (state !== 'prepared' && (reservedCipherBytes !== 0 || reservedMetadataBytes !== 0))
                    || (state === 'prepared' && (intent.resolvedAt !== undefined || intent.expiresAt !== undefined || intent.deletedRefs.length !== 0))
                    || ((state === 'retiring' || state === 'retired' || intent.resolvedAt !== undefined || intent.expiresAt !== undefined)
                        && (intent.resolvedAt === undefined || intent.expiresAt === undefined || !Number.isSafeInteger(intent.resolvedAt) || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt - intent.resolvedAt !== PROTECTED_OUTPUT_RETENTION_MS || intent.resolvedAt < intent.createdAt))
                    || (intent.resolvedAt !== undefined) !== (intent.expiresAt !== undefined))
                    throw new Error('invalid protected intent');
                const refs = new Set();
                let cipherBytes = 0;
                const initialScope = intent.items[0]?.context ? outputScopeKey(intent.items[0].context) : '';
                if (!initialScope)
                    throw new Error('invalid protected scope');
                for (const item of intent.items) {
                    if (!/^[a-f0-9]{64}$/u.test(item.ref) || refs.has(item.ref) || !['body', 'part'].includes(item.kind) || !Number.isSafeInteger(item.index) || item.index < 0
                        || !Number.isSafeInteger(item.count) || item.count < 1 || item.index >= item.count || !/^[a-f0-9]{64}$/u.test(item.digest)
                        || !/^[a-f0-9]{64}$/u.test(item.contentDigest) || !validOutputContext(item.context) || outputScopeKey(item.context) !== initialScope
                        || item.context.itemDigest !== item.contentDigest || item.context.itemKind !== item.kind || item.context.bridgeRunId !== intent.runId
                        || item.context.itemIndex !== item.index || item.context.itemCount !== item.count
                        || item.context.redactedBodyDigest !== intent.bodyDigest || item.context.deliveryPlanDigest !== intent.deliveryPlanDigest
                        || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 98304
                        || !Number.isSafeInteger(item.cipherBytes) || item.cipherBytes < 1 || item.cipherBytes > 131072)
                        throw new Error('invalid protected item');
                    refs.add(item.ref);
                    cipherBytes += item.cipherBytes;
                }
                const deleted = new Set();
                for (const ref of intent.deletedRefs) {
                    if (!/^[a-f0-9]{64}$/u.test(ref) || deleted.has(ref) || !refs.has(ref))
                        throw new Error('invalid protected retirement');
                    deleted.add(ref);
                }
                if ((state === 'retired' && deleted.size !== refs.size) || ((state === 'prepared' || state === 'published') && deleted.size))
                    throw new Error('invalid protected retirement');
                if (state === 'prepared' && cipherBytes !== reservedCipherBytes)
                    throw new Error('invalid protected reservation');
                if (state !== 'prepared' && reservedCipherBytes !== 0)
                    throw new Error('invalid released reservation');
                return { intent, reservedCipherBytes, reservedMetadataBytes };
            });
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            throw new AppError('DB_CORRUPT', '保護出力の記録を確認できません。');
        }
    }
    activeMetadataReservationBytes(excludeRunId) {
        const row = excludeRunId === undefined
            ? this.db.prepare(`SELECT count(*) AS count FROM runs r WHERE r.state IN ('dispatching','accepted','running','unknown') AND NOT EXISTS(SELECT 1 FROM protected_output_intents i WHERE i.run_id=r.id AND i.state='prepared')`).get()
            : this.db.prepare(`SELECT count(*) AS count FROM runs r WHERE r.id<>? AND r.state IN ('dispatching','accepted','running','unknown') AND NOT EXISTS(SELECT 1 FROM protected_output_intents i WHERE i.run_id=r.id AND i.state='prepared')`).get(excludeRunId);
        const count = Number(row?.count);
        if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor(MAX_PROTECTED_STORAGE_BYTES / MAX_ACTIVE_RUN_METADATA_RESERVE))
            throw new AppError('DB_CORRUPT', '保護出力の予約を確認できません。');
        return count * MAX_ACTIVE_RUN_METADATA_RESERVE;
    }
    verifyProtectedCapacity(inventory, additionalMetadataBytes = 0) {
        if (!Number.isSafeInteger(additionalMetadataBytes) || additionalMetadataBytes < 0)
            throw new AppError('PROTECTED_OUTPUT_INVALID', '保護出力の予約が不正です。');
        const files = this.validateInventory(inventory), current = this.readProtectedIntents();
        const runs = new Map(this.allRuns().map(run => [run.id, run]));
        const uniqueRefs = new Set();
        let outstanding = 0, metadataReserved = 0;
        for (const entry of current) {
            const { intent } = entry, run = runs.get(intent.runId);
            if (!run)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '準備記録に対応するRunがありません。');
            metadataReserved += entry.reservedMetadataBytes;
            const scope = intent.items[0].context;
            if (intent.state === 'prepared') {
                if (!run.requiresProtectedOutput || terminal(run.state) || run.id !== intent.runId || run.sessionId !== scope.nativeSessionId
                    || run.requestId !== scope.clientRequestId || run.payloadDigest !== scope.promptDigest || run.startSeq !== scope.bridgeStartSeq
                    || run.userId !== scope.ownerId || run.guildId !== scope.guildId || run.channelId !== scope.channelId
                    || run.bindingVersion !== scope.bindingVersion || run.notificationPreferences?.destination !== scope.destination || run.protectedOutput)
                    throw new AppError('PROTECTED_OUTPUT_CONFLICT', '準備記録が未確定Runと一致しません。');
            }
            else
                this.validateIntentRun(intent, run);
            for (const item of intent.items) {
                if (uniqueRefs.has(item.ref))
                    throw new AppError('PROTECTED_OUTPUT_CONFLICT', '異なるRunが同じ保護出力参照を共有しています。');
                uniqueRefs.add(item.ref);
                const materialized = files.get(item.ref), deleted = intent.deletedRefs.includes(item.ref);
                if (intent.state === 'published' && materialized !== item.cipherBytes)
                    throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '公開済み保護出力が欠落または変更されています。');
                if (intent.state === 'retired' && materialized !== undefined || intent.state === 'retiring' && deleted && materialized !== undefined)
                    throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '削除済み保護出力が保存領域に残っています。');
                if (intent.state === 'retiring' && !deleted && materialized !== undefined && materialized !== item.cipherBytes)
                    throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '削除待ち保護出力が変更されています。');
                if (intent.state === 'prepared') {
                    if (materialized !== undefined && materialized !== item.cipherBytes)
                        throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '保護出力ファイルのサイズが準備記録と一致しません。');
                    if (materialized === undefined)
                        outstanding += item.cipherBytes;
                }
            }
            if (intent.state === 'retired' && intent.deletedRefs.length !== intent.items.length)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '削除済み保護出力のtombstoneが不完全です。');
        }
        if (this.allRuns().some(run => run.requiresProtectedOutput && terminal(run.state) && !run.protectedOutput))
            throw new AppError('PROTECTED_OUTPUT_CONFLICT', '終端Runに保護出力manifestがありません。');
        if (this.sqliteStorageBytes() + inventory.bytes + outstanding + metadataReserved + this.activeMetadataReservationBytes() + additionalMetadataBytes > MAX_PROTECTED_STORAGE_BYTES)
            throw new AppError('PROTECTED_OUTPUT_QUOTA', '保護出力の保存上限に達しました。新しい実行は停止しました。');
    }
    protectedIntent(runId) {
        const found = this.readProtectedIntents().find(entry => entry.intent.runId === runId)?.intent;
        return found ? structuredClone(found) : undefined;
    }
    protectedIntents() { return this.readProtectedIntents().map(entry => structuredClone(entry.intent)); }
    reserveProtectedIntent(intent, inventory) {
        if (!this.metadataOnly || intent.state !== 'prepared' || intent.profile !== 'local-bridge-output-v1' || intent.schemaVersion !== 1
            || !/^[a-f0-9]{64}$/u.test(intent.intentId) || !intent.runId || !/^[a-f0-9]{64}$/u.test(intent.outputDigest)
            || !/^[a-f0-9]{64}$/u.test(intent.bodyDigest) || !/^[a-f0-9]{64}$/u.test(intent.deliveryPlanDigest)
            || !Array.isArray(intent.items) || intent.items.length < 1 || intent.items.length > 200
            || !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0 || !Number.isSafeInteger(intent.reservedMetadataBytes) || intent.reservedMetadataBytes < 0)
            throw new AppError('PROTECTED_OUTPUT_INVALID', '保護出力の準備情報が不正です。');
        const files = this.validateInventory(inventory);
        const refs = new Set();
        let newCipherBytes = 0;
        if (!intent.items[0] || !validOutputContext(intent.items[0].context))
            throw new AppError('PROTECTED_OUTPUT_INVALID', '保護出力のscopeが不正です。');
        const initialScope = outputScopeKey(intent.items[0].context);
        for (const item of intent.items) {
            if (!item || !/^[a-f0-9]{64}$/u.test(item.ref) || refs.has(item.ref) || !Number.isSafeInteger(item.cipherBytes) || item.cipherBytes < 1 || item.cipherBytes > 131072
                || !/^[a-f0-9]{64}$/u.test(item.digest) || !/^[a-f0-9]{64}$/u.test(item.contentDigest) || !validOutputContext(item.context) || outputScopeKey(item.context) !== initialScope
                || item.context.bridgeRunId !== intent.runId || item.context.redactedBodyDigest !== intent.bodyDigest || item.context.deliveryPlanDigest !== intent.deliveryPlanDigest
                || item.context.itemDigest !== item.contentDigest || item.context.itemKind !== item.kind || item.context.itemIndex !== item.index || item.context.itemCount !== item.count
                || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 98304
                || !['body', 'part'].includes(item.kind) || !Number.isSafeInteger(item.index) || item.index < 0 || !Number.isSafeInteger(item.count) || item.count < 1 || item.index >= item.count)
                throw new AppError('PROTECTED_OUTPUT_INVALID', '保護出力の準備情報が不正です。');
            refs.add(item.ref);
            newCipherBytes += item.cipherBytes;
        }
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const runRow = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(intent.runId);
            if (!runRow)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力対象のRunがありません。');
            const run = JSON.parse(String(runRow.payload)), scope = intent.items[0].context;
            if (run.id !== intent.runId || !run.requiresProtectedOutput || terminal(run.state) || run.protectedOutput
                || run.sessionId !== scope.nativeSessionId || run.requestId !== scope.clientRequestId || run.payloadDigest !== scope.promptDigest
                || run.startSeq !== scope.bridgeStartSeq || run.userId !== scope.ownerId || run.guildId !== scope.guildId || run.channelId !== scope.channelId
                || (scope.bindingMode === 'shared' ? run.guildId === 'telegram' || scope.bindingId !== bindingKey(run.guildId, run.channelId, 'shared') : scope.bindingId !== bindingKey(run.guildId, run.channelId, run.userId)) || run.bindingVersion !== scope.bindingVersion
                || run.notificationPreferences?.destination !== scope.destination)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力のscopeが保存済みRunと一致しません。');
            const existingRow = this.db.prepare('SELECT payload,state FROM protected_output_intents WHERE run_id=?').get(intent.runId);
            if (existingRow) {
                const existing = JSON.parse(String(existingRow.payload));
                const same = existing.state === 'prepared' && existingRow.state === 'prepared' && existing.intentId === intent.intentId
                    && existing.profile === intent.profile && existing.outputDigest === intent.outputDigest && existing.bodyDigest === intent.bodyDigest
                    && existing.deliveryPlanDigest === intent.deliveryPlanDigest && existing.reservedMetadataBytes === intent.reservedMetadataBytes
                    && JSON.stringify(existing.items) === JSON.stringify(intent.items);
                if (!same)
                    throw new AppError('PROTECTED_OUTPUT_CONFLICT', '既存の保護出力意図と一致しません。');
                for (const item of existing.items) {
                    const materialized = files.get(item.ref);
                    if (materialized !== undefined && materialized !== item.cipherBytes)
                        throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '準備済み保護出力のciphertextが一致しません。');
                }
                this.db.exec('COMMIT');
                return structuredClone(existing);
            }
            const current = this.readProtectedIntents();
            let outstanding = 0, metadataReserved = 0;
            const persistedRefs = new Set(current.flatMap(entry => entry.intent.items.map(item => item.ref)));
            for (const item of intent.items)
                if (persistedRefs.has(item.ref) || files.has(item.ref))
                    throw new AppError('PROTECTED_PAYLOAD_REF_COLLISION', '保護出力の参照が既存データと競合しました。');
            for (const entry of current) {
                metadataReserved += entry.reservedMetadataBytes;
                if (entry.intent.state !== 'prepared')
                    continue;
                for (const item of entry.intent.items) {
                    const materialized = files.get(item.ref);
                    if (materialized !== undefined && materialized !== item.cipherBytes)
                        throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '保護出力ファイルのサイズが準備記録と一致しません。');
                    if (materialized === undefined)
                        outstanding += item.cipherBytes;
                }
            }
            // The intent row is not yet reflected in the physical SQLite size; reserve its
            // serialized bytes once plus page/index slack. Future terminal-row growth stays
            // outstanding in reserved_metadata_bytes until the atomic publish materializes it.
            const intentRowReserve = Buffer.byteLength(JSON.stringify(intent), 'utf8') + 8192;
            const used = this.sqliteStorageBytes() + inventory.bytes + outstanding + metadataReserved + this.activeMetadataReservationBytes(intent.runId) + newCipherBytes + intent.reservedMetadataBytes + intentRowReserve;
            if (used > MAX_PROTECTED_STORAGE_BYTES)
                throw new AppError('PROTECTED_OUTPUT_QUOTA', '保護出力の保存上限に達しました。新しい実行は停止しました。');
            this.db.prepare('INSERT INTO protected_output_intents(intent_id,run_id,state,payload,reserved_cipher_bytes,reserved_metadata_bytes,updated_at) VALUES (?,?,?,?,?,?,?)')
                .run(intent.intentId, intent.runId, 'prepared', JSON.stringify(intent), newCipherBytes, intent.reservedMetadataBytes, Date.now());
            this.db.exec('COMMIT');
            return structuredClone(intent);
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            if (error instanceof AppError)
                throw error;
            throw new AppError('PROTECTED_OUTPUT_COMMIT_FAILED', '保護出力の準備を確定できません。');
        }
    }
    commitProtectedOutput(run, intentId) {
        if (!this.metadataOnly || !terminal(run.state))
            throw new AppError('PROTECTED_OUTPUT_INVALID', '保護出力を確定できません。');
        this.db.exec('BEGIN IMMEDIATE');
        const oldRevision = run.revision ?? 0;
        const oldRun = { state: run.state, updatedAt: run.updatedAt, output: run.output, result: run.result, finalText: run.finalText, bodyMissing: run.bodyMissing, protectedOutput: run.protectedOutput };
        try {
            const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(run.id);
            const current = row ? JSON.parse(String(row.payload)) : undefined;
            const revision = current?.revision ?? 0;
            if (!current || !Number.isSafeInteger(revision) || revision < 0 || revision !== oldRevision)
                throw new AppError('RUN_REVISION_CONFLICT', '実行情報が更新されました。再確認してください。');
            if (revision >= Number.MAX_SAFE_INTEGER)
                throw new AppError('RUN_VERSION_EXHAUSTED', 'Run revision上限です。記録を保全してください。');
            const intentRow = this.db.prepare('SELECT payload,state FROM protected_output_intents WHERE intent_id=? AND run_id=?').get(intentId, run.id);
            if (!intentRow)
                throw new AppError('PROTECTED_OUTPUT_INTENT_MISSING', '保護出力の準備記録がありません。');
            const intent = JSON.parse(String(intentRow.payload));
            if (intent.state !== 'prepared' || intentRow.state !== 'prepared' || intent.outputDigest !== (run.originalFinalDigest ?? run.bodyDigest)
                || intent.bodyDigest !== run.bodyDigest || intent.deliveryPlanDigest !== run.delivery?.digest
                || intent.items.length < 1 || intent.items.some(item => !/^[a-f0-9]{64}$/u.test(item.ref)))
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の準備記録とRunが一致しません。');
            this.validateIntentRun(intent, run);
            const manifest = { schemaVersion: 1, profile: 'local-bridge-output-v1', intentId: intent.intentId, state: 'published',
                outputDigest: intent.outputDigest, bodyDigest: intent.bodyDigest, deliveryPlanDigest: intent.deliveryPlanDigest,
                items: intent.items, createdAt: intent.createdAt, deletedRefs: [] };
            run.protectedOutput = manifest;
            run.revision = revision + 1;
            if (this.db.prepare('UPDATE runs SET state=?,payload=? WHERE id=?').run(run.state, this.encode(run), run.id).changes !== 1)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', 'Runの公開記録を更新できません。');
            const published = { ...intent, state: 'published', reservedMetadataBytes: 0 };
            if (this.db.prepare("UPDATE protected_output_intents SET state='published',payload=?,reserved_cipher_bytes=0,reserved_metadata_bytes=0,updated_at=? WHERE intent_id=? AND state='prepared'")
                .run(JSON.stringify(published), Date.now(), intentId).changes !== 1)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力意図の公開記録を更新できません。');
            this.db.exec('COMMIT');
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            run.state = oldRun.state;
            run.updatedAt = oldRun.updatedAt;
            run.output = oldRun.output;
            run.result = oldRun.result;
            if (oldRun.finalText === undefined)
                delete run.finalText;
            else
                run.finalText = oldRun.finalText;
            if (oldRun.bodyMissing === undefined)
                delete run.bodyMissing;
            else
                run.bodyMissing = oldRun.bodyMissing;
            if (oldRun.protectedOutput === undefined)
                delete run.protectedOutput;
            else
                run.protectedOutput = oldRun.protectedOutput;
            run.revision = oldRevision;
            if (oldRun.bodyMissing)
                this.bodies.delete(run.id);
            else
                this.bodies.set(run.id, { output: oldRun.output, result: oldRun.result, finalText: oldRun.finalText });
            if (error instanceof AppError)
                throw error;
            throw new AppError('PROTECTED_OUTPUT_COMMIT_FAILED', '保護出力とRunを確定できません。');
        }
    }
    resolveProtectedOutput(run, resolvedAt, expiresAt) {
        if (!this.metadataOnly || !terminal(run.state) || !run.protectedOutput || run.protectedOutput.state !== 'published' || !run.delivery?.complete
            || run.notification !== 'sent' || run.delivery.parts.length < 1 || run.delivery.parts.some(part => part.state !== 'sent' || !part.messageId)
            || !Number.isSafeInteger(resolvedAt) || !Number.isSafeInteger(expiresAt) || expiresAt - resolvedAt !== PROTECTED_OUTPUT_RETENTION_MS || resolvedAt < run.createdAt)
            throw new AppError('PROTECTED_OUTPUT_INVALID', '保護出力の解決条件を確認できません。');
        this.db.exec('BEGIN IMMEDIATE');
        const oldRevision = run.revision ?? 0;
        const oldRun = { state: run.state, updatedAt: run.updatedAt, output: run.output, result: run.result, finalText: run.finalText, bodyMissing: run.bodyMissing, protectedOutput: run.protectedOutput, bodyResolvedAt: run.bodyResolvedAt, bodyExpiresAt: run.bodyExpiresAt };
        try {
            const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(run.id);
            const current = row ? JSON.parse(String(row.payload)) : undefined;
            const revision = current?.revision ?? 0;
            if (!current || revision !== oldRevision || !Number.isSafeInteger(revision) || revision < 0)
                throw new AppError('RUN_REVISION_CONFLICT', '実行情報が更新されました。');
            const intentRow = this.db.prepare('SELECT payload,state FROM protected_output_intents WHERE intent_id=? AND run_id=?').get(run.protectedOutput.intentId, run.id);
            if (!intentRow || intentRow.state !== 'published')
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の公開記録を確認できません。');
            const intent = JSON.parse(String(intentRow.payload));
            if (intent.state !== 'published' || intent.outputDigest !== run.protectedOutput.outputDigest || intent.bodyDigest !== run.protectedOutput.bodyDigest
                || intent.deliveryPlanDigest !== run.protectedOutput.deliveryPlanDigest)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の公開記録とRunが一致しません。');
            this.validateIntentRun(intent, run);
            run.bodyResolvedAt = resolvedAt;
            run.bodyExpiresAt = expiresAt;
            run.protectedOutput = { ...run.protectedOutput, resolvedAt, expiresAt };
            run.output = '';
            run.result = '';
            run.finalText = undefined;
            run.bodyMissing = true;
            run.updatedAt = resolvedAt;
            if (revision >= Number.MAX_SAFE_INTEGER)
                throw new AppError('RUN_VERSION_EXHAUSTED', 'Run revision上限です。記録を保全してください。');
            run.revision = revision + 1;
            if (this.db.prepare('UPDATE runs SET state=?,payload=? WHERE id=?').run(run.state, this.encode(run), run.id).changes !== 1)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力のRun記録を更新できません。');
            // Reservation columns are already zero after atomic publication; never charge a materialized intent twice.
            const resolvedIntent = { ...intent, resolvedAt, expiresAt };
            const resolutionChanges = this.db.prepare("UPDATE protected_output_intents SET payload=?,reserved_cipher_bytes=0,reserved_metadata_bytes=0,updated_at=? WHERE intent_id=? AND state='published'")
                .run(JSON.stringify(resolvedIntent), resolvedAt, intent.intentId).changes;
            if (resolutionChanges !== 1)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の解決記録を更新できません。');
            this.db.exec('COMMIT');
            this.evictBody(run.id);
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            run.state = oldRun.state;
            run.updatedAt = oldRun.updatedAt;
            run.output = oldRun.output;
            run.result = oldRun.result;
            if (oldRun.finalText === undefined)
                delete run.finalText;
            else
                run.finalText = oldRun.finalText;
            if (oldRun.bodyMissing === undefined)
                delete run.bodyMissing;
            else
                run.bodyMissing = oldRun.bodyMissing;
            if (oldRun.protectedOutput === undefined)
                delete run.protectedOutput;
            else
                run.protectedOutput = oldRun.protectedOutput;
            if (oldRun.bodyResolvedAt === undefined)
                delete run.bodyResolvedAt;
            else
                run.bodyResolvedAt = oldRun.bodyResolvedAt;
            if (oldRun.bodyExpiresAt === undefined)
                delete run.bodyExpiresAt;
            else
                run.bodyExpiresAt = oldRun.bodyExpiresAt;
            run.revision = oldRevision;
            if (oldRun.bodyMissing)
                this.bodies.delete(run.id);
            else
                this.bodies.set(run.id, { output: oldRun.output, result: oldRun.result, finalText: oldRun.finalText });
            if (error instanceof AppError)
                throw error;
            throw new AppError('PROTECTED_OUTPUT_COMMIT_FAILED', '保護出力の解決を確定できません。');
        }
    }
    beginProtectedRetirement(runId, now) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(runId);
            const run = this.decode(row);
            if (!run?.protectedOutput || run.protectedOutput.state !== 'published' || run.protectedOutput.expiresAt === undefined || run.protectedOutput.expiresAt > now) {
                this.db.exec('COMMIT');
                return undefined;
            }
            if (!run.delivery?.complete || run.notification !== 'sent' || run.delivery.parts.length < 1 || run.delivery.parts.some(part => part.state !== 'sent' || !part.messageId)
                || run.bodyResolvedAt !== run.protectedOutput.resolvedAt || run.bodyExpiresAt !== run.protectedOutput.expiresAt)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除条件を再確認できません。');
            const intentRow = this.db.prepare('SELECT payload,state FROM protected_output_intents WHERE intent_id=? AND run_id=?').get(run.protectedOutput.intentId, run.id);
            if (!intentRow || intentRow.state !== 'published')
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の公開記録を確認できません。');
            const intent = JSON.parse(String(intentRow.payload));
            if (intent.state !== 'published' || intent.expiresAt !== run.protectedOutput.expiresAt || intent.items.length !== run.protectedOutput.items.length)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の解決記録が一致しません。');
            this.validateIntentRun(intent, run);
            const revision = run.revision ?? 0;
            if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER)
                throw new AppError('RUN_VERSION_EXHAUSTED', 'Run revision上限です。記録を保全してください。');
            run.revision = revision + 1;
            run.protectedOutput = { ...run.protectedOutput, state: 'retiring' };
            run.updatedAt = now;
            if (this.db.prepare('UPDATE runs SET state=?,payload=? WHERE id=?').run(run.state, this.encode(run), run.id).changes !== 1)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力のRun記録を更新できません。');
            const retiring = { ...intent, state: 'retiring' };
            if (this.db.prepare("UPDATE protected_output_intents SET state='retiring',payload=?,updated_at=? WHERE intent_id=? AND state='published'").run(JSON.stringify(retiring), now, intent.intentId).changes !== 1)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除準備を更新できません。');
            this.db.exec('COMMIT');
            return run;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            if (error instanceof AppError)
                throw error;
            throw new AppError('PROTECTED_OUTPUT_COMMIT_FAILED', '保護出力の削除準備を確定できません。');
        }
    }
    recordProtectedDeletes(runId, refs, now) {
        if (!Array.isArray(refs) || refs.length > 200 || !Number.isSafeInteger(now) || now < 0 || refs.some(ref => !/^[a-f0-9]{64}$/u.test(ref)) || new Set(refs).size !== refs.length)
            throw new AppError('PROTECTED_OUTPUT_INVALID', '削除参照が不正です。');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(runId);
            const run = this.decode(row);
            if (!run?.protectedOutput || run.protectedOutput.state !== 'retiring')
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除意図がありません。');
            const intentRow = this.db.prepare('SELECT payload,state FROM protected_output_intents WHERE intent_id=? AND run_id=?').get(run.protectedOutput.intentId, run.id);
            if (!intentRow || intentRow.state !== 'retiring')
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除記録が一致しません。');
            const intent = JSON.parse(String(intentRow.payload));
            this.validateIntentRun(intent, run);
            const exact = new Set(intent.items.map(item => item.ref));
            if (refs.some(ref => !exact.has(ref)))
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力以外の参照は削除できません。');
            const deletedRefs = [...new Set([...run.protectedOutput.deletedRefs, ...refs])].sort();
            if (deletedRefs.some(ref => !exact.has(ref)))
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除記録が一致しません。');
            if (refs.some(ref => run.protectedOutput.deletedRefs.includes(ref)) || refs.length === 0 && deletedRefs.length !== exact.size)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除記録が重複または不完全です。');
            const retired = deletedRefs.length === exact.size;
            const revision = run.revision ?? 0;
            if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER)
                throw new AppError('RUN_VERSION_EXHAUSTED', 'Run revision上限です。記録を保全してください。');
            run.revision = revision + 1;
            run.protectedOutput = { ...run.protectedOutput, state: retired ? 'retired' : 'retiring', deletedRefs };
            run.updatedAt = now;
            if (this.db.prepare('UPDATE runs SET state=?,payload=? WHERE id=?').run(run.state, this.encode(run), run.id).changes !== 1)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力のRun記録を更新できません。');
            const nextIntent = { ...intent, state: retired ? 'retired' : 'retiring', deletedRefs };
            const retirementUpdate = this.db.prepare('UPDATE protected_output_intents SET state=?,payload=?,reserved_cipher_bytes=0,reserved_metadata_bytes=0,updated_at=? WHERE intent_id=? AND state=\'retiring\'')
                .run(nextIntent.state, JSON.stringify(nextIntent), now, intent.intentId).changes;
            if (retirementUpdate !== 1)
                throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除記録を更新できません。');
            this.db.exec('COMMIT');
            return retired;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            if (error instanceof AppError)
                throw error;
            throw new AppError('PROTECTED_OUTPUT_COMMIT_FAILED', '保護出力の削除記録を確定できません。');
        }
    }
    readCompactIntent(row) {
        if (!row)
            return undefined;
        try {
            const intent = JSON.parse(String(row.payload));
            if (!validCompactIntent(intent) || intent.intentId !== row.intent_id || intent.sessionId !== row.session_id || intent.state !== row.state
                || intent.dispatchedAt !== row.dispatched_at)
                throw new Error('Compact intent mismatch');
            return intent;
        }
        catch {
            throw new AppError('DB_CORRUPT', 'Compact intentを確認できません。');
        }
    }
    compactIntent(intentId) {
        return this.readCompactIntent(this.db.prepare('SELECT intent_id,session_id,state,payload,dispatched_at FROM compact_intents WHERE intent_id=?').get(intentId));
    }
    latestCompactIntent(sessionId) {
        return this.readCompactIntent(this.db.prepare('SELECT intent_id,session_id,state,payload,dispatched_at FROM compact_intents WHERE session_id=? ORDER BY dispatched_at DESC,rowid DESC LIMIT 1').get(sessionId));
    }
    assertNoUnknownCompactIntent(sessionId) {
        const row = this.db.prepare("SELECT intent_id,session_id,state,payload,dispatched_at FROM compact_intents WHERE session_id=? AND state='unknown' LIMIT 1").get(sessionId);
        if (!row)
            return;
        this.readCompactIntent(row);
        throw new AppError('COMPACT_UNKNOWN', 'Compactの結果が未確認です。PCで履歴を確認してください。');
    }
    compactIntents() {
        return this.db.prepare('SELECT intent_id,session_id,state,payload,dispatched_at FROM compact_intents ORDER BY rowid').all().map(row => this.readCompactIntent(row));
    }
    reserveCompactIntent(intent) {
        if (!validCompactIntent(intent) || intent.state !== 'unknown' || intent.commandId !== undefined || intent.sourceEventSeq !== undefined || intent.outcomeAt !== undefined)
            throw new AppError('COMPACT_INTENT_INVALID', 'Compactの未知Intentが不正です。');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const currentBinding = this.binding(intent.bindingId);
            const currentVersion = this.bindingVersion(intent.bindingId);
            if (currentBinding !== intent.sessionId || currentVersion !== intent.bindingVersion)
                throw new AppError('BINDING_CONFLICT', 'Bindingが変更されました。Compactは実行していません。');
            const active = this.db.prepare("SELECT state FROM runs WHERE session_id=? AND state IN ('dispatching','accepted','running','unknown') LIMIT 1").get(intent.sessionId)?.state;
            if (active === 'unknown')
                throw new AppError('SESSION_STATE_UNKNOWN', '未確認RunがあるためCompactできません。');
            if (active)
                throw new AppError('SESSION_BUSY', 'Runが進行中のためCompactできません。');
            this.assertNoUnknownCompactIntent(intent.sessionId);
            if (this.db.prepare('INSERT OR IGNORE INTO compact_intents(intent_id,session_id,state,payload,dispatched_at) VALUES (?,?,?,?,?)').run(intent.intentId, intent.sessionId, intent.state, JSON.stringify(intent), intent.dispatchedAt).changes !== 1)
                throw new AppError('COMPACT_INTENT_CONFLICT', 'CompactのIntentを一意に保存できません。');
            this.db.exec('COMMIT');
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            throw error;
        }
    }
    recordCompactOutcome(intentId, outcome) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = this.compactIntent(intentId);
            if (!current || current.state !== 'unknown')
                throw new AppError('COMPACT_INTENT_CONFLICT', 'Compact Intentが未知状態ではありません。');
            const next = { ...current, ...outcome };
            if (!validCompactIntent(next))
                throw new AppError('COMPACT_INTENT_INVALID', 'Compactの結果が不正です。');
            if (next.state === 'unknown' && next.commandId === current.commandId && next.outcomeAt === current.outcomeAt) {
                this.db.exec('COMMIT');
                return next;
            }
            if (this.db.prepare('UPDATE compact_intents SET state=?,payload=? WHERE intent_id=? AND state=\'unknown\'').run(next.state, JSON.stringify(next), intentId).changes !== 1)
                throw new AppError('COMPACT_INTENT_CONFLICT', 'Compactの結果が同時に更新されました。');
            this.db.exec('COMMIT');
            return next;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { }
            throw error;
        }
    }
    evictBody(runId) { this.bodies.delete(runId); }
    active() {
        return this.db.prepare("SELECT payload FROM runs WHERE state IN ('dispatching','accepted','running','unknown') ORDER BY rowid").all().map(row => this.decode(row));
    }
    pendingNotifications(now = Date.now()) {
        return this.db.prepare("SELECT payload FROM runs WHERE state IN ('succeeded','failed','interrupted') ORDER BY rowid").all()
            .map(row => this.decode(row)).filter(run => run.notification === 'pending' && run.nextNotifyAt <= now);
    }
    pendingWorkingNotices() {
        return this.db.prepare('SELECT payload FROM runs ORDER BY rowid').all().map(row => this.decode(row))
            .filter(run => run.workNotice === 'ready');
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