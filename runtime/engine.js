import { createHash } from 'node:crypto';
import { AppError, errorCode } from './errors.js';
import { DshRejected, object } from './protocol.js';
import { assistantText, boundedOutput, redact, finalAssistantText, digest, splitFinalOutput } from './output.js';
import { bindingKey } from './store.js';
import { terminal } from './types.js';
export class Engine {
    adapter;
    store;
    policy;
    secrets;
    sharedDiscordBindings;
    ticking = false;
    registerWorkspace;
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
        if (actor)
            this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        return allowed.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async session(sessionId, actor) {
        const session = (await this.adapter.list()).find(s => s.sessionId === sessionId && !s.subagent);
        if (!session)
            throw new AppError('SESSION_NOT_FOUND', 'DSHセッションが見つかりません。');
        await this.policy.requireCwd(session.cwd, actor.guildId);
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        return session;
    }
    key(actor) { return bindingKey(actor.guildId, actor.channelId, this.sharedDiscordBindings && actor.guildId !== 'telegram' ? 'shared' : actor.userId); }
    binding(actor) { return this.store.binding(this.key(actor)); }
    bindingVersion(actor) { return this.store.bindingVersion(this.key(actor)); }
    async selectedSession(actor) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        const id = this.binding(actor), version = this.bindingVersion(actor);
        const session = id ? await this.session(id, actor) : undefined;
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        if (this.binding(actor) !== id || this.bindingVersion(actor) !== version)
            throw new AppError('BINDING_CONFLICT', '選択が変更されました。再確認してください。');
        return { session, bindingVersion: version };
    }
    async bind(actor, sessionId, expectedVersion = this.bindingVersion(actor)) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        await this.session(sessionId, actor);
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        this.store.bind(this.key(actor), sessionId, expectedVersion, this.sharedDiscordBindings);
    }
    unbind(actor) { this.policy.authorize(actor.userId, actor.guildId, actor.channelId); this.store.unbind(this.key(actor)); }
    async create(actor, workspace) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        const cwd = this.policy.workspace(workspace, actor.guildId);
        await this.policy.requireCwd(cwd, actor.guildId);
        const expectedVersion = this.bindingVersion(actor);
        const sessionId = await this.adapter.create(cwd);
        try {
            await this.bind(actor, sessionId, expectedVersion);
        }
        catch {
            throw new AppError('CREATED_NOT_BOUND', `Session作成済み: ${sessionId}。選択は競合または認可変更により更新されませんでした。再作成せず確認してください。`);
        }
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
        const bindingVersion = this.bindingVersion(actor);
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
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        if (this.binding(actor) !== sessionId || this.bindingVersion(actor) !== bindingVersion)
            throw new AppError('BINDING_CONFLICT', '選択が変更されました。再確認してください。');
        const now = Date.now();
        const run = { id, requestId: `${actor.guildId === 'telegram' ? 'telegram' : 'discord'}:${id}`, sessionId, ...actor,
            state: 'dispatching', createdAt: now, updatedAt: now, lastSeq: snapshot.cursor, startSeq: snapshot.cursor, payloadDigest, turn: null,
            output: '', result: '', admitted: false, contaminated: false, bindingVersion,
            ...(this.store.metadataOnly && actor.guildId !== 'telegram' ? { notificationPreferences: this.notificationPreferences(actor) } : {}),
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
        if (terminal(run.state)) {
            run.bodyDigest = digest(run.result);
            this.planDelivery(run);
        }
        run.updatedAt = Date.now();
        this.store.save(run);
        return run;
    }
    checkOwner(actor, run) {
        if (run.userId !== actor.userId || run.guildId !== actor.guildId || run.channelId !== actor.channelId)
            throw new AppError('RUN_NOT_FOUND', 'この操作元の実行履歴が見つかりません。');
    }
    async status(actor, id, requireLiveAccess = true, hydrateBody = true) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        const run = id ? this.store.get(id) : this.store.latest(actor.userId, actor.guildId, actor.channelId);
        if (run) {
            this.checkOwner(actor, run);
            if (requireLiveAccess) {
                await this.session(run.sessionId, run);
                if (hydrateBody) {
                    await this.restoreBody(run);
                    await this.session(run.sessionId, run);
                }
                this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
                this.checkOwner(actor, run);
            }
        }
        return run;
    }
    notificationPreferences(actor) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        const raw = this.store.setting(`notifications:${this.key(actor)}:${actor.userId}`);
        let preferences = { destination: 'dm', progress: false };
        if (raw) {
            const saved = JSON.parse(raw);
            if (!['dm', 'origin'].includes(saved.destination) || typeof saved.progress !== 'boolean')
                throw new AppError('DB_CORRUPT', '通知設定を読み込めません。');
            preferences = saved;
        }
        const runs = this.store.allRuns().filter(run => run.userId === actor.userId && run.guildId === actor.guildId && run.channelId === actor.channelId);
        const parts = runs.flatMap(run => run.delivery?.parts ?? []);
        return { ...preferences, pending: runs.filter(run => run.notification === 'pending').length,
            unknown: runs.filter(run => run.notification === 'unknown' || run.delivery?.parts.some(part => part.state === 'unknown' || part.state === 'sending')).length,
            blocked: runs.filter(run => run.delivery?.parts.some(part => part.state === 'blocked')).length,
            incomplete: runs.filter(run => run.delivery && !run.delivery.complete).length,
            undeliveredParts: parts.filter(part => part.state !== 'sent').length };
    }
    setNotificationPreferences(actor, preferences, confirmOrigin = false) {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        if (!['dm', 'origin'].includes(preferences.destination) || preferences.progress !== undefined && typeof preferences.progress !== 'boolean')
            throw new AppError('PREFERENCE_INVALID', '通知設定が不正です。');
        if (preferences.destination === 'origin' && (!confirmOrigin || actor.guildId === 'telegram'))
            throw new AppError('CONFIRMATION_REQUIRED', '元のサーバー会話への公開配信には明示確認が必要です。');
        if (preferences.progress === true)
            throw new AppError('PROGRESS_UNSUPPORTED', '途中通知は未対応です。全文完了通知のみ利用できます。');
        const current = this.notificationPreferences(actor);
        this.store.setSetting(`notifications:${this.key(actor)}:${actor.userId}`, JSON.stringify({ destination: preferences.destination, progress: preferences.progress ?? current.progress }));
    }
    async resultPage(actor, id, page = 1) {
        const run = await this.status(actor, id);
        if (!run)
            throw new AppError('RUN_NOT_FOUND', 'この操作元の実行履歴が見つかりません。');
        const text = terminal(run.state) ? run.result : run.contaminated ? '混在した出力は表示できません。' : run.output || run.result || 'テキスト出力はまだありません。';
        // Manual pages are independent of the automatic delivery cap.
        const plan = splitFinalOutput(text, run.id, false);
        if (!Number.isSafeInteger(page) || page < 1 || page > plan.parts.length)
            throw new AppError('PAGE_INVALID', `ページは1〜${plan.parts.length}で指定してください。`);
        return { content: plan.parts[page - 1].content, page, pages: plan.parts.length };
    }
    async retryNotification(actor, id, part, confirmDuplicateRisk = false) {
        if (this.ticking)
            throw new AppError('DELIVERY_BUSY', '配信処理中です。後で再確認してください。');
        const run = await this.status(actor, id);
        if (this.ticking)
            throw new AppError('DELIVERY_BUSY', '配信処理中です。後で再確認してください。');
        if (!run || !terminal(run.state))
            throw new AppError('RUN_NOT_FINISHED', '完了した実行IDを指定してください。');
        if (run.delivery) {
            const next = run.delivery.parts.find(p => p.state !== 'sent');
            if (!next)
                return; // Sent parts are never replayed.
            if (part !== undefined && part !== next.index)
                throw new AppError('PART_ORDER', '未確定の先頭partだけを再試行できます。');
            if (next.nextAttemptAt > Date.now())
                throw new AppError('DELIVERY_RATE_LIMIT', 'Discord指定の待機時間が残っています。期限後に再試行してください。');
            if (next.state === 'sending' || next.state === 'unknown') {
                if (!confirmDuplicateRisk)
                    throw new AppError('DUPLICATE_RISK_CONFIRMATION_REQUIRED', '配送不明です。重複リスクを明示確認して再試行してください。');
            }
            this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
            next.state = 'pending';
            next.nextAttemptAt = 0;
            next.lastError = '';
        }
        else if (run.notification === 'unknown')
            throw new AppError('NOTIFICATION_UNKNOWN', '旧配送の不明な通知は再送できません。/agent resultで確認してください。');
        else if (this.store.metadataOnly && run.guildId !== 'telegram' && run.notification === 'sent')
            return; // Legacy sent receipts are not adopted into a new plan.
        run.notification = 'pending';
        run.notifyAttempts = 0;
        run.nextNotifyAt = 0;
        this.store.save(run);
    }
    planDelivery(run) {
        if (!this.store.metadataOnly || run.guildId === 'telegram' || !terminal(run.state) || run.delivery)
            return;
        // Legacy unknown has no trustworthy per-part receipt. Never adopt/replay it.
        if (run.notification === 'unknown' || run.notification === 'sent')
            return;
        let plan;
        try {
            plan = splitFinalOutput(run.result, run.id);
        }
        catch {
            run.notification = 'none';
            run.lastError = 'OUTPUT_UNAVAILABLE';
            return;
        }
        run.bodyExpiresAt ??= Date.now() + 7 * 24 * 60 * 60 * 1000;
        const preferences = run.notificationPreferences ?? { destination: 'dm', progress: false };
        run.bodyDigest = digest(run.result);
        run.delivery = { id: run.id, destination: preferences.destination, userId: run.userId, guildId: run.guildId, channelId: run.channelId,
            bodyDigest: run.originalFinalDigest ?? run.bodyDigest, digest: plan.digest, complete: plan.complete, codepoints: plan.codepoints,
            parts: plan.parts.map((part, index) => ({ index: index + 1, state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: '', digest: digest(part.content) })) };
    }
    async restoreBody(run) {
        if (this.store.metadataOnly && run.bodyExpiresAt !== undefined && Date.now() >= run.bodyExpiresAt)
            throw new AppError('BODY_EXPIRED', '本文の保持期限（7日）を過ぎました。PCの同一Sessionで確認してください。');
        if (!run.bodyMissing)
            return;
        if (run.state === 'failed' && !run.admitted) {
            const text = 'DSHが送信を拒否しました。設定とセッション状態を確認してください。';
            if (run.bodyDigest !== digest(text))
                throw new AppError('BODY_DIGEST_MISMATCH', '結果本文を検証できません。');
            run.result = text;
            delete run.bodyMissing;
            this.store.save(run);
            return;
        }
        if (run.startSeq === undefined)
            throw new AppError('BODY_UNAVAILABLE', '本文の復元情報がありません。PCで確認してください。');
        const previousState = run.state;
        const replay = { ...run, state: 'unknown', lastSeq: run.startSeq, turn: null, admitted: false, contaminated: false, output: '', result: '', finalText: undefined, originalFinalDigest: undefined, delivery: undefined };
        const snapshot = await this.adapter.snapshot(run.sessionId);
        this.consume(replay, await this.adapter.events(run.sessionId, snapshot.cursor, run.startSeq));
        if (terminal(previousState) && (!replay.admitted || replay.turn === null || replay.state !== previousState))
            throw new AppError('BODY_UNAVAILABLE', '結果を安全に復元できません。PCで確認してください。');
        if (terminal(previousState) && this.store.metadataOnly) {
            if (!run.bodyDigest || digest(replay.result) !== run.bodyDigest || run.originalFinalDigest !== undefined && replay.originalFinalDigest !== run.originalFinalDigest)
                throw new AppError('BODY_DIGEST_MISMATCH', '本文digestを検証できません。PCの同一Sessionで確認してください。');
        }
        // Preserve persisted notification ownership/retry state; only hydrate correlated native text.
        run.output = replay.output;
        run.result = replay.result;
        run.finalText = replay.finalText;
        run.originalFinalDigest = replay.originalFinalDigest;
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
        this.planDelivery(run);
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
                if (this.store.metadataOnly && run.guildId !== 'telegram') {
                    const final = finalAssistantText(event.data);
                    run.finalText = final === undefined ? undefined : redact(final, this.secrets);
                    run.originalFinalDigest = final === undefined ? undefined : digest(final);
                    // Restricted output is the latest correlated assistant text only; no
                    // reasoning/tools/intermediate concatenation or silent tail cap.
                    run.output = run.finalText ?? '';
                }
                else if (text)
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
            run.bodyDigest = digest(run.result);
            this.planDelivery(run);
            return;
        }
    }
    async deliverParts(run, notify) {
        const delivery = run.delivery;
        let plan;
        try {
            this.policy.authorize(run.userId, run.guildId, run.channelId);
            if (delivery.id !== run.id || delivery.userId !== run.userId || delivery.guildId !== run.guildId || delivery.channelId !== run.channelId || !['dm', 'origin'].includes(delivery.destination))
                throw new AppError('DELIVERY_BLOCKED', '固定された通知先が一致しません。');
            await this.session(run.sessionId, run);
            await this.restoreBody(run);
            plan = splitFinalOutput(run.result, run.id);
            if (plan.digest !== delivery.digest || plan.parts.length !== delivery.parts.length || plan.parts.some((p, i) => delivery.parts[i].index !== i + 1 || digest(p.content) !== delivery.parts[i].digest))
                throw new AppError('BODY_DIGEST_MISMATCH', '結果本文を検証できません。');
        }
        catch (error) {
            const first = delivery.parts.find(p => p.state !== 'sent');
            if (first && first.state !== 'unknown' && first.state !== 'sending') {
                first.state = 'blocked';
                first.lastError = errorCode(error);
            }
            run.lastError = errorCode(error);
            run.notification = delivery.parts.some(p => p.state === 'unknown' || p.state === 'sending') ? 'unknown' : 'none';
            this.store.save(run);
            return;
        }
        for (const part of delivery.parts) {
            if (part.state === 'sent')
                continue;
            if (part.state !== 'pending' || part.nextAttemptAt > Date.now())
                return;
            try {
                this.policy.authorize(run.userId, run.guildId, run.channelId);
                await this.session(run.sessionId, run);
            }
            catch (error) {
                part.state = 'blocked';
                part.lastError = errorCode(error);
                run.lastError = part.lastError;
                run.notification = 'none';
                this.store.save(run);
                return;
            }
            // The durable uncertainty fence is committed before ANY send. A crash
            // after Discord success but before message ID persistence holds the tail.
            part.state = 'sending';
            part.attempts++;
            run.notifyAttempts++;
            run.notification = 'unknown';
            run.lastError = 'NOTIFICATION_UNKNOWN';
            this.store.save(run);
            let receipt;
            try {
                receipt = await notify(run, { index: part.index, content: plan.parts[part.index - 1].content });
            }
            catch (error) {
                const code = errorCode(error);
                part.lastError = code;
                run.lastError = code;
                if (code === 'DELIVERY_RATE_LIMIT') {
                    const retryAfterMs = error && typeof error === 'object' && 'retryAfterMs' in error ? Number(error.retryAfterMs) : NaN;
                    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
                        part.state = 'pending';
                        part.nextAttemptAt = Date.now() + Math.max(1, retryAfterMs);
                        run.nextNotifyAt = part.nextAttemptAt;
                        run.notification = 'pending';
                    }
                    else {
                        part.state = 'unknown';
                        run.notification = 'unknown';
                    }
                }
                else if (['DELIVERY_BLOCKED', 'DM_FAILED', 'NOT_AUTHORIZED', 'CWD_NOT_ALLOWED'].includes(code)) {
                    part.state = 'blocked';
                    run.notification = 'none';
                }
                else {
                    part.state = 'unknown';
                    run.notification = 'unknown';
                }
                this.store.save(run);
                return;
            }
            if (!receipt || !receipt.messageId) {
                part.state = 'unknown';
                part.lastError = 'MESSAGE_ID_UNAVAILABLE';
                run.notification = 'unknown';
                this.store.save(run);
                return;
            }
            part.state = 'sent';
            part.messageId = receipt.messageId;
            part.lastError = '';
            run.lastError = '';
            run.notification = delivery.parts.every(p => p.state === 'sent') ? 'sent' : 'pending';
            run.nextNotifyAt = 0;
            // If this write fails, do not catch/rewrite the pre-send fence. On restart
            // sending becomes unknown, and even this process must not send the tail.
            this.store.save(run);
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
                if (this.store.metadataOnly && run.guildId !== 'telegram') {
                    if (!run.delivery) {
                        // No digest on a legacy terminal row means no trustworthy baseline.
                        if (!run.bodyDigest) {
                            run.lastError = 'BODY_UNAVAILABLE';
                            run.notification = 'none';
                            this.store.save(run);
                            continue;
                        }
                        try {
                            await this.restoreBody(run);
                            this.planDelivery(run);
                            this.store.save(run);
                        }
                        catch (error) {
                            run.lastError = errorCode(error);
                            run.notification = 'none';
                            this.store.save(run);
                            continue;
                        }
                    }
                    if (run.delivery)
                        await this.deliverParts(run, notify);
                    continue;
                }
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