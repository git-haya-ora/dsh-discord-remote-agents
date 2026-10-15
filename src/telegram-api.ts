import { AppError } from './errors.js';
import { object } from './dsh.js';
import { validateTelegramToken } from './telegram-config.js';
export class TelegramApiError extends AppError {
  constructor(code: string, message: string, readonly retryAfterMs = 1000) { super(code, message); }
}
export class TelegramApi {
  private readonly token: string;
  constructor(token: string, private readonly fetcher: typeof fetch = fetch) { this.token = validateTelegramToken(token); }
  async call(method: string, args: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<unknown> {
    if (!/^[a-zA-Z]+$/.test(method)) throw new AppError('TELEGRAM_PROTOCOL', '未対応のTelegram操作です。');
    const multipart = args instanceof FormData;
    try {
      const timeout = method === 'getUpdates' ? 45000 : 15000;
      const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', redirect: 'error', headers: multipart ? {} : { 'content-type': 'application/json' },
        body: multipart ? args : JSON.stringify(args), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
      });
      const reader = response.body?.getReader(); if (!reader) throw new AppError('TELEGRAM_PROTOCOL', 'Telegramの応答形式が不正です。');
      let bytes = 0; const chunks: Uint8Array[] = [];
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new AppError('TELEGRAM_PROTOCOL', 'Telegramの応答が取得上限を超えました。'); }
        chunks.push(part.value);
      }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (body.ok !== true || !response.ok) {
        const code = typeof body.error_code === 'number' ? body.error_code : response.status;
        if (code === 401 || code === 403) throw new TelegramApiError('TELEGRAM_AUTH', 'Telegramの認証・送信権限が拒否されました。トークンやブロック状態を確認してください。');
        if (code === 409) throw new TelegramApiError('TELEGRAM_CONFLICT', 'Telegramの受信が競合しています。Webhookや同じBotの別プロセスを確認してください。');
        if (code === 429) {
          const seconds = object(body.parameters).retry_after;
          const delay = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(1000, Math.min(86400000, Math.ceil(seconds * 1000))) : 10000;
          throw new TelegramApiError('TELEGRAM_RATE_LIMIT', 'Telegramの送信制限です。待機して再試行します。', delay);
        }
        throw new TelegramApiError('TELEGRAM_API', 'Telegram APIの操作が失敗しました。/statusまたは/resultで確認してください。');
      }
      if (!Object.hasOwn(body, 'result')) throw new AppError('TELEGRAM_PROTOCOL', 'Telegramの応答形式が不正です。');
      return body.result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Fetch errors may contain the full bot-token URL. Never expose the cause.
      throw new TelegramApiError('TELEGRAM_OFFLINE', 'Telegramに接続できません。ネットワークを確認してください。', 5000);
    }
  }
  async sendText(chatId: string, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true }, protect_content: true });
  }
  async sendDocument(chatId: string, text: string, filename: string): Promise<void> {
    const form = new FormData(); form.set('chat_id', chatId); form.set('protect_content', 'true');
    form.set('document', new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
    await this.call('sendDocument', form);
  }
}
