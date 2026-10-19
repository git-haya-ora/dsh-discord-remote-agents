import { randomUUID } from 'node:crypto';
import { AppError } from './runtime/errors.js';
import { object, DshRejected } from './runtime/protocol.js';
// Actual installed SessionController seam. No HTTP, DSH token, synthetic Run API or research import.
const methods = ['list', 'create', 'projections', 'page', 'prompt'];
const rejectedBeforeAdmission = new Set(['gateway/bad-request', 'session/not-found', 'session/writer-held', 'session/model-unavailable', 'session/invalid-time-zone']);
function protocol() { throw new AppError('DSH_PROTOCOL', 'Native Sessionの応答形式が未対応です。PCで確認してください。'); }
export class NativeSessionAdapter {
  constructor(controller, store, signal = new AbortController().signal) {
    if (!controller || methods.some(method => typeof controller[method] !== 'function')) throw new AppError('HOST_COMPATIBILITY_UNVERIFIED', '正式Native Session serviceが利用できません。');
    this.controller = controller; this.store = store; this.signal = signal;
  }
  async call(method, request) {
    this.signal.throwIfAborted();
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30000)]);
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([this.controller[method](request, signal), interrupted]); }
    catch (error) {
      // agent-busy wraps exceptions potentially raised after followup; not safe rejection evidence.
      if (rejectedBeforeAdmission.has(error?.code)) throw new DshRejected('DSH_REJECTED', 'Native Sessionが受付前に操作を拒否しました。');
      throw new AppError('DSH_REMOTE_ERROR', 'Native Sessionの操作結果を確定できません。PCで確認してください。');
    } finally { signal.removeEventListener('abort', abort); }
  }
  async list() {
    const page = object(await this.call('list', {}));
    if (!Array.isArray(page.items) || page.items.length > 10000) protocol();
    return page.items.map(raw => {
      const item = object(raw);
      if (typeof item.sessionId !== 'string' || !item.sessionId || typeof item.running !== 'boolean' || !Number.isFinite(item.updatedAt)) protocol();
      const values = object(object(item.projections).values);
      const info = { sessionId: item.sessionId, running: item.running, updatedAt: item.updatedAt,
        title: typeof values.title === 'string' ? values.title : '(無題)',
        subagent: item.origin === 'subagent' || typeof item.parentSessionId === 'string' };
      if (typeof item.cwd === 'string') info.cwd = item.cwd;
      // Official modelSelection wire view: lastUsed comes from request/header,
      // next is pending intent (or lastUsed). Never call either an active Run model.
      const selection = values.modelSelection;
      const model = value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const valid = text => typeof text === 'string' && text.length > 0 && text.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(text);
        if (!valid(value.provider) || !valid(value.model) || value.reasoningEffort !== undefined && !valid(value.reasoningEffort)) return undefined;
        return { provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) };
      };
      if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
        const lastUsed = model(selection.lastUsed), next = model(selection.next);
        if (lastUsed) info.lastUsedModel = lastUsed;
        if (next) info.nextModel = next;
      }
      return info;
    });
  }
  async create(cwd) {
    const unresolved = this.store?.setting('restricted-create-intent');
    if (unresolved) {
      let pending; try { pending = JSON.parse(unresolved); } catch { protocol(); }
      const existing = (await this.list()).find(s => s.sessionId === pending.sessionId && s.cwd === pending.cwd && !s.subagent);
      if (existing && cwd === pending.cwd) { this.store.clearSetting('restricted-create-intent'); return existing.sessionId; }
      throw new AppError('SESSION_CREATION_UNKNOWN', '以前の作成結果が不明です。PCで確認し、自動再作成しないでください。');
    }
    const sessionId = `discord-${randomUUID()}`;
    this.store?.setSetting('restricted-create-intent', JSON.stringify({ sessionId, cwd }));
    try {
      const value = object(await this.call('create', { sessionId, cwd }));
      if (value.sessionId !== sessionId) protocol();
      this.store?.clearSetting('restricted-create-intent'); return sessionId;
    } catch (error) {
      if (error instanceof DshRejected) this.store?.clearSetting('restricted-create-intent');
      throw error;
    }
  }
  async snapshot(sessionId) {
    const value = await this.call('projections', { sessionId });
    if (value === null) throw new DshRejected('SESSION_NOT_FOUND', 'DSHセッションが見つかりません。');
    const data = object(value);
    if (!Number.isSafeInteger(data.asOfSeq) || data.asOfSeq < -1 || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) protocol();
    return { cursor: data.asOfSeq, values: object(data.values) };
  }
  async events(sessionId, throughSeq, afterSeq) {
    if (!Number.isSafeInteger(throughSeq) || !Number.isSafeInteger(afterSeq) || throughSeq < afterSeq) throw new AppError('DSH_LOG_CHANGED', 'Session履歴を安全に照合できません。');
    if (throughSeq === afterSeq) return [];
    let beforeSeq; const collected = [];
    for (let n = 0; n < 100; n++) {
      const request = { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 30 };
      if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
      const page = object(await this.call('page', request));
      if (!Array.isArray(page.records) || typeof page.hasMore !== 'boolean') protocol();
      const events = page.records.map(raw => {
        const record = object(raw), event = object(record.event);
        if (record.type !== 'event' || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq) || typeof event.time !== 'number' || event.seq > throughSeq) protocol();
        return { type: event.type, seq: event.seq, time: event.time, data: object(event.data), surfaceOp: event.surfaceOp };
      });
      const first = events[0]?.seq;
      if (first === undefined || beforeSeq !== undefined && first >= beforeSeq) protocol();
      collected.unshift(...events.filter(e => e.seq > afterSeq));
      if (collected.length > 20000 || Buffer.byteLength(JSON.stringify(collected), 'utf8') > 12 * 1024 * 1024) throw new AppError('DSH_TOO_LARGE', '履歴が上限を超えました。PCで確認してください。');
      if (first <= afterSeq + 1 || !page.hasMore) {
        let expected = afterSeq + 1;
        for (const event of collected) if (event.seq !== expected++) protocol();
        if (expected !== throughSeq + 1) protocol();
        return collected;
      }
      beforeSeq = first;
    }
    throw new AppError('DSH_TOO_LARGE', '履歴が上限を超えました。PCで確認してください。');
  }
  async prompt(sessionId, requestId, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 6000 || typeof sessionId !== 'string' || typeof requestId !== 'string') throw new DshRejected('PROMPT_INVALID', 'テキスト指示が不正です。');
    const result = object(await this.call('prompt', { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }));
    if (result.accepted !== true) protocol();
  }
}
