import { AttachmentBuilder, Client, Events, GatewayIntentBits, MessageFlags, escapeMarkdown } from 'discord.js';
import { AppError, errorCode, safeError } from './errors.js';
import { HELP } from './commands.js';
import { redact, tail } from './output.js';
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
    const content = `${runSummary(run)}\n\n${tail(text, 1200)}${textOnly && text.length > 1200 ? '\n全文はPCの同一Sessionで確認してください（添付は無効です）。' : ''}`;
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
        this.pendingTick = this.engine.tick(this.notificationRouter ?? (run => this.notify(run))).catch(error => console.error(`[MONITOR_ERROR] ${errorCode(error)}`)).finally(() => { this.pendingTick = undefined; });
    }
    async notify(run) {
        if (run.guildId !== this.config.guildId)
            throw new AppError('TRANSPORT_MISMATCH', '通知先が一致しません。');
        try {
            const user = await this.client.users.fetch(run.userId);
            await user.send({ ...resultPayload(run, this.textOnly), allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds, nonce: run.id, enforceNonce: true });
        }
        catch (error) {
            // A response lost after send is not proof of non-delivery. Restricted Host never replays it.
            if (this.textOnly) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                if (code !== 50007 && code !== 50013 && code !== 50001)
                    throw new AppError('NOTIFICATION_UNKNOWN', '通知の送信結果が不明です。再送せず/agent resultで確認してください。');
            }
            throw new AppError('DM_FAILED', 'DMを配信できません。/agent resultで確認してください。');
        }
    }
    async handle(interaction) {
        try {
            this.engine.policy.authorize(interaction.user.id, interaction.guildId, interaction.channelId);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const actor = { userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId };
            const sub = interaction.options.getSubcommand();
            let content;
            let files = [];
            switch (sub) {
                case 'sessions': {
                    const sessions = await this.engine.sessions(actor);
                    const page = interaction.options.getInteger('page') ?? 1;
                    const size = 3;
                    const count = Math.max(1, Math.ceil(sessions.length / size));
                    if (page > count)
                        throw new AppError('PAGE_INVALID', `ページは1〜${count}で指定してください。`);
                    const lines = sessions.slice((page - 1) * size, page * size).map(s => `${escapeMarkdown(tail(s.sessionId, 200))} | ${s.running ? '実行中' : '待機'} | ${escapeMarkdown(Array.from(this.engine.redactText(redact(s.title, [this.config.token, this.config.dshToken]))).slice(0, 50).join('').replace(/[\r\n]/g, ' '))}`);
                    content = `既存セッション ${page}/${count}（${sessions.length}件）\n${lines.join('\n') || '許可フォルダーのセッションはありません。'}\n/agent bind session:IDで選択`;
                    break;
                }
                case 'bind': {
                    const id = interaction.options.getString('session', true);
                    await this.engine.bind(actor, id);
                    content = `選択しました: ${escapeMarkdown(id)}\n${this.engine.sharedDiscordBindings ? '選択はこのサーバー・チャンネルで共有されます。' : '選択はこの操作元のあなた専用です。'}`;
                    break;
                }
                case 'new': {
                    const id = await this.engine.create(actor, interaction.options.getString('workspace', true));
                    content = `新規セッションを作成・選択しました: ${escapeMarkdown(id)}`;
                    break;
                }
                case 'unbind':
                    this.engine.unbind(actor);
                    content = '選択を解除しました。既存の実行は継続します。';
                    break;
                case 'prompt': {
                    const run = await this.engine.submit(actor, interaction.id, interaction.options.getString('text', true));
                    content = `${runSummary(run)}\n完了はDMまたは/agent resultで確認してください。`;
                    break;
                }
                case 'status':
                case 'result': {
                    const run = await this.engine.status(actor, interaction.options.getString('run') ?? undefined, sub === 'result');
                    if (!run) {
                        content = `この操作元の実行履歴はありません。\n選択: ${escapeMarkdown(this.engine.binding(actor) ?? 'なし')}`;
                        break;
                    }
                    if (sub === 'status')
                        content = runSummary(run);
                    else
                        ({ content, files } = resultPayload(run, this.textOnly));
                    break;
                }
                case 'notify':
                    await this.engine.retryNotification(actor, interaction.options.getString('run', true));
                    content = 'DM再配信を予約しました。';
                    break;
                case 'help':
                    content = this.engine.sharedDiscordBindings ? HELP.replace('自分用に選択', 'チャンネルで共有選択').replace('選択はユーザー×サーバー×チャンネルごと', '選択はサーバー×チャンネルごと') + '\n制限版: Desktop同時送信は非対応。長文はPCの同一Sessionで確認（添付なし）。' : HELP;
                    break;
                default: throw new AppError('UNKNOWN_COMMAND', '未対応コマンドです。');
            }
            if (this.textOnly) {
                files = [];
                if (content.length > 1900)
                    content = tail(content, 1900);
            }
            await interaction.editReply({ content, files, allowedMentions: { parse: [] } });
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