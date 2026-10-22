import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { validateLocalUrl } from './config.js';
import type { AgentAdapter, SessionInfo, Snapshot, WireEvent } from './types.js';
import { object, DshRejected } from './protocol.js';
export { object, DshRejected } from './protocol.js';
function protocol(): never { throw new AppError('DSH_PROTOCOL', 'DSH APIの応答形式が対応バージョンと異なります。'); }
export class DshAdapter implements AgentAdapter {
  private cookie = '';
  private authenticating: Promise<void> | undefined;
  readonly url: string;
  constructor(url: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    this.url = validateLocalUrl(url);
    if (!token.trim()) throw new AppError('CONFIG_INVALID', 'DSH_TOKENを設定してください。');
  }
  private async request(path: string, init: RequestInit): Promise<Response> {
    try { return await this.fetcher(`${this.url}${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
    catch { throw new AppError('DSH_OFFLINE', 'DSHに接続できません。DSHの起動とURLを確認してください。'); }
  }
  private async authenticate(): Promise<void> {
    if (this.cookie) return;
    if (this.authenticating) return this.authenticating;
    this.authenticating = (async () => {
      const response = await this.request(`/?token=${encodeURIComponent(this.token)}`, { method: 'GET' });
      try {
        if (response.status !== 303) throw new DshRejected('DSH_AUTH', 'DSH_TOKENが無効、またはこのDSHホストは未対応です。');
        const cookies = response.headers.getSetCookie();
        const cookie = cookies.map(c => c.split(';')[0] ?? '').find(c => c.startsWith('dsh-auth-'));
        if (!cookie || cookie.length > 8192) throw new AppError('DSH_PROTOCOL', 'DSHの認証Cookieを取得できません。');
        this.cookie = cookie;
      } finally { await response.body?.cancel(); }
    })();
    try { await this.authenticating; } finally { this.authenticating = undefined; }
  }
  private async rpc(method: string, request: Record<string, unknown>): Promise<unknown> {
    await this.authenticate();
    const response = await this.request(`/api/session/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: this.cookie, origin: this.url },
      body: JSON.stringify({ kind: 'invoke', args: { request } })
    });
    if (response.status === 401 || response.status === 403) {
      this.cookie = ''; await response.body?.cancel();
      throw new DshRejected('DSH_AUTH', 'DSHの認証が拒否されました。現在のDSH_TOKENを確認してください。');
    }
    if (!response.ok) { await response.body?.cancel(); throw new AppError('DSH_HTTP', 'DSH APIでHTTPエラーが発生しました。'); }
    let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      const reader = response.body?.getReader();
      if (!reader) protocol();
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 12 * 1024 * 1024) { await reader.cancel(); throw new AppError('DSH_TOO_LARGE', 'DSHの履歴が取得上限を超えました。PCで結果を確認してください。'); }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('DSH_OFFLINE', 'DSHからの応答が中断されました。');
    }
    let envelope: Record<string, unknown>;
    try { envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { return protocol(); }
    if (envelope.ok !== true) {
      const code = object(envelope.error).code;
      // Only errors known to occur before admission release the durable run lock.
      const rejected = new Set(['session/not-found', 'session/writer-held', 'session/agent-busy', 'gateway/bad-request', 'gateway/unknown-endpoint']);
      if (typeof code === 'string' && rejected.has(code)) throw new DshRejected('DSH_REJECTED', 'DSHが操作を拒否しました。セッションの存在・書き込み所有者・API対応を確認してください。');
      throw new AppError('DSH_REMOTE_ERROR', 'DSH側でエラーが発生しました。送信結果は履歴で照合します。');
    }
    return envelope.value;
  }
  async list(): Promise<SessionInfo[]> {
    const result: SessionInfo[] = []; let cursor: string | undefined;
    const seen = new Set<string>();
    for (let n = 0; n < 100; n++) {
      const page = object(await this.rpc('list', cursor ? { cursor } : {}));
      if (!Array.isArray(page.items)) protocol();
      for (const input of page.items) {
        const item = object(input);
        if (typeof item.sessionId !== 'string' || typeof item.running !== 'boolean' || typeof item.updatedAt !== 'number') protocol();
        const values = object(object(item.projections).values);
        const info: SessionInfo = { sessionId: item.sessionId, running: item.running,
          updatedAt: item.updatedAt, title: typeof values.title === 'string' ? values.title : '(無題)',
          subagent: item.origin === 'subagent' || typeof item.parentSessionId === 'string' };
        if (typeof item.cwd === 'string') info.cwd = item.cwd;
        // Keep only the official last-used/next model projection; neither is claimed as an active Run model.
        const selection = values.modelSelection;
        if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
          const model = (value: unknown): SessionInfo['lastUsedModel'] => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
            const candidate = value as Record<string, unknown>;
            const valid = (field: unknown): field is string => typeof field === 'string' && field.length > 0 && field.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(field);
            if (!valid(candidate.provider) || !valid(candidate.model) || candidate.reasoningEffort !== undefined && !valid(candidate.reasoningEffort)) return undefined;
            return { provider: candidate.provider, model: candidate.model, ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }) };
          };
          const lastUsedModel = model((selection as Record<string, unknown>).lastUsed);
          const nextModel = model((selection as Record<string, unknown>).next);
          if (lastUsedModel) info.lastUsedModel = lastUsedModel;
          if (nextModel) info.nextModel = nextModel;
        }
        result.push(info);
      }
      if (page.nextCursor === undefined) return result;
      if (typeof page.nextCursor !== 'string' || seen.has(page.nextCursor)) protocol();
      cursor = page.nextCursor; seen.add(cursor);
    }
    throw new AppError('DSH_TOO_LARGE', 'セッション数が取得上限を超えています。');
  }
  async create(cwd: string): Promise<string> {
    // Choose the ID before sending, so an uncertain creation never creates another random session.
    const sessionId = `discord-${randomUUID()}`;
    const result = object(await this.rpc('create', { cwd, sessionId }));
    if (result.sessionId !== sessionId) protocol();
    return sessionId;
  }
  async snapshot(sessionId: string): Promise<Snapshot> {
    const value = await this.rpc('projections', { sessionId });
    if (value === null) throw new DshRejected('SESSION_NOT_FOUND', 'DSHセッションが見つかりません。');
    const data = object(value);
    if (!Number.isSafeInteger(data.asOfSeq) || (data.asOfSeq as number) < -1 || !data.values || typeof data.values !== 'object') protocol();
    return { cursor: data.asOfSeq as number, values: object(data.values) };
  }
  async events(sessionId: string, throughSeq: number, afterSeq: number): Promise<WireEvent[]> {
    if (throughSeq < afterSeq) throw new AppError('DSH_LOG_CHANGED', 'セッション履歴のカーソルが後退しました。PCで確認してください。');
    if (throughSeq === afterSeq) return [];
    let beforeSeq: number | undefined; const collected: WireEvent[] = [];
    for (let n = 0; n < 100; n++) {
      const request: Record<string, unknown> = { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 30 };
      if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
      const page = object(await this.rpc('page', request));
      if (!Array.isArray(page.records) || typeof page.hasMore !== 'boolean') protocol();
      const events = page.records.map(raw => {
        const record = object(raw); const event = object(record.event);
        if (record.type !== 'event' || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq) || typeof event.time !== 'number') protocol();
        return { type: event.type, seq: event.seq as number, time: event.time, data: object(event.data), surfaceOp: event.surfaceOp } as WireEvent;
      });
      const first = events[0]?.seq;
      if (first === undefined || (beforeSeq !== undefined && first >= beforeSeq)) protocol();
      collected.unshift(...events.filter(e => e.seq > afterSeq));
      if (first <= afterSeq + 1 || !page.hasMore) {
        let expected = afterSeq + 1;
        for (const event of collected) { if (event.seq !== expected++) protocol(); }
        if (expected !== throughSeq + 1) protocol();
        return collected;
      }
      beforeSeq = first;
    }
    throw new AppError('DSH_TOO_LARGE', 'DSH履歴の再接続範囲が取得上限を超えました。PCで確認してください。');
  }
  async prompt(sessionId: string, requestId: string, text: string): Promise<void> {
    const result = object(await this.rpc('prompt', { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }));
    if (result.accepted !== true) protocol();
  }
}
