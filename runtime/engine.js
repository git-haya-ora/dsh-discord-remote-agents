import { createHash } from 'node:crypto';
import { AppError, errorCode } from './errors.js';
import { DshRejected, object } from './protocol.js';
import { assistantText, boundedOutput, redact } from './output.js';
import { bindingKey } from './store.js';
import { terminal } from './types.js';
export class Engine {
    adapter;
    store;
    policy;
    secrets;
    sharedDiscordBindings;
    ticking = false;
    constructor(adapter, store, policy, secrets = [], sharedDiscordBindings = false) {
        this.adapter = adapter;
        this.store = store;
        this.policy = policy;
        this.secrets = secrets;
        this.sharedDiscordBindings = sharedDiscordBindings;
        store.recoverDispatches();
    }
    redactText(text) { return redact(text, this.secrets); }
    async sessions(actor) {
        if (actor)
            this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        const allowed = [];
        for (const session of await this.adapter.list())
            if (!session.subagent && await this.policy.allowsCwd(session.cwd, actor?.guildId))
                allowed.push(session);
        return allowed.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async session(sessionId, actor) {
        const session = (await this.adapter.list()).find(s => s.sessionId === sessionId && !s.subagent);
        if (!session)
            throw new AppError('SESSION_NOT_FOUND', 'DSHセッションが見つかりません。');
        await this.policy.requireCwd(session.cwd, actor.guildId);
        return session;
    }
    key(actor) { return bindingKey(actor.guildId, actor.channelId, this.sharedDiscordBindings && actor.guildId !== 'telegram' ? 'shared' : actor.userId); }
    binding(actor) { return this.store.binding(this.key(actor)); }
    async bind(actor, sessionId) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        await this.session(sessionId, actor);
        this.store.bind(this.key(actor), sessionId);
    }
    unbind(actor) { this.policy.authorize(actor.userId, actor.guildId, actor.channelId); this.store.unbind(this.key(actor)); }
    async create(actor, workspace) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        const cwd = this.policy.workspace(workspace, actor.guildId);
        await this.policy.requireCwd(cwd, actor.guildId);
        const sessionId = await this.adapter.create(cwd);
        await this.bind(actor, sessionId);
        return sessionId;
    }
    async submit(actor, id, text) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        if (!text.trim() || text.length > 6000)
            throw new AppError('PROMPT_INVALID', '指示は1〜6000文字で指定してください。');
        const existing = this.store.get(id);
        const payloadDigest = createHash('sha256').update(text, 'utf8').digest('hex');
        if (existing) {
            this.checkOwner(actor, existing);
            if (existing.payloadDigest && existing.payloadDigest !== payloadDigest)
                throw new AppError('REQUEST_CONFLICT', '同じ実行IDに異なる指示は送信できません。');
            return existing;
        }
        const sessionId = this.binding(actor);
        if (!sessionId)
            throw new AppError('NOT_BOUND', '/agent bindでセッションを選択してください。');
        const session = await this.session(sessionId, actor);
        if (session.running)
            throw new AppError('SESSION_BUSY', 'DSHが実行中です。完了後に送信してください。');
        const snapshot = await this.adapter.snapshot(sessionId);
        const inbox = object(snapshot.values.inbox);
        if ([inbox['next-turn'], inbox['next-step']].some(queue => Array.isArray(queue) && queue.length > 0)) {
            throw new AppError('SESSION_BUSY', 'DSHに未処理の指示があります。PCで確認してください。');
        }
        const now = Date.now();
        const run = { id, requestId: `${actor.guildId === 'telegram' ? 'telegram' : 'discord'}:${id}`, sessionId, ...actor,
            state: 'dispatching', createdAt: now, updatedAt: now, lastSeq: snapshot.cursor, startSeq: snapshot.cursor, payloadDigest, turn: null,
            output: '', result: '', admitted: false, contaminated: false,
            notification: 'none', notifyAttempts: 0, nextNotifyAt: 0, lastError: '' };
        this.store.create(run); // Durable intent BEFORE the only prompt call. Never replay uncertain dispatches.
        try {
            await this.adapter.prompt(sessionId, run.requestId, text);
            run.state = 'accepted';
        }
        catch (error) {
            run.lastError = errorCode(error);
            if (error instanceof DshRejected) {
                run.state = 'failed';
                run.result = 'DSHが送信を拒否しました。設定とセッション状態を確認してください。';
                run.notification = 'pending';
            }
            else {
                run.state = 'unknown';
                run.result = '送信結果が不明です。再送せず履歴を照合中です。';
            }
        }
        run.updatedAt = Date.now();
        this.store.save(run);
        return run;
    }
    checkOwner(actor, run) {
        if (run.userId !== actor.userId || run.guildId !== actor.guildId || run.channelId !== actor.channelId)
            throw new AppError('RUN_NOT_FOUND', 'この操作元の実行履歴が見つかりません。');
    }
    async status(actor, id, requireLiveAccess = true) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        const run = id ? this.store.get(id) : this.store.latest(actor.userId, actor.guildId, actor.channelId);
        if (run) {
            this.checkOwner(actor, run);
            if (requireLiveAccess) {
                await this.session(run.sessionId, run);
                await this.restoreBody(run);
            }
        }
        return run;
    }
    async retryNotification(actor, id) {
        const run = await this.status(actor, id);
        if (!run || !terminal(run.state))
            throw new AppError('RUN_NOT_FINISHED', '完了した実行IDを指定してください。');
        if (run.notification === 'unknown')
            throw new AppError('NOTIFICATION_UNKNOWN', '不明な通知は再送できません。/agent resultで確認してください。');
        run.notification = 'pending';
        run.notifyAttempts = 0;
        run.nextNotifyAt = 0;
        this.store.save(run);
    }
    async restoreBody(run) {
        if (!run.bodyMissing)
            return;
        if (run.state === 'failed' && !run.admitted) {
            run.result = 'DSHが送信を拒否しました。詳細はPCで確認してください。';
            delete run.bodyMissing;
            this.store.save(run);
            return;
        }
        if (run.startSeq === undefined)
            throw new AppError('BODY_UNAVAILABLE', '本文の復元情報がありません。PCで確認してください。');
        const previousState = run.state;
        const replay = { ...run, state: 'unknown', lastSeq: run.startSeq, turn: null, admitted: false, contaminated: false, output: '', result: '' };
        const snapshot = await this.adapter.snapshot(run.sessionId);
        this.consume(replay, await this.adapter.events(run.sessionId, snapshot.cursor, run.startSeq));
        if (terminal(previousState) && (!replay.admitted || replay.turn === null || replay.state !== previousState))
            throw new AppError('BODY_UNAVAILABLE', '結果を安全に復元できません。PCで確認してください。');
        // Preserve persisted notification ownership/retry state; only hydrate correlated native text.
        run.output = replay.output;
        run.result = replay.result;
        run.lastSeq = replay.lastSeq;
        run.turn = replay.turn;
        run.admitted = replay.admitted;
        run.contaminated = replay.contaminated;
        if (!terminal(previousState) && replay.admitted) {
            run.state = replay.state;
            if (terminal(replay.state))
                run.notification = 'pending';
        }
        delete run.bodyMissing;
        this.store.save(run);
    }
    consume(run, events) {
        for (const event of events) {
            if (event.type === 'turn/start' && typeof event.data.turn === 'number' && !run.admitted) {
                run.turn = event.data.turn;
                run.contaminated = false;
            }
            if (event.type === 'user/message' && event.surfaceOp === 'append') {
                const source = object(event.data.source);
                if (source.rpcId === run.requestId) {
                    if (run.turn === null)
                        throw new AppError('DSH_PROTOCOL', '指示と実行ターンを照合できません。');
                    run.admitted = true;
                    run.state = 'running';
                    run.result = '';
                    run.lastError = '';
                }
                else if (source.kind === 'user' && run.turn !== null) {
                    run.contaminated = true;
                    run.output = '';
                }
            }
            if (run.admitted && !run.contaminated && event.type === 'assistant/message' && event.data.turn === run.turn && event.surfaceOp === 'append') {
                const text = assistantText(event.data);
                if (text)
                    run.output = boundedOutput(`${run.output}${run.output ? '\n\n' : ''}${redact(text, this.secrets)}`);
            }
            run.lastSeq = event.seq;
            if (event.type !== 'turn/end' || event.data.turn !== run.turn)
                continue;
            if (!run.admitted) {
                run.turn = null;
                run.contaminated = false;
                continue;
            }
            const kind = object(event.data.reason).kind;
            if (run.contaminated) {
                run.state = 'interrupted';
                run.output = '';
                run.result = '同じターンに別の指示が含まれたため、混在した結果を配信しません。DSHで確認してください。';
            }
            else if (kind === 'completed') {
                run.state = 'succeeded';
                run.result = run.output || 'DSHのターンが完了しました（テキスト出力なし）。';
            }
            else {
                run.state = kind === 'aborted' ? 'interrupted' : 'failed';
                run.result = `${kind === 'aborted' ? 'DSHで中断されました。' : 'DSHのターンが正常完了しませんでした。'}${run.output ? `\n\n${run.output}` : '\n詳細はPCのDSHで確認してください。'}`;
            }
            run.notification = 'pending';
            run.lastError = '';
            return;
        }
    }
    async tick(notify) {
        if (this.ticking)
            return;
        this.ticking = true;
        try {
            for (const stored of this.store.active()) {
                if (stored.state === 'dispatching')
                    continue; // An in-flight submit owns this row until it settles.
                const run = structuredClone(stored);
                try {
                    await this.session(run.sessionId, run); // Recheck cwd before every disclosure, including after restart.
                    await this.restoreBody(run);
                    const snapshot = await this.adapter.snapshot(run.sessionId);
                    const events = await this.adapter.events(run.sessionId, snapshot.cursor, run.lastSeq);
                    this.consume(run, events);
                    run.updatedAt = Date.now();
                    this.store.save(run);
                }
                catch (error) {
                    // No partial cursor or output commit on a failed read. Do NOT infer success from idle.
                    stored.lastError = errorCode(error);
                    stored.updatedAt = Date.now();
                    this.store.save(stored);
                }
            }
            for (const run of this.store.pendingNotifications()) {
                if (!this.policy.stillAuthorized(run.userId, run.guildId, run.channelId))
                    continue;
                let notificationAttempted = false;
                try {
                    await this.session(run.sessionId, run);
                    await this.restoreBody(run);
                    if (this.store.metadataOnly) {
                        // Fence uncertain delivery BEFORE the network call. A crash must never
                        // leave an attempted notification eligible for automatic replay.
                        run.notifyAttempts++;
                        run.notification = 'unknown';
                        run.lastError = 'NOTIFICATION_UNKNOWN';
                        run.updatedAt = Date.now();
                        this.store.save(run);
                    }
                    notificationAttempted = true;
                    await notify(run);
                    run.notification = 'sent';
                    run.lastError = '';
                }
                catch (error) {
                    if (!this.store.metadataOnly || !notificationAttempted)
                        run.notifyAttempts++;
                    run.lastError = errorCode(error);
                    if (this.store.metadataOnly) {
                        if (notificationAttempted)
                            run.notification = run.lastError === 'DM_FAILED' && run.notifyAttempts < 8 ? 'pending' : 'unknown';
                    }
                    run.nextNotifyAt = Date.now() + Math.min(3600000, 10000 * 2 ** Math.min(run.notifyAttempts, 9));
                }
                this.store.save(run);
            }
        }
        finally {
            this.ticking = false;
        }
    }
}
//# sourceMappingURL=engine.js.map