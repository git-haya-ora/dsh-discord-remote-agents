import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { Engine, type Actor } from './engine.js';
import { AppError, errorCode, safeError } from './errors.js';
import { object } from './dsh.js';
import { redact, tail } from './output.js';
import { terminal, type Run } from './types.js';
import { TelegramApi, TelegramApiError } from './telegram-api.js';
import { telegramId } from './telegram-config.js';
export const TELEGRAM_HELP = `/sessions [ページ] — 既存セッション一覧\n/bind セッションID — 選択\n/new 作業フォルダー別名 — 新規作成\n/prompt 指示 — 選択先へ送信\n/status [実行ID] — 状態\n/result [実行ID] — 結果\n/notify 実行ID — 完了通知を再配信\n/unbind — 選択解除\n/whoami — 自分のユーザー・チャットID\n/help — この説明\n\nプライベートチャット・許可本人限定。承認と停止はPCのDSHで行ってください。`;
const STATES: Record<Run['state'], string> = { dispatching: '送信中', accepted: 'DSH受付済み（完了ではありません）', running: '実行中', unknown: '送信結果不明・履歴照合中（再送禁止）', succeeded: '完了', failed: '失敗', interrupted: '中断' };
export function telegramSummary(run: Run): string {
  return `実行ID: ${run.id}\nセッション: ${tail(run.sessionId, 200)}\n状態: ${STATES[run.state]}\n通知: ${run.notification}${run.lastError ? `\n接続・配信情報: ${run.lastError}` : ''}`;
}
export function telegramResult(run: Run): { text: string; document?: string } {
  const result = terminal(run.state) ? run.result : run.contaminated ? '指示が混在したため途中出力を非表示にしました。' : run.output || run.result || 'テキスト出力はまだありません。';
  return { text: `${telegramSummary(run)}\n\n${tail(result, 2500)}`, ...(result.length > 2500 ? { document: result } : {}) };
}
export class TelegramBot {
  private readonly abort = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private pendingTick: Promise<void> | undefined;
  private botId = '';
  private username = '';
  private offset: number | undefined;
  private nextSendAt = 0;
  constructor(private readonly config: Config, readonly engine: Engine, readonly api = new TelegramApi(config.token)) {}
  private async sendText(chatId: string, text: string): Promise<void> {
    if (Date.now() < this.nextSendAt) throw new TelegramApiError('TELEGRAM_RATE_LIMIT', 'Telegramの送信制限です。/resultで確認してください。', this.nextSendAt - Date.now());
    try { await this.api.sendText(chatId, this.engine.redactText(redact(text, [this.config.token, this.config.dshToken]))); }
    catch (error) { if (error instanceof TelegramApiError && error.code === 'TELEGRAM_RATE_LIMIT') this.nextSendAt = Date.now() + error.retryAfterMs; throw error; }
  }
  async initialize(): Promise<void> {
    const me = object(await this.api.call('getMe', {}, this.abort.signal));
    if (!telegramId(me.id) || String(me.id) !== this.config.applicationId || me.is_bot !== true || typeof me.username !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(me.username)) throw new AppError('TELEGRAM_PROTOCOL', 'Telegram Botの本人確認に失敗しました。');
    this.botId = String(me.id); this.username = me.username;
    const saved = this.engine.store.setting(`telegram:${this.botId}:offset`);
    if (saved !== undefined) {
      const value = Number(saved); if (!Number.isSafeInteger(value) || value < 0) throw new AppError('DB_CORRUPT', 'Telegram受信カーソルが不正です。'); this.offset = value;
    }
    const webhook = object(await this.api.call('getWebhookInfo', {}, this.abort.signal));
    if (typeof webhook.url !== 'string') throw new AppError('TELEGRAM_PROTOCOL', 'TelegramのWebhook情報が不正です。');
    if (webhook.url) throw new AppError('TELEGRAM_WEBHOOK', 'このBotにはWebhookがあります。専用Botを使うか本人がWebhookを解除してください。自動解除はしません。');
    await this.api.call('setMyCommands', { scope: { type: 'all_private_chats' }, commands: [
      { command: 'sessions', description: '既存セッション一覧' }, { command: 'bind', description: 'セッションIDで選択' },
      { command: 'new', description: '作業フォルダー別名で新規作成' }, { command: 'prompt', description: '選択セッションに指示' },
      { command: 'status', description: '実行状態を確認' }, { command: 'result', description: '結果を確認' },
      { command: 'notify', description: '完了通知を再配信' }, { command: 'unbind', description: '選択解除' },
      { command: 'whoami', description: '自分の数値IDを表示' }, { command: 'help', description: '操作方法' }
    ] }, this.abort.signal);
  }
  async notify(run: Run): Promise<void> {
    if (run.guildId !== 'telegram' || run.userId !== run.channelId) throw new AppError('TRANSPORT_MISMATCH', 'Telegram通知先が一致しません。');
    const payload = telegramResult(run);
    // Long results use a single document message, avoiding partial preview+attachment retries.
    if (payload.document !== undefined) {
      if (Date.now() < this.nextSendAt) throw new TelegramApiError('TELEGRAM_RATE_LIMIT', 'Telegram送信制限です。', this.nextSendAt - Date.now());
      try { await this.api.sendDocument(run.channelId, this.engine.redactText(redact(`${telegramSummary(run)}\n\n${payload.document}`, [this.config.token, this.config.dshToken])), `result-${run.id}.txt`); }
      catch (error) { if (error instanceof TelegramApiError && error.code === 'TELEGRAM_RATE_LIMIT') this.nextSendAt = Date.now() + error.retryAfterMs; throw error; }
    } else await this.sendText(run.channelId, payload.text);
  }
  async handleUpdate(raw: unknown): Promise<void> {
    if (!this.botId) throw new AppError('TELEGRAM_NOT_READY', 'Telegramの起動確認が必要です。');
    const update = object(raw); const updateId = update.update_id;
    if (typeof updateId !== 'number' || !Number.isSafeInteger(updateId) || updateId < 0 || updateId >= Number.MAX_SAFE_INTEGER) throw new AppError('TELEGRAM_PROTOCOL', 'Telegram update_idが不正です。');
    // Durable at-most-once admission before all commands, not only prompts. No raw update persisted.
    if (!this.engine.store.claimReceipt(`telegram:${this.botId}:${updateId}`)) return;
    const message = object(update.message); const from = object(message.from); const chat = object(message.chat);
    if (chat.type !== 'private' || !telegramId(chat.id) || !telegramId(from.id) || chat.id !== from.id || from.is_bot === true || typeof message.text !== 'string' || message.forward_origin || message.via_bot || message.business_connection_id) return;
    const match = /^\/([a-zA-Z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(message.text);
    if (!match || (match[2] && match[2].toLowerCase() !== this.username.toLowerCase())) return;
    const cmd = match[1]!.toLowerCase(); const args = (match[3] ?? '').trim();
    const actor: Actor = { userId: String(from.id), guildId: 'telegram', channelId: String(chat.id) };
    try {
      if (cmd === 'whoami') { await this.sendText(actor.channelId, `User ID: ${actor.userId}\nChat ID: ${actor.channelId}\n許可設定はPCで行ってください。`); return; }
      this.engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
      let text: string;
      switch (cmd) {
        case 'start': case 'help': text = TELEGRAM_HELP; break;
        case 'sessions': {
          if (args && !/^[1-9]\d{0,5}$/.test(args)) throw new AppError('PAGE_INVALID', '/sessions 1 の形式で指定してください。');
          const rows = await this.engine.sessions(actor); const page = args ? Number(args) : 1; const count = Math.max(1, Math.ceil(rows.length / 5));
          if (page > count) throw new AppError('PAGE_INVALID', `ページは1〜${count}で指定してください。`);
          text = `既存セッション ${page}/${count}（${rows.length}件）\n${rows.slice((page - 1) * 5, page * 5).map(s => `${tail(s.sessionId, 200)} | ${s.running ? '実行中' : '待機'} | ${Array.from(this.engine.redactText(redact(s.title, [this.config.token, this.config.dshToken]))).slice(0, 50).join('').replace(/[\r\n]/g, ' ')}`).join('\n') || '許可フォルダーのセッションはありません。'}\n/bind セッションID で選択`; break;
        }
        case 'bind': if (!args || args.length > 200 || /\s/.test(args)) throw new AppError('SESSION_INVALID', '/bind セッションID の形式で指定してください。'); await this.engine.bind(actor, args); text = `選択しました: ${args}`; break;
        case 'new': { const id = await this.engine.create(actor, args); text = `新規セッションを作成・選択しました: ${tail(id, 200)}`; break; }
        case 'unbind': this.engine.unbind(actor); text = '選択を解除しました。既存の実行は継続します。'; break;
        case 'prompt': { const run = await this.engine.submit(actor, `tg-${this.botId}-${updateId}`, args); text = `${telegramSummary(run)}\n完了通知または/resultで確認してください。`; break; }
        case 'status': case 'result': {
          const run = await this.engine.status(actor, args || undefined, cmd === 'result');
          if (!run) { text = `この操作元の実行履歴はありません。\n選択: ${tail(this.engine.binding(actor) ?? 'なし', 200)}`; break; }
          if (cmd === 'status') text = telegramSummary(run);
          else { const payload = telegramResult(run); if (payload.document !== undefined) { await this.notify(run); return; } text = payload.text; } break;
        }
        case 'notify': if (!args) throw new AppError('RUN_INVALID', '/notify 実行ID の形式で指定してください。'); await this.engine.retryNotification(actor, args); text = '完了通知の再配信を予約しました。'; break;
        default: throw new AppError('UNKNOWN_COMMAND', '/helpで操作方法を確認してください。通常メッセージは指示として送信しません。');
      }
      await this.sendText(actor.channelId, text);
    } catch (error) {
      // Never retry the command after a reply failure: execution may already have been admitted.
      try { await this.sendText(actor.channelId, safeError(error).replaceAll('/agent ', '/')); }
      catch { console.error('[TELEGRAM_REPLY_FAILED] /statusまたは/resultで確認してください。'); }
    }
  }
  async pollOnce(): Promise<void> {
    if (!this.botId) throw new AppError('TELEGRAM_NOT_READY', 'Telegramの起動確認が必要です。');
    // Telegram drops pending updates after 24h and randomizes IDs after a week idle.
    // Discard a stale offset before it can acknowledge a lower, newly randomized ID.
    const ageKey = `telegram:${this.botId}:lastReceivedAt`;
    const lastReceived = Number(this.engine.store.setting(ageKey) ?? 0);
    if (this.offset !== undefined && (!Number.isFinite(lastReceived) || lastReceived <= 0 || Date.now() - lastReceived > 86400000)) {
      this.offset = undefined; this.engine.store.clearSetting(`telegram:${this.botId}:offset`);
    }
    const updates = await this.api.call('getUpdates', { ...(this.offset !== undefined ? { offset: this.offset } : {}), limit: 100, timeout: 30, allowed_updates: ['message'] }, this.abort.signal);
    if (!Array.isArray(updates) || updates.some(u => { const id = object(u).update_id; return typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= Number.MAX_SAFE_INTEGER; })) throw new AppError('TELEGRAM_PROTOCOL', 'Telegram更新一覧が不正です。');
    for (const update of updates) {
      if (this.abort.signal.aborted) return;
      await this.handleUpdate(update);
      this.offset = Math.max(this.offset ?? 0, (object(update).update_id as number) + 1);
      this.engine.store.setSetting(`telegram:${this.botId}:offset`, String(this.offset));
      this.engine.store.setSetting(ageKey, String(Date.now()));
    }
  }
  private tick(): void {
    if (this.pendingTick || this.abort.signal.aborted) return;
    this.pendingTick = this.engine.tick(run => this.notify(run)).catch(error => console.error(`[TELEGRAM_MONITOR_ERROR] ${errorCode(error)}`)).finally(() => { this.pendingTick = undefined; });
  }
  async run(monitor = true): Promise<void> {
    await this.initialize(); console.log('[TELEGRAM_READY] プライベートチャット・許可本人限定。');
    if (monitor) { this.tick(); this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs); }
    while (!this.abort.signal.aborted) {
      try { await this.pollOnce(); }
      catch (error) {
        if (this.abort.signal.aborted) break;
        if (error instanceof TelegramApiError && ['TELEGRAM_AUTH', 'TELEGRAM_CONFLICT'].includes(error.code)) throw error;
        console.error(`[TELEGRAM_POLL_ERROR] ${errorCode(error)}`);
        const ms = error instanceof TelegramApiError ? error.retryAfterMs : 5000;
        try { await delay(ms, undefined, { signal: this.abort.signal }); } catch { break; }
      }
    }
  }
  async stop(): Promise<void> { this.abort.abort(); if (this.timer) clearInterval(this.timer); await this.pendingTick; }
}
