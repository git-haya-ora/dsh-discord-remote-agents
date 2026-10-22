import { randomUUID } from 'node:crypto';
import { connectionNotice } from './connection-notice.js';
import { AttachmentBuilder, Client, Events, GatewayIntentBits, MessageFlags, RateLimitError, escapeMarkdown, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from './config.js';
import { AppError, errorCode, safeError } from './errors.js';
import { Engine, type Actor, type Notify } from './engine.js';
import { handleAgentCommand } from './command-handler.js';
import { digest, splitFinalOutput } from './output.js';
import { redact, tail } from './output.js';
import { terminal, type Run } from './types.js';
const STATES: Record<Run['state'], string> = {
  dispatching: '送信中', accepted: 'DSH受付済み（完了ではありません）', running: '実行中',
  unknown: '送信結果不明・履歴照合中（再送禁止）', succeeded: '完了', failed: '失敗', interrupted: '中断'
};
export function runSummary(run: Run): string {
  const workNotice = ({ ready: '開始確認済み・送信待ち', sent: '送信済み', unknown: '配送不明（自動再送しない）', blocked: 'blocked', suppressed: '抑制' } as const)[run.workNotice as 'ready' | 'sent' | 'unknown' | 'blocked' | 'suppressed'] ?? '未開始';
  return `実行ID: ${run.id}\nセッション: ${escapeMarkdown(run.sessionId)}\n状態: ${STATES[run.state]}\n作業開始通知: ${workNotice}\nDM配信: ${run.notification}${run.lastError ? `\n接続・配信情報: ${run.lastError}` : ''}`;
}
export function resultPayload(run: Run, textOnly = false): { content: string; files: AttachmentBuilder[] } {
  const text = terminal(run.state) ? run.result : run.contaminated ? '指示が混在したため途中出力を非表示にしました。' : run.output || run.result || 'テキスト出力はまだありません。';
  if (textOnly) return { content: splitFinalOutput(text, run.id, false).parts[0]!.content, files: [] };
  const content = `${runSummary(run)}\n\n${tail(text, 1200)}`;
  return { content, files: !textOnly && text.length > 1200 ? [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `result-${run.id}.txt` })] : [] };
}
export class DiscordBot {
  // SDK POST retries would bypass the durable unknown fence. Let the Engine own explicit 429 waits.
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0, rejectOnRateLimit: ['/channels', '/users'] } });
  private timer: NodeJS.Timeout | undefined;
  private pendingTick: Promise<void> | undefined;
  private stopping = false;
  private readonly connectionNoticeAbort = new AbortController();
  private connectionNoticeTask: Promise<{ sent: number; failed: number }> | undefined;
  private readonly connectionNoticeId = randomUUID();
  private readonly handling = new Set<Promise<void>>();
  constructor(private readonly config: Config, private readonly engine: Engine, private readonly notificationRouter?: Notify, private readonly textOnly = false) {
    this.client.on(Events.InteractionCreate, interaction => {
      if (!interaction.isChatInputCommand() || interaction.user.bot || interaction.commandName !== 'agent' || this.stopping) return;
      const task = this.handle(interaction); this.handling.add(task);
      void task.finally(() => this.handling.delete(task));
    });
    this.client.on(Events.Error, () => console.error('[DISCORD_CONNECTION_ERROR] Discordへの接続を確認してください。'));
    this.client.once(Events.ClientReady, () => {
      console.log('[READY] Bot接続済み。操作は許可ユーザー・チャンネル限定です。');
      this.tick(); this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs);
    });
  }
  async start(): Promise<void> {
    try { await this.client.login(this.config.token); }
    catch { throw new AppError('DISCORD_AUTH', 'Discordに接続できません。Botトークンとネットワークを確認してください。'); }
  }
  /** Once per explicit receiver start, never on polling or a gateway-ready replay. */
  notifyConnected(): Promise<{ sent: number; failed: number }> {
    if (!this.connectionNoticeTask) this.connectionNoticeTask = this.sendConnectionNotices();
    return this.connectionNoticeTask;
  }
  private async waitForConnectionNoticeOperation<T>(operation: Promise<T>): Promise<T> {
    if (this.connectionNoticeAbort.signal.aborted) throw new AppError('DELIVERY_BLOCKED', '接続通知は停止されています。');
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new AppError('DELIVERY_BLOCKED', '接続通知は停止されています。'));
      this.connectionNoticeAbort.signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AppError('CONNECTION_NOTICE_TIMEOUT', '接続通知処理が期限内に完了しませんでした。')), 10_000);
    });
    try { return await Promise.race([operation, aborted, deadline]); }
    finally {
      if (timer) clearTimeout(timer);
      if (onAbort) this.connectionNoticeAbort.signal.removeEventListener('abort', onAbort);
    }
  }
  private async sendConnectionNotices(): Promise<{ sent: number; failed: number }> {
    let sent = 0, failed = 0;
    const settings = this.config.connectionNotifications;
    if (!settings?.dm && !settings?.channels) return { sent, failed };
    if (!this.client.isReady() || this.stopping) return { sent, failed: 1 };
    const users = [...this.config.allowedUserIds], channels = [...this.config.allowedChannelIds];
    const deliver = async (kind: 'dm' | 'channel', id: string, actors: Actor[]) => {
      const key = `connection-notice:${this.connectionNoticeId}:${kind}:${id}`;
      try {
        for (const actor of actors) this.engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        const target = kind === 'dm' ? await this.waitForConnectionNoticeOperation(this.client.users.fetch(id)) : await this.waitForConnectionNoticeOperation(this.client.channels.fetch(id));
        if (!target || kind === 'channel' && (!('isSendable' in target) || !target.isSendable() || !('guildId' in target) || target.guildId !== this.config.guildId)) throw new AppError('DELIVERY_BLOCKED', '通知先を確認できません。');
        const notice = await this.waitForConnectionNoticeOperation(connectionNotice(this.engine, this.config, actors));
        notice.assertCurrent();
        if (this.stopping || !this.client.isReady() || !(kind === 'dm' ? this.config.connectionNotifications?.dm : this.config.connectionNotifications?.channels)) throw new AppError('DELIVERY_BLOCKED', '通知は停止されました。');
        if (!this.engine.store.claimReceipt(key)) return;
        // Persist the uncertainty fence before Discord may accept a message. No body is stored.
        this.engine.store.setSetting(key, JSON.stringify({ state: 'unknown' }));
        const send = target as { send(options: unknown): Promise<{ id: string }> };
        const receipt = await this.waitForConnectionNoticeOperation(send.send({ content: notice.content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds,
          nonce: digest(key).slice(0, 24), enforceNonce: true }));
        if (!receipt || typeof receipt.id !== 'string' || !/^\d{17,20}$/.test(receipt.id)) throw new AppError('NOTIFICATION_UNKNOWN', '通知の受領を確認できません。');
        this.engine.store.setSetting(key, JSON.stringify({ state: 'sent', messageId: receipt.id })); sent++;
      } catch { failed++; /* Never retry, redirect, echo an error, or replay a Native prompt. */ }
    };
    if (settings.dm) for (const userId of users) {
      if (this.stopping) break;
      await deliver('dm', userId, channels.map(channelId => ({ userId, guildId: this.config.guildId, channelId })));
    }
    if (settings.channels) for (const channelId of channels) {
      if (this.stopping) break;
      if (users[0]) await deliver('channel', channelId, [{ userId: users[0], guildId: this.config.guildId, channelId }]);
    }
    return { sent, failed };
  }
  private tick(): void {
    if (this.pendingTick || this.stopping) return;
    this.pendingTick = this.engine.tick(this.notificationRouter ?? ((run, part) => this.notify(run, part)), run => this.notifyWorking(run))
      .catch(error => console.error(`[MONITOR_ERROR] ${errorCode(error)}`)).finally(() => { this.pendingTick = undefined; });
  }
  async notifyWorking(run: Run): Promise<{ messageId: string }> {
    const preferences = run.notificationPreferences;
    if (run.guildId !== this.config.guildId || !preferences || !['dm', 'origin'].includes(preferences.destination)) throw new AppError('DELIVERY_BLOCKED', '作業開始通知先を確認できません。');
    this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
    if (this.stopping || !this.client.isReady()) throw new AppError('DELIVERY_BLOCKED', '作業開始通知は停止されています。');
    const content = `作業中 — Run ${run.id}`;
    const options = { content, allowedMentions: { parse: [] as never[] }, flags: MessageFlags.SuppressEmbeds as const,
      nonce: digest(`${run.id}:work-start`).slice(0, 24), enforceNonce: true };
    try {
      if (preferences.destination === 'origin') {
        const channel = await this.client.channels.fetch(run.channelId);
        if (!channel || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== run.guildId) throw new AppError('DELIVERY_BLOCKED', '固定された作業開始通知先を確認できません。');
        this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
        if (this.stopping || !this.client.isReady()) throw new AppError('DELIVERY_BLOCKED', '作業開始通知は停止されています。');
        const sent = await channel.send(options);
        if (!/^\d{17,20}$/u.test(sent.id)) throw new AppError('NOTIFICATION_UNKNOWN', '作業開始通知の受領を確認できません。');
        return { messageId: sent.id };
      }
      const user = await this.client.users.fetch(run.userId);
      if (!user || user.id !== run.userId) throw new AppError('DELIVERY_BLOCKED', '固定された作業開始DM先を確認できません。');
      this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
      if (this.stopping || !this.client.isReady()) throw new AppError('DELIVERY_BLOCKED', '作業開始通知は停止されています。');
      const sent = await user.send(options);
      if (!/^\d{17,20}$/u.test(sent.id)) throw new AppError('NOTIFICATION_UNKNOWN', '作業開始通知の受領を確認できません。');
      return { messageId: sent.id };
    } catch (error) {
      if (error instanceof AppError) throw error;
      const raw = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown } : {};
      if ([50007, 50013, 50001, 10003, 10013].includes(Number(raw.code)) || raw.status === 403 || raw.status === 401) throw new AppError('DELIVERY_BLOCKED', '固定された作業開始通知先へ配信できません。');
      throw new AppError('NOTIFICATION_UNKNOWN', '作業開始通知の送信結果が不明です。自動再送しません。');
    }
  }
  async notify(run: Run, part?: { index: number; content: string }): Promise<{ messageId: string }> {
    if (run.guildId !== this.config.guildId) throw new AppError('DELIVERY_BLOCKED', '通知先が一致しません。');
    this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
    if (run.delivery && (run.delivery.userId !== run.userId || run.delivery.guildId !== run.guildId || run.delivery.channelId !== run.channelId || !['dm', 'origin'].includes(run.delivery.destination))) throw new AppError('DELIVERY_BLOCKED', '固定された通知先が一致しません。');
    try {
      const payload = part ? { content: part.content, files: [] } : resultPayload(run, this.textOnly);
      const options = { ...payload, allowedMentions: { parse: [] as never[] }, flags: MessageFlags.SuppressEmbeds as const,
        nonce: digest(`${run.id}:${part?.index ?? 0}`).slice(0, 24), enforceNonce: true };
      if (run.delivery?.destination === 'origin') {
        if (run.delivery.guildId !== run.guildId || run.delivery.channelId !== run.channelId || run.delivery.userId !== run.userId) throw new AppError('DELIVERY_BLOCKED', '固定された通知先が一致しません。');
        const channel = await this.client.channels.fetch(run.delivery.channelId);
        if (!channel || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== run.delivery.guildId) throw new AppError('DELIVERY_BLOCKED', '元の通知先へ配信できません。');
        this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
        const sent = await channel.send(options); return { messageId: sent.id };
      }
      const user = await this.client.users.fetch(run.delivery?.userId ?? run.userId);
      this.engine.policy.authorize(run.userId, run.guildId, run.channelId);
      const sent = await user.send(options); return { messageId: sent.id };
    } catch (error) {
      if (error instanceof AppError) throw error;
      const raw = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; retry_after?: unknown; rawError?: { retry_after?: unknown } } : {};
      if (this.textOnly || part) {
        if (error instanceof RateLimitError) {
          const rateLimit = new AppError('DELIVERY_RATE_LIMIT', 'Discordの指定待機後に再試行します。');
          Object.assign(rateLimit, { retryAfterMs: Number.isFinite(error.retryAfter) && error.retryAfter >= 0 ? Math.ceil(error.retryAfter) : NaN }); throw rateLimit;
        }
        if (raw.status === 429) {
          const seconds = Number(raw.retry_after ?? raw.rawError?.retry_after);
          const rateLimit = new AppError('DELIVERY_RATE_LIMIT', 'Discordの指定待機後に再試行します。');
          Object.assign(rateLimit, { retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : NaN }); throw rateLimit;
        }
        if ([50007, 50013, 50001, 10003, 10013].includes(Number(raw.code)) || raw.status === 403 || raw.status === 401) throw new AppError('DELIVERY_BLOCKED', '通知先の権限不足またはDM拒否です。別宛先へ転送しません。');
        throw new AppError('NOTIFICATION_UNKNOWN', '通知の送信結果が不明です。自動再送しません。');
      }
      throw new AppError('DM_FAILED', 'DMを配信できません。/agent resultで確認してください。');
    }
  }
  private async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      this.engine.policy.authorize(interaction.user.id, interaction.guildId, interaction.channelId);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { content, files = [] } = await handleAgentCommand(interaction, this.engine, this.config, this.textOnly);
      this.engine.policy.authorize(interaction.user.id, interaction.guildId, interaction.channelId);
      await interaction.editReply({ content, files: this.textOnly ? [] : files, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
    } catch (error) {
      const content = safeError(error);
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch { console.error('[INTERACTION_REPLY_FAILED] 返信できません。実行IDは/agent statusで確認できます。'); }
    }
  }
  async stop(): Promise<void> {
    this.stopping = true; this.connectionNoticeAbort.abort(); if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.handling]); await this.pendingTick; await this.connectionNoticeTask;
    await this.client.destroy();
  }
}
