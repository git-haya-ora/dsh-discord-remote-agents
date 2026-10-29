import { randomUUID } from 'node:crypto';
import { connectionNotice } from './connection-notice.js';
import { AttachmentBuilder, Client, Events, GatewayIntentBits, MessageFlags, RateLimitError, escapeMarkdown } from 'discord.js';
import { AppError, errorCode, safeError } from './errors.js';
import { handleAgentCommand } from './command-handler.js';
import { digest, splitFinalOutput } from './output.js';
import { tail } from './output.js';
import { terminal } from './types.js';
const STATES = {
    dispatching: '送信中', accepted: 'DSH受付済み（完了ではありません）', running: '実行中',
    unknown: '送信結果不明・履歴照合中（再送禁止）', succeeded: '完了', failed: '失敗', interrupted: '中断'
};
export function runSummary(run) {
    const workNotice = { ready: '開始確認済み・送信待ち', sent: '送信済み', unknown: '配送不明（自動再送しない）', blocked: 'blocked', suppressed: '抑制' }[run.workNotice] ?? '未開始';
    return `実行ID: ${run.id}\nセッション: ${escapeMarkdown(run.sessionId)}\n状態: ${STATES[run.state]}\n作業開始通知: ${workNotice}\nDM配信: ${run.notification}${run.lastError ? `\n接続・配信情報: ${run.lastError}` : ''}`;
}
export function resultPayload(run, textOnly = false) {
    const text = terminal(run.state) ? run.result : run.contaminated ? '指示が混在したため途中出力を非表示にしました。' : run.output || run.result || 'テキスト出力はまだありません。';
    if (textOnly)
        return { content: splitFinalOutput(text, run.id, false).parts[0].content, files: [] };
    const content = `${runSummary(run)}\n\n${tail(text, 1200)}`;
    return { content, files: !textOnly && text.length > 1200 ? [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `result-${run.id}.txt` })] : [] };
}
export class DiscordBot {
    config;
    engine;
    notificationRouter;
    textOnly;
    // SDK POST retries would bypass the durable unknown fence. Let the Engine own explicit 429 waits.
    client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0, rejectOnRateLimit: ['/channels', '/users'] } });
    timer;
    pendingTick;
    stopping = false;
    connectionNoticeAbort = new AbortController();
    workingNoticeAbort = new AbortController();
    terminalNoticeAbort = new AbortController();
    connectionNoticeTask;
    // The raced metadata operation can still access the Store after the caller
    // times out or aborts; keep it alive and drain it before closing the Store.
    connectionMetadataTasks = new Set();
    stopTask;
    connectionNoticeId = randomUUID();
    handling = new Set();
    constructor(config, engine, notificationRouter, textOnly = false) {
        this.config = config;
        this.engine = engine;
        this.notificationRouter = notificationRouter;
        this.textOnly = textOnly;
        this.client.on(Events.InteractionCreate, interaction => {
            if (!interaction.isChatInputCommand() || interaction.user.bot || interaction.commandName !== 'agent' || this.stopping)
                return;
            const task = this.handle(interaction);
            this.handling.add(task);
            void task.finally(() => this.handling.delete(task));
        });
        this.client.on(Events.Error, () => console.error('[DISCORD_CONNECTION_ERROR] Discordへの接続を確認してください。'));
        this.client.once(Events.ClientReady, () => {
            if (this.stopping)
                return;
            console.log('[READY] Bot接続済み。操作は許可ユーザー・チャンネル限定です。');
            this.tick();
            this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs);
        });
    }
    async start() {
        try {
            await this.client.login(this.config.token);
        }
        catch {
            throw new AppError('DISCORD_AUTH', 'Discordに接続できません。Botトークンとネットワークを確認してください。');
        }
    }
    /** Once per explicit receiver start, never on polling or a gateway-ready replay. */
    notifyConnected() {
        if (!this.connectionNoticeTask)
            this.connectionNoticeTask = this.sendConnectionNotices();
        return this.connectionNoticeTask;
    }
    async waitForConnectionNoticeOperation(operation) {
        if (this.connectionNoticeAbort.signal.aborted)
            throw new AppError('DELIVERY_BLOCKED', '接続通知は停止されています。');
        let timer;
        let onAbort;
        const aborted = new Promise((_resolve, reject) => {
            onAbort = () => reject(new AppError('DELIVERY_BLOCKED', '接続通知は停止されています。'));
            this.connectionNoticeAbort.signal.addEventListener('abort', onAbort, { once: true });
        });
        const deadline = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new AppError('CONNECTION_NOTICE_TIMEOUT', '接続通知処理が期限内に完了しませんでした。')), 10_000);
        });
        try {
            return await Promise.race([operation, aborted, deadline]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (onAbort)
                this.connectionNoticeAbort.signal.removeEventListener('abort', onAbort);
        }
    }
    async sendConnectionNotices() {
        let sent = 0, failed = 0;
        const settings = this.config.connectionNotifications;
        if (!settings?.dm && !settings?.channels)
            return { sent, failed };
        if (!this.client.isReady() || this.stopping)
            return { sent, failed: 1 };
        const users = [...this.config.allowedUserIds], channels = [...this.config.allowedChannelIds];
        const deliver = async (kind, id, actors) => {
            const key = `connection-notice:${this.connectionNoticeId}:${kind}:${id}`;
            try {
                for (const actor of actors)
                    this.engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
                const target = kind === 'dm' ? await this.waitForConnectionNoticeOperation(this.client.users.fetch(id)) : await this.waitForConnectionNoticeOperation(this.client.channels.fetch(id));
                if (!target || kind === 'channel' && (!('isSendable' in target) || !target.isSendable() || !('guildId' in target) || target.guildId !== this.config.guildId))
                    throw new AppError('DELIVERY_BLOCKED', '通知先を確認できません。');
                const metadataTask = connectionNotice(this.engine, this.config, actors);
                this.connectionMetadataTasks.add(metadataTask);
                void metadataTask.then(() => this.connectionMetadataTasks.delete(metadataTask), () => this.connectionMetadataTasks.delete(metadataTask));
                const notice = await this.waitForConnectionNoticeOperation(metadataTask);
                // User.send() opens a DM internally before sending; separate that await so
                // stop, authorization and binding changes are checked before disclosure.
                notice.assertCurrent();
                if (this.stopping || !this.client.isReady())
                    throw new AppError('DELIVERY_BLOCKED', '通知は停止されました。');
                if (kind === 'dm' && !('createDM' in target))
                    throw new AppError('DELIVERY_BLOCKED', 'DM先を確認できません。');
                const destination = kind === 'dm' && 'createDM' in target
                    ? await this.waitForConnectionNoticeOperation(target.createDM()) : target;
                notice.assertCurrent();
                if (this.stopping || !this.client.isReady() || !(kind === 'dm' ? this.config.connectionNotifications?.dm : this.config.connectionNotifications?.channels))
                    throw new AppError('DELIVERY_BLOCKED', '通知は停止されました。');
                if (!this.engine.store.claimReceipt(key))
                    return;
                // Persist the uncertainty fence before Discord may accept a message. No body is stored.
                this.engine.store.setSetting(key, JSON.stringify({ state: 'unknown' }));
                const send = destination;
                const receipt = await this.waitForConnectionNoticeOperation(send.send({ content: notice.content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds,
                    nonce: digest(key).slice(0, 24), enforceNonce: true }));
                if (!receipt || typeof receipt.id !== 'string' || !/^\d{17,20}$/.test(receipt.id))
                    throw new AppError('NOTIFICATION_UNKNOWN', '通知の受領を確認できません。');
                this.engine.store.setSetting(key, JSON.stringify({ state: 'sent', messageId: receipt.id }));
                sent++;
            }
            catch {
                failed++; /* Never retry, redirect, echo an error, or replay a Native prompt. */
            }
        };
        if (settings.dm)
            for (const userId of users) {
                if (this.stopping)
                    break;
                await deliver('dm', userId, channels.map(channelId => ({ userId, guildId: this.config.guildId, channelId })));
            }
        if (settings.channels)
            for (const channelId of channels) {
                if (this.stopping)
                    break;
                if (users[0])
                    await deliver('channel', channelId, [{ userId: users[0], guildId: this.config.guildId, channelId }]);
            }
        return { sent, failed };
    }
    tick() {
        if (this.pendingTick || this.stopping)
            return;
        this.pendingTick = this.engine.tick(this.notificationRouter ?? ((run, part) => this.notify(run, part)), run => this.notifyWorking(run))
            .catch(error => console.error(`[MONITOR_ERROR] ${errorCode(error)}`)).finally(() => { this.pendingTick = undefined; });
    }
    async waitForWorkingNoticeOperation(operation, sendStarted) {
        const failure = () => sendStarted
            ? new AppError('NOTIFICATION_UNKNOWN', '作業開始通知の送信結果が不明です。自動再送しません。')
            : new AppError('DELIVERY_BLOCKED', '作業開始通知の宛先確認を完了できませんでした。');
        if (this.workingNoticeAbort.signal.aborted || this.stopping)
            throw failure();
        let timer;
        let onAbort;
        const aborted = new Promise((_resolve, reject) => {
            onAbort = () => reject(failure());
            this.workingNoticeAbort.signal.addEventListener('abort', onAbort, { once: true });
        });
        const deadline = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(failure()), 10_000);
        });
        try {
            return await Promise.race([operation, aborted, deadline]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (onAbort)
                this.workingNoticeAbort.signal.removeEventListener('abort', onAbort);
        }
    }
    async notifyWorking(run) {
        const preferences = run.notificationPreferences;
        let sendStarted = false;
        if (run.guildId !== this.config.guildId || !preferences || !['dm', 'origin'].includes(preferences.destination))
            throw new AppError('DELIVERY_BLOCKED', '作業開始通知先を確認できません。');
        this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
        if (this.stopping || !this.client.isReady())
            throw new AppError('DELIVERY_BLOCKED', '作業開始通知は停止されています。');
        const content = `作業中 — Run ${run.id}`;
        const options = { content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds,
            nonce: digest(`${run.id}:work-start`).slice(0, 24), enforceNonce: true };
        try {
            if (preferences.destination === 'origin') {
                const channel = await this.waitForWorkingNoticeOperation(this.client.channels.fetch(run.channelId), false);
                if (!channel || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== run.guildId)
                    throw new AppError('DELIVERY_BLOCKED', '固定された作業開始通知先を確認できません。');
                this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
                if (this.stopping || !this.client.isReady())
                    throw new AppError('DELIVERY_BLOCKED', '作業開始通知は停止されています。');
                sendStarted = true;
                const sent = await this.waitForWorkingNoticeOperation(channel.send(options), true);
                if (!/^\d{17,20}$/u.test(sent.id))
                    throw new AppError('NOTIFICATION_UNKNOWN', '作業開始通知の受領を確認できません。');
                return { messageId: sent.id };
            }
            const user = await this.waitForWorkingNoticeOperation(this.client.users.fetch(run.userId), false);
            if (!user || user.id !== run.userId)
                throw new AppError('DELIVERY_BLOCKED', '固定された作業開始DM先を確認できません。');
            this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
            if (this.stopping || !this.client.isReady())
                throw new AppError('DELIVERY_BLOCKED', '作業開始通知は停止されています。');
            const dm = await this.waitForWorkingNoticeOperation(user.createDM(), false);
            this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
            if (this.stopping || !this.client.isReady())
                throw new AppError('DELIVERY_BLOCKED', '作業開始通知は停止されています。');
            sendStarted = true;
            const sent = await this.waitForWorkingNoticeOperation(dm.send(options), true);
            if (!/^\d{17,20}$/u.test(sent.id))
                throw new AppError('NOTIFICATION_UNKNOWN', '作業開始通知の受領を確認できません。');
            return { messageId: sent.id };
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            const raw = error && typeof error === 'object' ? error : {};
            if ([50007, 50013, 50001, 10003, 10013].includes(Number(raw.code)) || raw.status === 403 || raw.status === 401)
                throw new AppError('DELIVERY_BLOCKED', '固定された作業開始通知先へ配信できません。');
            if (sendStarted)
                throw new AppError('NOTIFICATION_UNKNOWN', '作業開始通知の送信結果が不明です。自動再送しません。');
            throw new AppError('DELIVERY_BLOCKED', '作業開始通知の宛先確認を完了できませんでした。');
        }
    }
    async waitForTerminalNoticeOperation(operation, sendStarted) {
        const failure = () => sendStarted
            ? new AppError('NOTIFICATION_UNKNOWN', '通知の送信結果が不明です。自動再送しません。')
            : new AppError('DELIVERY_BLOCKED', '通知の宛先確認を完了できませんでした。');
        const signal = this.terminalNoticeAbort.signal;
        if (signal.aborted || this.stopping)
            throw failure();
        let timer;
        let onAbort;
        const aborted = new Promise((_resolve, reject) => {
            onAbort = () => reject(failure());
            signal.addEventListener('abort', onAbort, { once: true });
        });
        const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(failure()), 10_000); });
        try {
            const value = await Promise.race([operation, aborted, deadline]);
            if (signal.aborted || this.stopping)
                throw failure();
            return value;
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (onAbort)
                signal.removeEventListener('abort', onAbort);
        }
    }
    async notify(run, part) {
        if (run.guildId !== this.config.guildId)
            throw new AppError('DELIVERY_BLOCKED', '通知先が一致しません。');
        this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
        if (run.delivery && (run.delivery.userId !== run.userId || run.delivery.guildId !== run.guildId || run.delivery.channelId !== run.channelId || !['dm', 'origin'].includes(run.delivery.destination)))
            throw new AppError('DELIVERY_BLOCKED', '固定された通知先が一致しません。');
        try {
            const payload = part ? { content: part.content, files: [] } : resultPayload(run, this.textOnly);
            const options = { ...payload, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds,
                nonce: digest(`${run.id}:${part?.index ?? 0}`).slice(0, 24), enforceNonce: true };
            if (run.delivery?.destination === 'origin') {
                if (run.delivery.guildId !== run.guildId || run.delivery.channelId !== run.channelId || run.delivery.userId !== run.userId)
                    throw new AppError('DELIVERY_BLOCKED', '固定された通知先が一致しません。');
                if (this.stopping || this.terminalNoticeAbort.signal.aborted)
                    throw new AppError('DELIVERY_BLOCKED', '通知は停止されています。');
                const channel = await this.waitForTerminalNoticeOperation(this.client.channels.fetch(run.delivery.channelId), false);
                if (!channel || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== run.delivery.guildId)
                    throw new AppError('DELIVERY_BLOCKED', '元の通知先へ配信できません。');
                this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
                if (this.stopping || this.terminalNoticeAbort.signal.aborted)
                    throw new AppError('DELIVERY_BLOCKED', '通知は停止されています。');
                const sent = await this.waitForTerminalNoticeOperation(channel.send(options), true);
                return { messageId: sent.id };
            }
            if (this.stopping || this.terminalNoticeAbort.signal.aborted)
                throw new AppError('DELIVERY_BLOCKED', '通知は停止されています。');
            const user = await this.waitForTerminalNoticeOperation(this.client.users.fetch(run.delivery?.userId ?? run.userId), false);
            this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
            if (this.stopping || this.terminalNoticeAbort.signal.aborted)
                throw new AppError('DELIVERY_BLOCKED', '通知は停止されています。');
            const dm = await this.waitForTerminalNoticeOperation(user.createDM(), false);
            this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
            if (this.stopping || this.terminalNoticeAbort.signal.aborted)
                throw new AppError('DELIVERY_BLOCKED', '通知は停止されています。');
            const sent = await this.waitForTerminalNoticeOperation(dm.send(options), true);
            return { messageId: sent.id };
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            const raw = error && typeof error === 'object' ? error : {};
            if (this.textOnly || part) {
                if (error instanceof RateLimitError) {
                    const rateLimit = new AppError('DELIVERY_RATE_LIMIT', 'Discordの指定待機後に再試行します。');
                    Object.assign(rateLimit, { retryAfterMs: Number.isFinite(error.retryAfter) && error.retryAfter > 0 && Number.isSafeInteger(Math.ceil(error.retryAfter)) ? Math.ceil(error.retryAfter) : NaN });
                    throw rateLimit;
                }
                if (raw.status === 429) {
                    const value = raw.retry_after ?? raw.rawError?.retry_after;
                    const seconds = typeof value === 'number' ? value : NaN;
                    const milliseconds = Math.ceil(seconds * 1000);
                    const rateLimit = new AppError('DELIVERY_RATE_LIMIT', 'Discordの指定待機後に再試行します。');
                    Object.assign(rateLimit, { retryAfterMs: seconds > 0 && Number.isSafeInteger(milliseconds) ? milliseconds : NaN });
                    throw rateLimit;
                }
                if ([50007, 50013, 50001, 10003, 10013].includes(Number(raw.code)) || raw.status === 403 || raw.status === 401)
                    throw new AppError('DELIVERY_BLOCKED', '通知先の権限不足またはDM拒否です。別宛先へ転送しません。');
                throw new AppError('NOTIFICATION_UNKNOWN', '通知の送信結果が不明です。自動再送しません。');
            }
            throw new AppError('DM_FAILED', 'DMを配信できません。/agent resultで確認してください。');
        }
    }
    async handle(interaction) {
        const replyFailed = () => console.error('[INTERACTION_REPLY_FAILED] 返信できません。実行IDは/agent statusで確認できます。');
        try {
            this.engine.policy.authorize(interaction.user.id, interaction.guildId, interaction.channelId);
        }
        catch (error) {
            try {
                await interaction.reply({ content: safeError(error), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            catch {
                replyFailed();
            }
            return;
        }
        // A rejected acknowledgement may nevertheless have reached Discord: never send a second ACK.
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }
        catch {
            replyFailed();
            return;
        }
        if (this.stopping)
            return;
        let payload;
        try {
            payload = await handleAgentCommand(interaction, this.engine, this.config, this.textOnly);
            this.engine.policy.authorize(interaction.user.id, interaction.guildId, interaction.channelId);
        }
        catch (error) {
            try {
                await interaction.editReply({ content: safeError(error), allowedMentions: { parse: [] } });
            }
            catch {
                replyFailed();
            }
            return;
        }
        // An edit failure is also ambiguous; do not overwrite a possibly delivered result.
        try {
            await interaction.editReply({ content: payload.content, files: this.textOnly ? [] : payload.files ?? [], allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
        }
        catch {
            replyFailed();
        }
    }
    async stop() {
        if (this.stopTask)
            return this.stopTask;
        this.stopping = true;
        this.connectionNoticeAbort.abort();
        this.workingNoticeAbort.abort();
        this.terminalNoticeAbort.abort();
        if (this.timer)
            clearInterval(this.timer);
        this.stopTask = (async () => {
            await Promise.allSettled([...this.handling]);
            await this.pendingTick;
            await this.connectionNoticeTask;
            await Promise.allSettled([...this.connectionMetadataTasks]);
            await this.client.destroy();
        })();
        return this.stopTask;
    }
}
//# sourceMappingURL=bot.js.map