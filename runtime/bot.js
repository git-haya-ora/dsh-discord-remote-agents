import { AttachmentBuilder, Client, Events, GatewayIntentBits, MessageFlags, escapeMarkdown } from 'discord.js';
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
    return `実行ID: ${run.id}\nセッション: ${escapeMarkdown(run.sessionId)}\n状態: ${STATES[run.state]}\nDM配信: ${run.notification}${run.lastError ? `\n接続・配信情報: ${run.lastError}` : ''}`;
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
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    timer;
    pendingTick;
    stopping = false;
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
    tick() {
        if (this.pendingTick || this.stopping)
            return;
        this.pendingTick = this.engine.tick(this.notificationRouter ?? ((run, part) => this.notify(run, part))).catch(error => console.error(`[MONITOR_ERROR] ${errorCode(error)}`)).finally(() => { this.pendingTick = undefined; });
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
                const channel = await this.client.channels.fetch(run.delivery.channelId);
                if (!channel || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== run.delivery.guildId)
                    throw new AppError('DELIVERY_BLOCKED', '元の通知先へ配信できません。');
                this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
                const sent = await channel.send(options);
                return { messageId: sent.id };
            }
            const user = await this.client.users.fetch(run.delivery?.userId ?? run.userId);
            this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
            const sent = await user.send(options);
            return { messageId: sent.id };
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            const raw = error && typeof error === 'object' ? error : {};
            if (this.textOnly || part) {
                if (raw.status === 429) {
                    const seconds = Number(raw.retry_after ?? raw.rawError?.retry_after);
                    const rateLimit = new AppError('DELIVERY_RATE_LIMIT', 'Discordの指定待機後に再試行します。');
                    Object.assign(rateLimit, { retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : NaN });
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
        try {
            this.engine.policy.authorize(interaction.user.id, interaction.guildId, interaction.channelId);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const { content, files = [] } = await handleAgentCommand(interaction, this.engine, this.config, this.textOnly);
            this.engine.policy.authorize(interaction.user.id, interaction.guildId, interaction.channelId);
            await interaction.editReply({ content, files: this.textOnly ? [] : files, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
        }
        catch (error) {
            const content = safeError(error);
            try {
                if (interaction.deferred || interaction.replied)
                    await interaction.editReply({ content, allowedMentions: { parse: [] } });
                else
                    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            catch {
                console.error('[INTERACTION_REPLY_FAILED] 返信できません。実行IDは/agent statusで確認できます。');
            }
        }
    }
    async stop() {
        this.stopping = true;
        if (this.timer)
            clearInterval(this.timer);
        await Promise.allSettled([...this.handling]);
        await this.pendingTick;
        await this.client.destroy();
    }
}
//# sourceMappingURL=bot.js.map