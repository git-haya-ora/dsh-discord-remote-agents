import { randomUUID } from 'node:crypto';
import { AppError } from './runtime/errors.js';
import { object, DshRejected } from './runtime/protocol.js';
// Actual installed SessionController seam. No HTTP, DSH token, synthetic Run API or research import.
const methods = ['list', 'create', 'projections', 'page', 'prompt'];
const rejectedBeforeAdmission = new Set(['gateway/bad-request', 'session/not-found', 'session/writer-held', 'session/model-unavailable', 'session/invalid-time-zone']);
function protocol() { throw new AppError('DSH_PROTOCOL', 'Native Sessionの応答形式が未対応です。PCで確認してください。'); }
export class NativeSessionAdapter {
  constructor(controller, store, signal = new AbortController().signal, commands, agents) {
    if (!controller || methods.some(method => typeof controller[method] !== 'function')) throw new AppError('HOST_COMPATIBILITY_UNVERIFIED', '正式Native Session serviceが利用できません。');
    this.controller = controller; this.store = store; this.signal = signal; this.verifiedSessions = new Set();
    this.compactTargets = new WeakMap(); this.compactServiceGeneration = 0; this.attachCompactServices(commands, agents);
  }
  invalidateCompactTargets() { this.compactServiceGeneration++; }
  attachCompactServices(commands, agents) {
    this.invalidateCompactTargets();
    this.commands = commands && typeof commands.find === 'function' && typeof commands.execute === 'function' ? commands : undefined;
    this.agents = agents && typeof agents.get === 'function' ? agents : undefined;
    return !!(this.commands && this.agents && typeof this.controller.resolveAgent === 'function');
  }
  async prepareCompactTarget(sessionId, cwd) {
    const unavailable = () => new AppError('COMPACT_UNAVAILABLE', 'このHostでは正式なCompact commandを確認できません。PCで確認してください。');
    const commands = this.commands, agents = this.agents, generation = this.compactServiceGeneration;
    if (!commands || !agents || typeof this.controller.resolveAgent !== 'function') throw unavailable();
    this.signal.throwIfAborted();
    let resolved;
    try {
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30000)]);
      let abort; const interrupted = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
      try { resolved = await Promise.race([this.controller.resolveAgent(sessionId), interrupted]); }
      finally { signal.removeEventListener('abort', abort); }
    } catch { throw unavailable(); }
    if (!resolved || resolved.error || !resolved.agent) throw unavailable();
    const agent = resolved.agent, session = agent.session, header = session?.header;
    if (generation !== this.compactServiceGeneration || this.commands !== commands || this.agents !== agents
      || agent.id !== sessionId || !header || header.id !== sessionId || header.cwd !== cwd || header.origin === 'subagent' || header.parentSession != null
      || agents.get(sessionId) !== agent) throw unavailable();
    let definition;
    try { definition = commands.find(agent, 'compact'); } catch { throw unavailable(); }
    if (generation !== this.compactServiceGeneration || this.commands !== commands || this.agents !== agents
      || !definition || definition.definitionId !== '@deepseek-ai/dsh-command-compact') throw unavailable();
    const target = Object.freeze({ sessionId, agentId: agent.id, cwd, definitionId: '@deepseek-ai/dsh-command-compact' });
    this.compactTargets.set(target, { agent, session, commands, agents, generation });
    return target;
  }
  isCompactTargetCurrent(target) {
    const captured = target && typeof target === 'object' ? this.compactTargets.get(target) : undefined;
    if (!captured || this.signal.aborted || captured.generation !== this.compactServiceGeneration || captured.commands !== this.commands || captured.agents !== this.agents
      || this.agents?.get(target.sessionId) !== captured.agent || captured.agent.id !== target.sessionId || captured.agent.session !== captured.session
      || captured.session.header?.id !== target.sessionId || captured.session.header?.cwd !== target.cwd || captured.session.header?.origin === 'subagent'
      || captured.session.header?.parentSession != null || target.definitionId !== '@deepseek-ai/dsh-command-compact') return false;
    try { return captured.commands.find(captured.agent, 'compact')?.definitionId === '@deepseek-ai/dsh-command-compact'; }
    catch { return false; }
  }
  async executeCompact(target, signal) {
    if (!this.isCompactTargetCurrent(target) || signal?.aborted) throw new AppError('COMPACT_TARGET_CHANGED', 'Compact対象のAgentが変化しました。実行結果をPCで確認してください。');
    const captured = this.compactTargets.get(target);
    const executionSignal = AbortSignal.any([this.signal, signal, AbortSignal.timeout(60000)]);
    let abort; const interrupted = new Promise((_, reject) => { abort = () => reject(new AppError('COMPACT_OUTCOME_UNKNOWN', 'Compactの応答を確認できません。自動再実行せずPCで確認してください。')); executionSignal.addEventListener('abort', abort, { once: true }); });
    let operation;
    try {
      // Exact Host command: never substitute prompt, a name-only descriptor, or a private Native API.
      operation = this.commands.execute(captured.agent, '/compact', [], executionSignal);
    } catch { executionSignal.removeEventListener('abort', abort); throw new AppError('COMPACT_OUTCOME_UNKNOWN', 'Compactの結果を確認できません。自動再実行せずPCで確認してください。'); }
    return Promise.race([Promise.resolve(operation), interrupted]).finally(() => executionSignal.removeEventListener('abort', abort));
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
  async verifySession(sessionId) {
    if (this.verifiedSessions.has(sessionId)) return;
    // Never create/adopt a Session to probe compatibility. The caller must first
    // authorize this exact ordinary Session; strict empty modern-page shape is a
    // read-only profile check, with no legacy fallback or alternate envelope.
    const session = (await this.list()).find(value => value.sessionId === sessionId && !value.subagent);
    if (!session) throw new DshRejected('SESSION_NOT_FOUND', 'DSHセッションが見つかりません。');
    const probe = object(await this.call('page', { address: { kind: 'session', sessionId }, throughSeq: -1, maxMessages: 1 }));
    if (!Array.isArray(probe.records) || probe.records.length !== 0 || probe.hasMore !== false) protocol();
    this.verifiedSessions.add(sessionId);
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
  async callRemote(method, ...args) {
    this.signal.throwIfAborted();
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(30000)]);
    let abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    });
    try {
      // Exact generated Remote argument lists: catalog() and rename(request), with no local AbortSignal argument.
      return await Promise.race([Promise.resolve(this.controller[method](...args)), interrupted]);
    } catch (error) {
      if (rejectedBeforeAdmission.has(error?.code)) throw new DshRejected('DSH_REJECTED', 'Native Sessionが受付前に操作を拒否しました。');
      throw new AppError('DSH_REMOTE_ERROR', 'Native Sessionの操作結果を確定できません。PCで確認してください。');
    } finally { signal.removeEventListener('abort', abort); }
  }
  async modelCatalog() {
    if (typeof this.controller.modelCatalog !== 'function') throw new AppError('MODEL_CATALOG_UNAVAILABLE', 'Native model catalogは利用できません。');
    const raw = object(await this.callRemote('modelCatalog'));
    const text = value => {
      if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) protocol();
      return value;
    };
    const modelSelection = value => {
      const item = object(value);
      return { provider: text(item.provider), model: text(item.model), ...(item.reasoningEffort === undefined ? {} : { reasoningEffort: text(item.reasoningEffort) }) };
    };
    if (!Array.isArray(raw.groups) || raw.groups.length > 256 || !Array.isArray(raw.routableProviders)
      || raw.routableProviders.length > 256 || !Array.isArray(raw.failures) || raw.failures.length > 256) protocol();
    let modelCount = 0;
    const groups = raw.groups.map(groupValue => {
      const group = object(groupValue);
      if (!Array.isArray(group.models) || group.models.length > 2048 || (modelCount += group.models.length) > 5000) protocol();
      return { id: text(group.id), name: text(group.name), models: group.models.map(modelValue => {
        const model = object(modelValue);
        const result = { id: text(model.id), name: text(model.name) };
        if (model.reasoning !== undefined) {
          const reasoning = object(model.reasoning);
          if (!Array.isArray(reasoning.efforts) || reasoning.efforts.length > 64) protocol();
          result.reasoning = { efforts: reasoning.efforts.map(effortValue => {
            const effort = object(effortValue); return { id: text(effort.id), name: text(effort.name) };
          }), ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: text(reasoning.defaultEffort) }) };
        }
        return result;
      }) };
    });
    const routableProviders = raw.routableProviders.map(text);
    return { default: modelSelection(raw.default), routableProviders, groups, failedProviders: raw.failures.length };
  }
  async rename(request) {
    if (typeof this.controller.rename !== 'function') throw new AppError('SESSION_RENAME_UNAVAILABLE', 'Native Session title update is not available.');
    if (!request || typeof request.sessionId !== 'string' || !request.sessionId || typeof request.title !== 'string'
      || !request.title.trim() || Array.from(request.title).length > 100 || /[\u0000-\u001f\u007f]/u.test(request.title)) {
      throw new DshRejected('SESSION_TITLE_INVALID', 'Session title is invalid.');
    }
    const value = object(await this.callRemote('rename', { sessionId: request.sessionId, title: request.title }));
    if (typeof value.title !== 'string' || !value.title || value.title.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.title)
      || !Number.isSafeInteger(value.seq) || value.seq < 0) protocol();
    return { title: value.title, seq: value.seq };
  }
  async prompt(sessionId, requestId, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 6000 || typeof sessionId !== 'string' || typeof requestId !== 'string') throw new DshRejected('PROMPT_INVALID', 'テキスト指示が不正です。');
    const result = object(await this.call('prompt', { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }));
    if (result.accepted !== true) protocol();
  }
}
