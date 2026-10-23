import { createHash, randomBytes } from 'node:crypto';
import { AppError, errorCode } from './errors.js';
import { DshRejected, object } from './protocol.js';
import { assistantText, boundedOutput, redact, finalAssistantText, digest, splitFinalOutput } from './output.js';
import { bindingKey, MAX_ACTIVE_RUN_METADATA_RESERVE, PROTECTED_OUTPUT_RETENTION_MS, Store } from './store.js';
import { Policy } from './policy.js';
import type { AgentAdapter, CompactExecution, CompactMaintenanceIntent, CompactMaintenanceState, CompactTarget, Run, SessionInfo, WireEvent, NotificationPreferences, DeliveryPart, BridgeOutputContext, ProtectedOutputIntent, ProtectedOutputItem, ProtectedPayloadStore } from './types.js';
import { terminal } from './types.js';
export interface Actor { userId: string; guildId: string; channelId: string }
export type Notify = (run: Run, part?: { index: number; content: string }) => Promise<void | { messageId: string }>;
export type NotifyWorking = (run: Run) => Promise<{ messageId: string }>;
interface ProtectedIdentity { applicationId: string; botId: string }
const protectedRejection = 'DSHが送信を拒否しました。設定とセッション状態を確認してください。';
const protectedChunkCodepoints = 15000;
const maxProtectedBodyCodepoints = 200000;

function protectedBodyChunks(text: string): string[] {
  const codepoints = [...text];
  if (codepoints.length > maxProtectedBodyCodepoints) throw new AppError('PROTECTED_OUTPUT_TOO_LARGE', '保護出力の上限を超えました。出力を切り詰めず、PCで確認してください。');
  const chunks: string[] = [];
  for (let i = 0; i < codepoints.length; i += protectedChunkCodepoints) chunks.push(codepoints.slice(i, i + protectedChunkCodepoints).join(''));
  return chunks.length ? chunks : [''];
}
export class Engine {
  private ticking = false;
  private protectedOutputLock: Promise<void> = Promise.resolve();
  private readonly sessionMutations = new Set<string>();
  private protectedOutputFault?: string;
  registerWorkspace?: (actor: Actor, alias: string, path: string, confirmed: boolean) => Promise<void>;
  constructor(readonly adapter: AgentAdapter, readonly store: Store, readonly policy: Policy, private readonly secrets: readonly string[] = [], readonly sharedDiscordBindings = false,
    readonly protectedPayloadStore?: ProtectedPayloadStore, private readonly protectedIdentity?: ProtectedIdentity, readonly protectedOutputRequired = false) {
    store.recoverDispatches();
    const persistedFault = store.setting('protected-output-blocked');
    if (persistedFault) this.protectedOutputFault = /^[A-Z0-9_]{1,64}$/u.test(persistedFault) ? persistedFault : 'PROTECTED_OUTPUT_STATE_INVALID';
    if (protectedOutputRequired && (!store.metadataOnly || !protectedPayloadStore || !protectedIdentity)) this.blockProtectedOutput('PROTECTED_OUTPUT_UNAVAILABLE');
    if (protectedOutputRequired && store.protectedIntents().some(intent => intent.state === 'prepared' || intent.state === 'retiring')) this.blockProtectedOutput('PROTECTED_OUTPUT_RECOVERY_PENDING');
  }
  get protectedOutputBlocked(): string | undefined { return this.protectedOutputFault; }
  private blockProtectedOutput(code: string): void {
    this.protectedOutputFault = /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'PROTECTED_OUTPUT_FAILURE';
    try { this.store.setSetting('protected-output-blocked', this.protectedOutputFault); } catch { /* In-memory fence remains for this process. */ }
  }
  private maybeClearProtectedOutputFault(): void {
    if (!this.protectedOutputFault) return;
    try {
      if (this.store.protectedIntents().some(intent => intent.state === 'prepared' || intent.state === 'retiring')) return;
      if (this.store.allRuns().some(run => run.requiresProtectedOutput && terminal(run.state) && !run.protectedOutput)) return;
      this.store.clearSetting('protected-output-blocked'); delete this.protectedOutputFault;
    } catch { /* Fail closed until a later complete observation. */ }
  }
  redactText(text: string): string { return redact(text, this.secrets); }
  async sessions(actor?: Actor): Promise<SessionInfo[]> {
    if (actor) this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    const allowed: SessionInfo[] = [];
    for (const session of await this.adapter.list()) if (!session.subagent && await this.policy.allowsCwd(session.cwd, actor?.guildId)) allowed.push(session);
    if (actor) this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    return allowed.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private async session(sessionId: string, actor: Actor): Promise<SessionInfo> {
    let session = (await this.adapter.list()).find(s => s.sessionId === sessionId && !s.subagent);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'DSHセッションが見つかりません。');
    await this.policy.requireCwd(session.cwd, actor.guildId);
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    if (this.adapter.verifySession) {
      await this.adapter.verifySession(sessionId);
      const confirmed = (await this.adapter.list()).find(s => s.sessionId === sessionId && !s.subagent);
      if (!confirmed || confirmed.cwd !== session.cwd) throw new AppError('SESSION_CHANGED', 'Native Sessionのworkspace identityが変わりました。操作を停止しました。');
      await this.policy.requireCwd(confirmed.cwd, actor.guildId);
      this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
      session = confirmed;
    }
    return session;
  }
  async withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (!sessionId || this.sessionMutations.has(sessionId)) throw new AppError('SESSION_BUSY', '同じBridge Sessionで別の送信・変更処理中です。状態を再確認してください。');
    this.sessionMutations.add(sessionId);
    try { return await operation(); }
    finally { this.sessionMutations.delete(sessionId); }
  }
  private async withProtectedOutputLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.protectedOutputLock; let release!: () => void;
    this.protectedOutputLock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  private async checkProtectedCapacity(additionalMetadataBytes = 0): Promise<void> {
    if (!this.protectedOutputRequired) return;
    try {
      await this.withProtectedOutputLock(async () => {
        if (!this.protectedPayloadStore) throw new AppError('PROTECTED_OUTPUT_UNAVAILABLE', '保護出力を利用できません。');
        this.store.verifyProtectedCapacity(await this.protectedPayloadStore.stats(), additionalMetadataBytes);
      });
    } catch (error) { this.blockProtectedOutput(errorCode(error)); throw error; }
  }
  private key(actor: Actor): string { return bindingKey(actor.guildId, actor.channelId, this.sharedDiscordBindings && actor.guildId !== 'telegram' ? 'shared' : actor.userId); }
  binding(actor: Actor): string | undefined { return this.store.binding(this.key(actor)); }
  bindingVersion(actor: Actor): number { return this.store.bindingVersion(this.key(actor)); }
  async selectedSession(actor: Actor): Promise<{ session: SessionInfo | undefined; bindingVersion: number }> {
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    const id = this.binding(actor), version = this.bindingVersion(actor);
    const session = id ? await this.session(id, actor) : undefined;
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    if (this.binding(actor) !== id || this.bindingVersion(actor) !== version) throw new AppError('BINDING_CONFLICT', '選択が変更されました。再確認してください。');
    return { session, bindingVersion: version };
  }
  async bind(actor: Actor, sessionId: string, expectedVersion = this.bindingVersion(actor)): Promise<void> {
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    await this.session(sessionId, actor);
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    this.store.bind(this.key(actor), sessionId, expectedVersion, this.sharedDiscordBindings);
  }
  unbind(actor: Actor): void { this.policy.authorize(actor.userId, actor.guildId, actor.channelId); this.store.unbind(this.key(actor)); }
  async compact(actor: Actor, confirmed: boolean): Promise<CompactMaintenanceIntent> {
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    if (!confirmed) throw new AppError('COMPACT_CONFIRMATION_REQUIRED', '実行前に明示確認が必要です。');
    const sessionId = this.binding(actor), bindingVersion = this.bindingVersion(actor);
    if (!sessionId) throw new AppError('NOT_BOUND', '先にDSH Sessionを選択してください。');
    const identity = this.protectedIdentity;
    if (!identity?.applicationId || !identity.botId) throw new AppError('COMPACT_UNAVAILABLE', 'Compactの対象情報を確認できません。');
    if (!this.adapter.prepareCompactTarget || !this.adapter.isCompactTargetCurrent || !this.adapter.executeCompact)
      throw new AppError('COMPACT_UNAVAILABLE', 'Native Compact commandを利用できません。');
    return this.withSessionMutation(sessionId, async () => {
      const assertSelection = (): void => {
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        if (this.binding(actor) !== sessionId || this.bindingVersion(actor) !== bindingVersion)
          throw new AppError('BINDING_CONFLICT', '選択が変更されました。再確認してください。');
      };
      const assertNoRun = (): void => {
        if (this.store.active().some(run => run.sessionId === sessionId)) throw new AppError('SESSION_BUSY', 'このSessionには未完了のBridge Runがあります。');
      };
      const inspectIdle = async (expectedCursor?: number): Promise<{ session: SessionInfo; cursor: number }> => {
        assertSelection();
        assertNoRun();
        const session = await this.session(sessionId, actor);
        assertSelection();
        if (typeof session.running !== 'boolean') throw new AppError('SESSION_STATE_UNKNOWN', 'Native Sessionの実行状態を確認できません。');
        if (session.running) throw new AppError('SESSION_BUSY', 'Native Sessionが実行中です。');
        if (!session.cwd) throw new AppError('WORKSPACE_DENIED', 'Sessionのworkspaceを確認できません。');
        const snapshot = await this.adapter.snapshot(sessionId);
        assertSelection();
        if (!snapshot || typeof snapshot !== 'object' || !snapshot.values || typeof snapshot.values !== 'object'
          || !Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0 || Object.is(snapshot.cursor, -0))
          throw new AppError('SESSION_STATE_UNKNOWN', 'Native Sessionの状態を確認できません。');
        let inbox: Record<string, unknown>;
        try { inbox = object(snapshot.values.inbox); }
        catch { throw new AppError('SESSION_STATE_UNKNOWN', 'Native queue状態を確認できません。'); }
        const nextTurn = inbox['next-turn'], nextStep = inbox['next-step'];
        if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) throw new AppError('SESSION_STATE_UNKNOWN', 'Native queue状態を確認できません。');
        if (nextTurn.length || nextStep.length) throw new AppError('SESSION_BUSY', 'Native queueに未処理の入力があります。');
        if (expectedCursor !== undefined && snapshot.cursor !== expectedCursor) throw new AppError('SESSION_CHANGED', 'Native SessionがCompact確認中に変わりました。');
        assertNoRun();
        return { session, cursor: snapshot.cursor };
      };
      const initial = await inspectIdle();
      const cwd = initial.session.cwd!;
      const target = await this.adapter.prepareCompactTarget!(sessionId, cwd);
      assertSelection();
      if (target.sessionId !== sessionId || target.cwd !== cwd || !target.agentId
        || target.definitionId !== '@deepseek-ai/dsh-command-compact' || !this.adapter.isCompactTargetCurrent!(target))
        throw new AppError('COMPACT_TARGET_CHANGED', 'Native Compact対象が変わりました。再確認してください。');
      const fresh = await inspectIdle(initial.cursor);
      if (fresh.session.cwd !== cwd || !this.adapter.isCompactTargetCurrent!(target))
        throw new AppError('COMPACT_TARGET_CHANGED', 'Native Compact対象が変わりました。再確認してください。');
      assertSelection();
      assertNoRun();
      const intent: CompactMaintenanceIntent = {
        schemaVersion: 1, intentId: randomBytes(32).toString('hex'), sessionId, agentId: target.agentId,
        applicationId: identity.applicationId, botId: identity.botId,
        ownerId: actor.userId, guildId: actor.guildId, channelId: actor.channelId,
        bindingMode: this.sharedDiscordBindings && actor.guildId !== 'telegram' ? 'shared' : 'actor', bindingId: this.key(actor), bindingVersion,
        workspaceDigest: createHash('sha256').update(cwd).digest('hex'), definitionId: '@deepseek-ai/dsh-command-compact',
        state: 'unknown', dispatchedAt: Date.now()
      };
      this.store.reserveCompactIntent(intent);
      const unknownOutcome = (commandId?: string): CompactMaintenanceIntent => {
        if (commandId && commandId.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(commandId)) {
          try { this.store.recordCompactOutcome(intent.intentId, { state: 'unknown', commandId }); } catch { /* The original durable unknown intent remains authoritative. */ }
        }
        let current: CompactMaintenanceIntent;
        try { current = this.store.compactIntent(intent.intentId) ?? intent; } catch { current = intent; }
        assertSelection();
        return current;
      };
      let execution: CompactExecution | undefined;
      try { execution = await this.adapter.executeCompact!(target, new AbortController().signal); }
      catch { return unknownOutcome(); }
      if (!execution || typeof execution.commandId !== 'string' || !execution.commandId.length || execution.commandId.length > 128
        || /[\u0000-\u001f\u007f]/u.test(execution.commandId) || !execution.result || typeof execution.result !== 'object') return unknownOutcome();
      const commandId = execution.commandId;
      const result = execution.result;
      let state: CompactMaintenanceState;
      let sourceEventSeq: number | undefined;
      if (result.kind === 'success') {
        if (result.text !== undefined && typeof result.text !== 'string') return unknownOutcome(commandId);
        if (result.sourceEventSeq !== undefined) {
          if (!Number.isSafeInteger(result.sourceEventSeq) || result.sourceEventSeq < 0 || Object.is(result.sourceEventSeq, -0)) return unknownOutcome(commandId);
          state = 'completed'; sourceEventSeq = result.sourceEventSeq;
        } else if (result.text === 'No compactable history yet.') state = 'noop';
        else return unknownOutcome(commandId);
      } else if (result.kind === 'error' && typeof result.text === 'string' && result.text.length > 0) return unknownOutcome(commandId);
      else return unknownOutcome(commandId);
      let settled: CompactMaintenanceIntent;
      try {
        settled = this.store.recordCompactOutcome(intent.intentId, {
          state, commandId, ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }), outcomeAt: Math.max(Date.now(), intent.dispatchedAt)
        });
      } catch { return unknownOutcome(commandId); }
      assertSelection();
      return settled;
    });
  }
  async create(actor: Actor, workspace: string): Promise<string> {
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    const cwd = this.policy.workspace(workspace, actor.guildId); await this.policy.requireCwd(cwd, actor.guildId);
    const expectedVersion = this.bindingVersion(actor);
    const sessionId = await this.adapter.create(cwd);
    try { await this.bind(actor, sessionId, expectedVersion); }
    catch { throw new AppError('CREATED_NOT_BOUND', `Session作成済み: ${sessionId}。選択は競合または認可変更により更新されませんでした。再作成せず確認してください。`); }
    return sessionId;
  }
  async submit(actor: Actor, id: string, text: string): Promise<Run> {
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    if (this.protectedOutputRequired && this.protectedOutputFault) throw new AppError(this.protectedOutputFault, '保護出力の状態を確認できないため、新しい実行を停止しています。');
    if (!text.trim() || text.length > 6000) throw new AppError('PROMPT_INVALID', '指示は1〜6000文字で指定してください。');
    const existing = this.store.get(id);
    const payloadDigest = createHash('sha256').update(text, 'utf8').digest('hex');
    if (existing) {
      this.checkOwner(actor, existing);
      if (existing.payloadDigest && existing.payloadDigest !== payloadDigest) throw new AppError('REQUEST_CONFLICT', '同じ実行IDに異なる指示は送信できません。');
      return existing;
    }
    const bindingVersion = this.bindingVersion(actor);
    const sessionId = this.binding(actor);
    if (!sessionId) throw new AppError('NOT_BOUND', '/agent bindでセッションを選択してください。');
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.session(sessionId, actor);
      if (session.running) throw new AppError('SESSION_BUSY', 'DSHが実行中です。完了後に送信してください。');
      let snapshot = await this.adapter.snapshot(sessionId);
      if (!Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0) throw new AppError('SESSION_STATE_UNKNOWN', 'Native Session cursorを確認できません。PCで確認してください。');
      const runCursorFloor = snapshot.cursor;
      const assertEmptyQueue = (values: Record<string, unknown>): void => {
        const rawInbox = values.inbox;
        if (!rawInbox || typeof rawInbox !== 'object' || Array.isArray(rawInbox)) throw new AppError('SESSION_STATE_UNKNOWN', 'Native queue状態を確認できません。指示を送信せずPCで確認してください。');
        const inbox = object(rawInbox);
        if (!Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) throw new AppError('SESSION_STATE_UNKNOWN', 'Native queue状態を確認できません。指示を送信せずPCで確認してください。');
        if (inbox['next-turn'].length > 0 || inbox['next-step'].length > 0) throw new AppError('SESSION_BUSY', 'DSHに未処理の指示があります。PCで確認してください。');
      };
      assertEmptyQueue(snapshot.values);
      this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
      if (this.binding(actor) !== sessionId || this.bindingVersion(actor) !== bindingVersion) throw new AppError('BINDING_CONFLICT', '選択が変更されました。再確認してください。');
      await this.checkProtectedCapacity(MAX_ACTIVE_RUN_METADATA_RESERVE);
      // Quota/helper work is an await boundary: re-read the exact Native Session,
      // workspace, running state and queue, then check the binding revision again
      // synchronously immediately before durable admission and the only prompt.
      const confirmedSession = await this.session(sessionId, actor);
      if (confirmedSession.cwd !== session.cwd) throw new AppError('SESSION_CHANGED', 'Native Session workspace identityが変わりました。');
      if (confirmedSession.running) throw new AppError('SESSION_BUSY', 'DSHが実行中です。完了後に送信してください。');
      snapshot = await this.adapter.snapshot(sessionId);
      if (!Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < runCursorFloor) throw new AppError('SESSION_STATE_UNKNOWN', 'Native Session cursorが不連続です。PCで確認してください。');
      assertEmptyQueue(snapshot.values);
      this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
      if (this.binding(actor) !== sessionId || this.bindingVersion(actor) !== bindingVersion) throw new AppError('BINDING_CONFLICT', '選択が変更されました。再確認してください。');
      const now = Date.now();
      const run: Run = { id, requestId: `${actor.guildId === 'telegram' ? 'telegram' : 'discord'}:${id}`, sessionId, ...actor,
        state: 'dispatching', createdAt: now, updatedAt: now, lastSeq: snapshot.cursor, startSeq: snapshot.cursor, payloadDigest, turn: null,
        output: '', result: '', admitted: false, contaminated: false, bindingVersion,
        ...(this.store.metadataOnly && actor.guildId !== 'telegram' ? { notificationPreferences: this.notificationPreferences(actor) } : {}),
        ...(this.protectedOutputRequired && actor.guildId !== 'telegram' ? { requiresProtectedOutput: true } : {}),
        notification: 'none', notifyAttempts: 0, nextNotifyAt: 0, lastError: '' };
      this.store.create(run); // Durable intent BEFORE the only prompt call. Never replay uncertain dispatches.
      try { await this.adapter.prompt(sessionId, run.requestId, text); run.state = 'accepted'; }
      catch (error) {
        run.lastError = errorCode(error);
        if (error instanceof DshRejected) { run.state = 'failed'; run.result = protectedRejection; run.notification = 'pending'; }
        else { run.state = 'unknown'; run.result = '送信結果が不明です。再送せず履歴を照合中です。'; }
      }
      if (terminal(run.state)) {
        run.bodyDigest = digest(run.result); this.planDelivery(run);
        if (run.requiresProtectedOutput) {
          try {
            await this.ensureProtectedOutput(run, 'bridge-rejection'); this.maybeClearProtectedOutputFault();
            run.updatedAt = Date.now(); return run; // Terminal row and manifest committed together.
          } catch (error) {
            const code = errorCode(error); this.blockProtectedOutput(code);
            const committed = this.store.get(run.id);
            if (committed?.protectedOutput?.state === 'published' && terminal(committed.state)) return committed;
            run.state = 'unknown'; run.notification = 'none'; run.lastError = code;
            run.output = ''; run.result = ''; run.finalText = undefined; run.bodyMissing = true; run.updatedAt = Date.now();
          }
        }
      }
      run.updatedAt = Date.now(); this.store.save(run); return run;
    });
  }
  private checkOwner(actor: Actor, run: Run): void {
    if (run.userId !== actor.userId || run.guildId !== actor.guildId || run.channelId !== actor.channelId) throw new AppError('RUN_NOT_FOUND', 'この操作元の実行履歴が見つかりません。');
  }
  async status(actor: Actor, id?: string, requireLiveAccess = true, hydrateBody = true): Promise<Run | undefined> {
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    const run = id ? this.store.get(id) : this.store.latest(actor.userId, actor.guildId, actor.channelId);
    if (run) {
      this.checkOwner(actor, run);
      if (requireLiveAccess) {
        await this.session(run.sessionId, run);
        if (hydrateBody) { await this.restoreBody(run); await this.session(run.sessionId, run); }
        this.policy.authorize(actor.userId, actor.guildId, actor.channelId); this.checkOwner(actor, run);
      }
      if (run.requiresProtectedOutput && !run.bodyMissing && run.protectedOutput?.state === 'published') {
        if (!requireLiveAccess) throw new AppError('PROTECTED_OUTPUT_UNAVAILABLE', '同一Native Sessionの確認なしでは本文を返せません。');
        this.assertProtectedReadCurrent(run, run.protectedOutput);
      }
    } return run;
  }
  notificationPreferences(actor: Actor): NotificationPreferences & { pending: number; unknown: number; blocked: number; incomplete: number; undeliveredParts: number } {
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    const raw = this.store.setting(`notifications:${this.key(actor)}:${actor.userId}`);
    let preferences: NotificationPreferences = { destination: 'dm', progress: false };
    if (raw) {
      const saved = JSON.parse(raw) as NotificationPreferences;
      if (!['dm', 'origin'].includes(saved.destination) || typeof saved.progress !== 'boolean') throw new AppError('DB_CORRUPT', '通知設定を読み込めません。');
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
  setNotificationPreferences(actor: Actor, preferences: { destination: 'dm' | 'origin'; progress?: boolean }, confirmOrigin = false): void {
    this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    if (!['dm', 'origin'].includes(preferences.destination) || preferences.progress !== undefined && typeof preferences.progress !== 'boolean') throw new AppError('PREFERENCE_INVALID', '通知設定が不正です。');
    if (preferences.destination === 'origin' && (!confirmOrigin || actor.guildId === 'telegram')) throw new AppError('CONFIRMATION_REQUIRED', '元のサーバー会話への公開配信には明示確認が必要です。');
    if (preferences.progress === true) throw new AppError('PROGRESS_UNSUPPORTED', '途中通知は未対応です。全文完了通知のみ利用できます。');
    const current = this.notificationPreferences(actor);
    this.store.setSetting(`notifications:${this.key(actor)}:${actor.userId}`, JSON.stringify({ destination: preferences.destination, progress: preferences.progress ?? current.progress }));
  }
  async resultPage(actor: Actor, id?: string, page = 1): Promise<{ content: string; page: number; pages: number }> {
    const run = await this.status(actor, id);
    if (!run) throw new AppError('RUN_NOT_FOUND', 'この操作元の実行履歴が見つかりません。');
    if (run.requiresProtectedOutput && !run.bodyMissing && run.protectedOutput?.state === 'published') {
      this.policy.authorize(actor.userId, actor.guildId, actor.channelId); this.checkOwner(actor, run);
      this.assertProtectedReadCurrent(run, run.protectedOutput);
    }
    const text = terminal(run.state) ? run.result : run.contaminated ? '混在した出力は表示できません。' : run.output || run.result || 'テキスト出力はまだありません。';
    // Manual pages are independent of the automatic delivery cap.
    const plan = splitFinalOutput(text, run.id, false);
    if (!Number.isSafeInteger(page) || page < 1 || page > plan.parts.length) throw new AppError('PAGE_INVALID', `ページは1〜${plan.parts.length}で指定してください。`);
    return { content: plan.parts[page - 1]!.content, page, pages: plan.parts.length };
  }
  async retryNotification(actor: Actor, id: string, part?: number, confirmDuplicateRisk = false): Promise<void> {
    if (this.ticking) throw new AppError('DELIVERY_BUSY', '配信処理中です。後で再確認してください。');
    const run = await this.status(actor, id);
    if (this.ticking) throw new AppError('DELIVERY_BUSY', '配信処理中です。後で再確認してください。');
    if (!run || !terminal(run.state)) throw new AppError('RUN_NOT_FINISHED', '完了した実行IDを指定してください。');
    if (run.delivery) {
      const next = run.delivery.parts.find(p => p.state !== 'sent');
      if (!next) return; // Sent parts are never replayed.
      if (part !== undefined && part !== next.index) throw new AppError('PART_ORDER', '未確定の先頭partだけを再試行できます。');
      if (next.nextAttemptAt > Date.now()) throw new AppError('DELIVERY_RATE_LIMIT', 'Discord指定の待機時間が残っています。期限後に再試行してください。');
      if (next.state === 'sending' || next.state === 'unknown') {
        if (!confirmDuplicateRisk) throw new AppError('DUPLICATE_RISK_CONFIRMATION_REQUIRED', '配送不明です。重複リスクを明示確認して再試行してください。');
      }
      this.policy.authorize(actor.userId, actor.guildId, actor.channelId);
      next.state = 'pending'; next.nextAttemptAt = 0; next.lastError = '';
    } else if (run.notification === 'unknown') throw new AppError('NOTIFICATION_UNKNOWN', '旧配送の不明な通知は再送できません。/agent resultで確認してください。');
    else if (this.store.metadataOnly && run.guildId !== 'telegram' && run.notification === 'sent') return; // Legacy sent receipts are not adopted into a new plan.
    run.notification = 'pending'; run.notifyAttempts = 0; run.nextNotifyAt = 0; this.store.save(run);
  }
  private planDelivery(run: Run): void {
    if (!this.store.metadataOnly || run.guildId === 'telegram' || !terminal(run.state) || run.delivery) return;
    // Legacy unknown has no trustworthy per-part receipt. Never adopt/replay it.
    if (run.notification === 'unknown' || run.notification === 'sent') return;
    let plan;
    try { plan = splitFinalOutput(run.result, run.id); }
    catch { run.notification = 'none'; run.lastError = 'OUTPUT_UNAVAILABLE'; return; }
    if (!run.requiresProtectedOutput) run.bodyExpiresAt ??= Date.now() + PROTECTED_OUTPUT_RETENTION_MS;
    const preferences = run.notificationPreferences ?? { destination: 'dm', progress: false };
    run.bodyDigest = digest(run.result);
    run.delivery = { id: run.id, destination: preferences.destination, userId: run.userId, guildId: run.guildId, channelId: run.channelId,
      bodyDigest: run.originalFinalDigest ?? run.bodyDigest, digest: plan.digest, complete: plan.complete, codepoints: plan.codepoints,
      parts: plan.parts.map((part, index) => ({ index: index + 1, state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: '', digest: digest(part.content) })) };
  }
  private async authorizeProtectedRun(run: Run): Promise<void> {
    if (!this.protectedOutputRequired || !this.protectedPayloadStore || !this.protectedIdentity || !run.requiresProtectedOutput) throw new AppError('PROTECTED_OUTPUT_UNAVAILABLE', '保護出力を利用できません。');
    this.policy.authorize(run.userId, run.guildId, run.channelId);
    const key = this.key(run);
    if (this.store.binding(key) !== run.sessionId || this.store.bindingVersion(key) !== run.bindingVersion) throw new AppError('BINDING_CONFLICT', '固定されたSession選択が変更されました。');
    await this.session(run.sessionId, run);
    this.policy.authorize(run.userId, run.guildId, run.channelId);
    if (this.store.binding(key) !== run.sessionId || this.store.bindingVersion(key) !== run.bindingVersion) throw new AppError('BINDING_CONFLICT', '固定されたSession選択が変更されました。');
  }
  private ensureProtectedOutput(run: Run, completionSource: BridgeOutputContext['completionSource']): Promise<void> {
    return this.withProtectedOutputLock(() => this.ensureProtectedOutputLocked(run, completionSource));
  }
  private async ensureProtectedOutputLocked(run: Run, completionSource: BridgeOutputContext['completionSource']): Promise<void> {
    try {
      const existingIntent = this.store.protectedIntent(run.id);
      if (this.protectedOutputFault && existingIntent?.state !== 'prepared') throw new AppError(this.protectedOutputFault, '保護出力の状態を確認できないため、公開を停止しています。');
      await this.authorizeProtectedRun(run);
      if (!terminal(run.state) || !run.delivery || !run.bodyDigest || !run.payloadDigest || run.startSeq === undefined
        || !Number.isSafeInteger(run.lastSeq) || !Number.isSafeInteger(run.bindingVersion)) throw new AppError('PROTECTED_OUTPUT_INVALID', '保護出力に必要なRun情報を検証できません。');
      if (run.protectedOutput?.state === 'published') {
        if (run.protectedOutput.bodyDigest !== run.bodyDigest || run.protectedOutput.deliveryPlanDigest !== run.delivery.digest
          || run.protectedOutput.outputDigest !== (run.originalFinalDigest ?? run.bodyDigest)) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '既存の保護出力とRunが一致しません。');
        return; // Atomic publish already cleared in-memory text; retry without a plaintext digest check.
      }
      if (run.bodyDigest !== digest(run.result)) throw new AppError('PROTECTED_OUTPUT_INVALID', '保護出力の本文digestが一致しません。');
      const plan = splitFinalOutput(run.result, run.id);
      if (plan.digest !== run.delivery.digest || plan.parts.length !== run.delivery.parts.length
        || plan.parts.some((part, index) => run.delivery!.parts[index]!.index !== index + 1 || digest(part.content) !== run.delivery!.parts[index]!.digest)) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '固定された配信計画が一致しません。');
      const bodyChunks = protectedBodyChunks(run.result);
      const specs: Array<{ kind: 'body'|'part'; index: number; count: number; text: string }> = [
        ...bodyChunks.map((text, index) => ({ kind: 'body' as const, index, count: bodyChunks.length, text })),
        ...plan.parts.map((part, index) => ({ kind: 'part' as const, index, count: plan.parts.length, text: part.content }))
      ];
      if (specs.length > 200) throw new AppError('PROTECTED_OUTPUT_TOO_LARGE', '保護出力の項目上限を超えました。');
      const outputDigest = run.originalFinalDigest ?? run.bodyDigest;
      const inputs = specs.map(spec => {
        const context: BridgeOutputContext = {
          profile: 'local-bridge-output-v1', transport: 'discord', applicationId: this.protectedIdentity!.applicationId, botId: this.protectedIdentity!.botId,
          nativeSessionId: run.sessionId, bridgeRunId: run.id, clientRequestId: run.requestId, promptDigest: run.payloadDigest!,
          observedTurn: run.turn, bridgeStartSeq: run.startSeq!, lastObservedSeq: run.lastSeq, completionSource, terminalState: run.state as 'succeeded'|'failed'|'interrupted',
          ownerId: run.userId, guildId: run.guildId, channelId: run.channelId, threadId: null,
          bindingMode: this.sharedDiscordBindings && run.guildId !== 'telegram' ? 'shared' : 'actor', bindingId: this.key(run), bindingVersion: run.bindingVersion!,
          destination: run.delivery!.destination, preRedactionDigest: run.originalFinalDigest ?? null, redactedBodyDigest: run.bodyDigest!,
          deliveryPlanDigest: run.delivery!.digest, itemKind: spec.kind, itemIndex: spec.index, itemCount: spec.count, itemDigest: digest(spec.text)
        };
        return { kind: 'bridge-output' as const, context, text: spec.text };
      });
      const estimates = await this.protectedPayloadStore!.estimate(inputs);
      if (estimates.length !== specs.length) throw new AppError('PROTECTED_PAYLOAD_FAILURE', '保護出力のサイズ見積りが一致しません。');
      const existing = this.store.protectedIntent(run.id);
      let intent: ProtectedOutputIntent;
      if (existing) {
        if (existing.state !== 'prepared' || existing.outputDigest !== outputDigest || existing.bodyDigest !== run.bodyDigest
          || existing.deliveryPlanDigest !== run.delivery.digest || existing.items.length !== specs.length) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '既存の準備記録が現在のRunと一致しません。');
        for (let i = 0; i < specs.length; i++) {
          const item = existing.items[i]!, estimate = estimates[i]!, input = inputs[i]!, spec = specs[i]!;
          if (item.kind !== spec.kind || item.index !== spec.index || item.count !== spec.count || item.contentDigest !== input.context.itemDigest
            || item.digest !== estimate.digest || item.byteLength !== estimate.byteLength || item.cipherBytes !== estimate.cipherBytes
            || JSON.stringify(item.context) !== JSON.stringify(input.context)) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '準備記録の内容またはscopeが一致しません。');
        }
        intent = existing;
      } else {
        const intentId = randomBytes(32).toString('hex'); const createdAt = Date.now();
        const items: ProtectedOutputItem[] = specs.map((spec, index) => ({
          ref: randomBytes(32).toString('hex'), kind: spec.kind, index: spec.index, count: spec.count, digest: estimates[index]!.digest,
          contentDigest: inputs[index]!.context.itemDigest, byteLength: estimates[index]!.byteLength, cipherBytes: estimates[index]!.cipherBytes, context: inputs[index]!.context
        }));
        const manifest: Run['protectedOutput'] = { schemaVersion: 1, profile: 'local-bridge-output-v1', intentId, state: 'published', outputDigest,
          bodyDigest: run.bodyDigest, deliveryPlanDigest: run.delivery.digest, items, createdAt, deletedRefs: [] };
        const metadata = { ...run, output: '', result: '', finalText: undefined, bodyMissing: true, protectedOutput: manifest };
        intent = { schemaVersion: 1, profile: 'local-bridge-output-v1', intentId, runId: run.id, state: 'prepared', outputDigest,
          bodyDigest: run.bodyDigest, deliveryPlanDigest: run.delivery.digest, items, createdAt,
          reservedMetadataBytes: Buffer.byteLength(JSON.stringify(metadata), 'utf8') + 65536, deletedRefs: [] };
        const inventory = await this.protectedPayloadStore!.stats();
        intent = this.store.reserveProtectedIntent(intent, inventory);
      }
      const inventoryBeforeWrite = await this.protectedPayloadStore!.stats();
      this.store.verifyProtectedCapacity(inventoryBeforeWrite);
      await this.protectedPayloadStore!.createManyWithRefs(intent.items.map((item, index) => ({ ref: item.ref, input: inputs[index]!, reserveBytes: item.cipherBytes })));
      const inventory = await this.protectedPayloadStore!.stats();
      this.store.verifyProtectedCapacity(inventory);
      const actual = new Map(inventory.files.map(file => [file.ref, file.bytes]));
      if (intent.items.some(item => actual.get(item.ref) !== item.cipherBytes)) throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '保護出力ファイルの予約サイズと実体が一致しません。');
      const restored = await this.protectedPayloadStore!.readMany(intent.items.map(item => ({ ref: item.ref, expected: { kind: 'bridge-output' as const, digest: item.digest, context: item.context } })));
      if (restored.length !== specs.length || restored.some((payload, index) => payload.text !== specs[index]!.text || digest(payload.text) !== intent.items[index]!.contentDigest)) throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '保護出力のreadback検証に失敗しました。');
      await this.authorizeProtectedRun(run); // Recheck exact Native Session, actor, pinned channel and Binding after every awaited write/read.
      run.output = ''; run.result = ''; run.finalText = undefined; run.bodyMissing = true; run.updatedAt = Date.now();
      this.store.commitProtectedOutput(run, intent.intentId);
      this.store.verifyProtectedCapacity(await this.protectedPayloadStore!.stats());
    } catch (error) {
      this.blockProtectedOutput(errorCode(error));
      throw error;
    }
  }
  private validateProtectedManifestScope(run: Run, manifest: NonNullable<Run['protectedOutput']>): void {
    const identity = this.protectedIdentity, delivery = run.delivery;
    const expectedMode = this.sharedDiscordBindings && run.guildId !== 'telegram' ? 'shared' : 'actor';
    if (!identity || !delivery || !run.payloadDigest || run.startSeq === undefined || run.bindingVersion === undefined || !run.bodyDigest
      || manifest.profile !== 'local-bridge-output-v1' || manifest.bodyDigest !== run.bodyDigest || manifest.deliveryPlanDigest !== delivery.digest
      || manifest.outputDigest !== (run.originalFinalDigest ?? run.bodyDigest) || manifest.items.length < 1) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力manifestがRunと一致しません。');
    for (const item of manifest.items) {
      const context = item.context;
      if (context.applicationId !== identity.applicationId || context.botId !== identity.botId
        || context.nativeSessionId !== run.sessionId || context.bridgeRunId !== run.id || context.clientRequestId !== run.requestId
        || context.promptDigest !== run.payloadDigest || context.observedTurn !== run.turn || context.bridgeStartSeq !== run.startSeq
        || context.lastObservedSeq !== run.lastSeq || context.terminalState !== run.state || context.ownerId !== run.userId
        || context.guildId !== run.guildId || context.channelId !== run.channelId || context.threadId !== null
        || context.bindingMode !== expectedMode || context.bindingId !== this.key(run) || context.bindingVersion !== run.bindingVersion
        || context.destination !== delivery.destination || context.preRedactionDigest !== (run.originalFinalDigest ?? null)
        || context.redactedBodyDigest !== run.bodyDigest || context.deliveryPlanDigest !== delivery.digest
        || context.itemKind !== item.kind || context.itemIndex !== item.index || context.itemCount !== item.count
        || context.itemDigest !== item.contentDigest || !/^[a-f0-9]{64}$/u.test(item.digest)) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力のNative Session・deployment・owner・binding scopeが一致しません。');
      if (context.completionSource === 'native-turn' ? !run.admitted || run.turn === null : context.completionSource === 'bridge-rejection' ? run.admitted || run.state !== 'failed' || run.turn !== null : true) {
        throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の完了根拠が一致しません。');
      }
    }
  }
  private assertProtectedReadCurrent(run: Run, manifest: NonNullable<Run['protectedOutput']>): Run {
    const current = this.store.get(run.id);
    if (run.bodyExpiresAt !== undefined && Date.now() >= run.bodyExpiresAt || current?.bodyExpiresAt !== undefined && Date.now() >= current.bodyExpiresAt) throw new AppError('BODY_EXPIRED', '本文の保持期限（7日）を過ぎました。');
    const intent = this.store.protectedIntent(run.id);
    if (!current?.protectedOutput || current.protectedOutput.state !== 'published' || current.protectedOutput.intentId !== manifest.intentId
      || current.protectedOutput.bodyDigest !== manifest.bodyDigest || current.protectedOutput.deliveryPlanDigest !== manifest.deliveryPlanDigest
      || current.protectedOutput.outputDigest !== manifest.outputDigest || JSON.stringify(current.protectedOutput.items) !== JSON.stringify(manifest.items)
      || current.protectedOutput.resolvedAt !== current.bodyResolvedAt || current.protectedOutput.expiresAt !== current.bodyExpiresAt
      || !intent || intent.state !== 'published' || intent.intentId !== manifest.intentId || intent.outputDigest !== manifest.outputDigest
      || intent.bodyDigest !== manifest.bodyDigest || intent.deliveryPlanDigest !== manifest.deliveryPlanDigest
      || intent.resolvedAt !== current.bodyResolvedAt || intent.expiresAt !== current.bodyExpiresAt
      || JSON.stringify(intent.items) !== JSON.stringify(manifest.items) || JSON.stringify(intent.deletedRefs) !== JSON.stringify(manifest.deletedRefs)
      || current.sessionId !== run.sessionId || current.requestId !== run.requestId || current.bodyDigest !== run.bodyDigest
      || current.bindingVersion !== run.bindingVersion || current.delivery?.digest !== run.delivery?.digest || !terminal(current.state) || current.state !== run.state) {
      throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の永続Run・expiry・intent状態が変わりました。');
    }
    const key = this.key(current);
    if (this.store.binding(key) !== current.sessionId || this.store.bindingVersion(key) !== current.bindingVersion) throw new AppError('BINDING_CONFLICT', '保護出力を確認するSession選択が変更されました。');
    this.validateProtectedManifestScope(current, current.protectedOutput);
    return current;
  }
  private async restoreProtectedBody(run: Run): Promise<void> {
    return this.withProtectedOutputLock(async () => {
      const manifest = run.protectedOutput;
      if (!manifest || manifest.state !== 'published' || !this.protectedPayloadStore || !run.delivery) throw new AppError('PROTECTED_OUTPUT_UNAVAILABLE', '保護出力を復元できません。');
      this.validateProtectedManifestScope(run, manifest); this.assertProtectedReadCurrent(run, manifest);
      const bodyItems = manifest.items.filter(item => item.kind === 'body').sort((a, b) => a.index - b.index);
      const partItems = manifest.items.filter(item => item.kind === 'part').sort((a, b) => a.index - b.index);
      if (!bodyItems.length || bodyItems.some((item, index) => item.index !== index || item.count !== bodyItems.length)
        || partItems.length !== run.delivery.parts.length || partItems.some((item, index) => item.index !== index || item.count !== partItems.length)) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力manifestの分割を検証できません。');
      const items = [...bodyItems, ...partItems];
      await this.authorizeProtectedRun(run);
      const values = await this.protectedPayloadStore.readMany(items.map(item => ({ ref: item.ref, expected: { kind: 'bridge-output' as const, digest: item.digest, context: item.context } })));
      if (values.length !== items.length || values.some((value, index) => digest(value.text) !== items[index]!.contentDigest)) throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '保護出力digestを確認できません。');
      const body = values.slice(0, bodyItems.length).map(value => value.text).join('');
      const parts = values.slice(bodyItems.length).map(value => value.text);
      const plan = splitFinalOutput(body, run.id);
      if (digest(body) !== manifest.bodyDigest || plan.digest !== manifest.deliveryPlanDigest || plan.parts.length !== parts.length
        || plan.parts.some((part, index) => part.content !== parts[index] || digest(parts[index]!) !== run.delivery!.parts[index]!.digest)) throw new AppError('PROTECTED_PAYLOAD_MISMATCH', '保護出力本文・配信計画のreadbackが一致しません。');
      await this.authorizeProtectedRun(run);
      const current = this.assertProtectedReadCurrent(run, manifest);
      if (current.bodyResolvedAt === undefined) delete run.bodyResolvedAt; else run.bodyResolvedAt = current.bodyResolvedAt;
      if (current.bodyExpiresAt === undefined) delete run.bodyExpiresAt; else run.bodyExpiresAt = current.bodyExpiresAt;
      run.result = body; run.output = body; delete run.bodyMissing; delete run.finalText;
    });
  }
  private async restoreBody(run: Run): Promise<void> {
    if (this.store.metadataOnly && run.bodyExpiresAt !== undefined && Date.now() >= run.bodyExpiresAt) throw new AppError('BODY_EXPIRED', '本文の保持期限（7日）を過ぎました。PCの同一Sessionで確認してください。');
    if (!run.bodyMissing) return;
    if (run.requiresProtectedOutput && run.protectedOutput) { await this.restoreProtectedBody(run); return; }
    if (run.requiresProtectedOutput && terminal(run.state)) throw new AppError('PROTECTED_OUTPUT_UNAVAILABLE', '保護出力の確定または復元を確認できません。');
    if (run.state === 'failed' && !run.admitted) {
      const text = 'DSHが送信を拒否しました。設定とセッション状態を確認してください。';
      if (run.bodyDigest !== digest(text)) throw new AppError('BODY_DIGEST_MISMATCH', '結果本文を検証できません。');
      run.result = text; delete run.bodyMissing; this.store.save(run); return;
    }
    if (run.startSeq === undefined) throw new AppError('BODY_UNAVAILABLE', '本文の復元情報がありません。PCで確認してください。');
    const previousState = run.state;
    const replay: Run = { ...run, state: 'unknown', lastSeq: run.startSeq, turn: null, startStep: undefined, admitted: false, contaminated: false, output: '', result: '', finalText: undefined, originalFinalDigest: undefined, delivery: undefined };
    const snapshot = await this.adapter.snapshot(run.sessionId);
    this.consume(replay, await this.adapter.events(run.sessionId, snapshot.cursor, run.startSeq));
    if (terminal(previousState) && (!replay.admitted || replay.turn === null || replay.state !== previousState)) throw new AppError('BODY_UNAVAILABLE', '結果を安全に復元できません。PCで確認してください。');
    if (terminal(previousState) && this.store.metadataOnly) {
      if (!run.bodyDigest || digest(replay.result) !== run.bodyDigest || run.originalFinalDigest !== undefined && replay.originalFinalDigest !== run.originalFinalDigest) throw new AppError('BODY_DIGEST_MISMATCH', '本文digestを検証できません。PCの同一Sessionで確認してください。');
    }
    // Preserve persisted notification ownership/retry state; only hydrate correlated native text.
    run.output = replay.output; run.result = replay.result; run.finalText = replay.finalText; run.originalFinalDigest = replay.originalFinalDigest; run.lastSeq = replay.lastSeq;
    run.turn = replay.turn; run.startStep = replay.startStep; run.admitted = replay.admitted; run.contaminated = replay.contaminated;
    if (!terminal(previousState) && replay.admitted) {
      run.state = replay.state;
      if (terminal(replay.state)) run.notification = 'pending';
    }
    delete run.bodyMissing; this.planDelivery(run);
    if (terminal(run.state) && run.requiresProtectedOutput) { await this.ensureProtectedOutput(run, 'native-turn'); this.maybeClearProtectedOutputFault(); return; }
    this.store.save(run);
  }
  private consume(run: Run, events: WireEvent[]): void {
    for (const event of events) {
      if (event.type === 'turn/start' && Number.isSafeInteger(event.data.turn) && (event.data.turn as number) >= 0 && !run.admitted) {
        run.turn = event.data.turn as number; run.startStep = undefined; run.contaminated = false;
      }
      if (event.type === 'step/start' && run.turn !== null && event.data.turn === run.turn
        && Number.isSafeInteger(event.data.step) && (event.data.step as number) >= 0) {
        run.startStep = { turn: run.turn, step: event.data.step as number, seq: event.seq };
      }
      if (event.type === 'user/message' && event.surfaceOp === 'append') {
        const source = object(event.data.source);
        if (source.rpcId === run.requestId) {
          if (run.turn === null) throw new AppError('DSH_PROTOCOL', '指示と実行ターンを照合できません。');
          run.admitted = true; run.state = 'running'; run.result = ''; run.lastError = '';
          // Admission remains correlated by the existing exact rpcId contract. The
          // separate work notice needs stronger step-start evidence from Native.
          if (run.workStartedSeq === undefined && source.kind === 'user' && run.startStep?.turn === run.turn && run.startStep.seq < event.seq) {
            run.workStartedSeq = event.seq;
            if (this.store.metadataOnly && run.guildId !== 'telegram' && (!run.workNotice || run.workNotice === 'none')) run.workNotice = 'ready';
          }
        } else if (source.kind === 'user' && run.turn !== null) { run.contaminated = true; run.output = ''; }
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
        } else if (text) run.output = boundedOutput(`${run.output}${run.output ? '\n\n' : ''}${redact(text, this.secrets)}`);
      }
      run.lastSeq = event.seq;
      if (event.type !== 'turn/end' || event.data.turn !== run.turn) continue;
      if (!run.admitted) { run.turn = null; run.contaminated = false; continue; }
      const kind = object(event.data.reason).kind;
      if (run.contaminated) {
        run.state = 'interrupted'; run.output = ''; run.result = '同じターンに別の指示が含まれたため、混在した結果を配信しません。DSHで確認してください。';
      } else if (kind === 'completed') {
        run.state = 'succeeded'; run.result = run.output || 'DSHのターンが完了しました（テキスト出力なし）。';
      } else {
        run.state = kind === 'aborted' ? 'interrupted' : 'failed';
        run.result = `${kind === 'aborted' ? 'DSHで中断されました。' : 'DSHのターンが正常完了しませんでした。'}${run.output ? `\n\n${run.output}` : '\n詳細はPCのDSHで確認してください。'}`;
      }
      run.notification = 'pending'; run.lastError = ''; run.bodyDigest = digest(run.result); this.planDelivery(run); return;
    }
  }
  private async deliverParts(run: Run, notify: Notify): Promise<void> {
    const delivery = run.delivery!;
    let plan;
    try {
      this.policy.authorize(run.userId, run.guildId, run.channelId);
      if (delivery.id !== run.id || delivery.userId !== run.userId || delivery.guildId !== run.guildId || delivery.channelId !== run.channelId || !['dm', 'origin'].includes(delivery.destination)) throw new AppError('DELIVERY_BLOCKED', '固定された通知先が一致しません。');
      await this.session(run.sessionId, run); await this.restoreBody(run);
      plan = splitFinalOutput(run.result, run.id);
      if (plan.digest !== delivery.digest || plan.parts.length !== delivery.parts.length || plan.parts.some((p, i) => delivery.parts[i]!.index !== i + 1 || digest(p.content) !== delivery.parts[i]!.digest)) throw new AppError('BODY_DIGEST_MISMATCH', '結果本文を検証できません。');
    } catch (error) {
      const first = delivery.parts.find(p => p.state !== 'sent');
      if (first && first.state !== 'unknown' && first.state !== 'sending') { first.state = 'blocked'; first.lastError = errorCode(error); }
      run.lastError = errorCode(error); run.notification = delivery.parts.some(p => p.state === 'unknown' || p.state === 'sending') ? 'unknown' : 'none';
      this.store.save(run); return;
    }
    for (const part of delivery.parts) {
      if (part.state === 'sent') continue;
      if (part.state !== 'pending' || part.nextAttemptAt > Date.now()) return;
      try {
        this.policy.authorize(run.userId, run.guildId, run.channelId);
        await this.session(run.sessionId, run);
      } catch (error) {
        part.state = 'blocked'; part.lastError = errorCode(error); run.lastError = part.lastError; run.notification = 'none'; this.store.save(run); return;
      }
      // The durable uncertainty fence is committed before ANY send. A crash
      // after Discord success but before message ID persistence holds the tail.
      part.state = 'sending'; part.attempts++; run.notifyAttempts++; run.notification = 'unknown'; run.lastError = 'NOTIFICATION_UNKNOWN'; this.store.save(run);
      let receipt;
      try { receipt = await notify(run, { index: part.index, content: plan.parts[part.index - 1]!.content }); }
      catch (error) {
        const code = errorCode(error); part.lastError = code; run.lastError = code;
        if (code === 'DELIVERY_RATE_LIMIT') {
          const retryAfterMs = error && typeof error === 'object' && 'retryAfterMs' in error ? Number(error.retryAfterMs) : NaN;
          if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
            part.state = 'pending'; part.nextAttemptAt = Date.now() + Math.max(1, retryAfterMs); run.nextNotifyAt = part.nextAttemptAt; run.notification = 'pending';
          } else { part.state = 'unknown'; run.notification = 'unknown'; }
        } else if (['DELIVERY_BLOCKED', 'DM_FAILED', 'NOT_AUTHORIZED', 'CWD_NOT_ALLOWED'].includes(code)) {
          part.state = 'blocked'; run.notification = 'none';
        } else { part.state = 'unknown'; run.notification = 'unknown'; }
        this.store.save(run); return;
      }
      if (!receipt || !receipt.messageId) { part.state = 'unknown'; part.lastError = 'MESSAGE_ID_UNAVAILABLE'; run.notification = 'unknown'; this.store.save(run); return; }
      part.state = 'sent'; part.messageId = receipt.messageId; part.lastError = ''; run.lastError = '';
      run.notification = delivery.parts.every(p => p.state === 'sent') ? 'sent' : 'pending'; run.nextNotifyAt = 0;
      // If this write fails, do not catch/rewrite the pre-send fence. On restart
      // sending becomes unknown, and even this process must not send the tail.
      this.store.save(run);
    }
    if (this.protectedOutputRequired && delivery.complete && run.notification === 'sent' && delivery.parts.length > 0
      && delivery.parts.every(part => part.state === 'sent' && !!part.messageId) && run.protectedOutput?.state === 'published' && run.bodyResolvedAt === undefined) {
      const resolvedAt = Date.now(); this.store.resolveProtectedOutput(run, resolvedAt, resolvedAt + PROTECTED_OUTPUT_RETENTION_MS); this.maybeClearProtectedOutputFault();
    }
  }
  private async deliverWorkingNotice(run: Run, notify: NotifyWorking): Promise<void> {
    if (run.workNotice !== 'ready') return;
    if (terminal(run.state) || run.contaminated) { run.workNotice = 'suppressed'; run.workNoticeError = ''; this.store.save(run); return; }
    if (!this.store.metadataOnly || run.guildId === 'telegram' || !run.notificationPreferences) {
      run.workNotice = 'blocked'; run.workNoticeError = 'WORK_NOTICE_NOT_PINNED'; this.store.save(run); return;
    }
    try {
      this.policy.authorize(run.userId, run.guildId, run.channelId);
      await this.session(run.sessionId, run);
    } catch (error) {
      run.workNotice = 'blocked'; run.workNoticeError = errorCode(error); this.store.save(run); return;
    }
    // Persist the no-replay fence before Discord may accept the notice. A crash
    // after send but before receipt persistence remains unknown and is never resent.
    run.workNotice = 'unknown'; run.workNoticeAttempts = (run.workNoticeAttempts ?? 0) + 1; run.workNoticeError = 'WORK_NOTICE_UNKNOWN';
    run.updatedAt = Date.now(); this.store.save(run);
    try {
      const receipt = await notify(run);
      if (!receipt || typeof receipt.messageId !== 'string' || !receipt.messageId) {
        run.workNotice = 'unknown'; run.workNoticeError = 'MESSAGE_ID_UNAVAILABLE';
      } else {
        run.workNotice = 'sent'; run.workNoticeMessageId = receipt.messageId; run.workNoticeError = '';
      }
    } catch (error) {
      const code = errorCode(error); run.workNoticeError = code;
      if (['DELIVERY_BLOCKED', 'NOT_AUTHORIZED', 'CWD_NOT_ALLOWED'].includes(code)) run.workNotice = 'blocked';
      // All other outcomes remain unknown. There is no automatic start-notice replay.
    }
    run.updatedAt = Date.now(); this.store.save(run);
  }
  private async retireProtectedRun(run: Run, now: number): Promise<void> {
    if (!this.protectedPayloadStore || run.protectedOutput?.state !== 'retiring') throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除状態を確認できません。');
    const already = new Set(run.protectedOutput.deletedRefs), pending = run.protectedOutput.items.filter(item => !already.has(item.ref));
    if (!pending.length) { this.store.recordProtectedDeletes(run.id, [], now); return; }
    const results = await this.protectedPayloadStore.deleteMany(pending.map(item => item.ref));
    if (results.length !== pending.length) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力削除の応答数が一致しません。');
    const byRef = new Map(pending.map(item => [item.ref, item])); const seen = new Set<string>();
    for (const result of results) {
      const item = byRef.get(result.ref);
      if (!item || seen.has(result.ref) || !Number.isSafeInteger(result.bytes) || result.bytes < 0
        || result.deleted && result.bytes !== item.cipherBytes || !result.deleted && result.bytes !== 0) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力の削除応答を検証できません。');
      seen.add(result.ref);
    }
    if (seen.size !== pending.length) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力削除に不明な参照があります。');
    this.store.recordProtectedDeletes(run.id, pending.map(item => item.ref), now);
  }
  private async reconcileProtectedOutputs(): Promise<void> {
    if (!this.protectedOutputRequired || !this.protectedPayloadStore) return;
    await this.withProtectedOutputLock(async () => {
      this.store.verifyProtectedCapacity(await this.protectedPayloadStore!.stats());
      const now = Date.now();
      for (const candidate of this.store.allRuns()) {
        const output = candidate.protectedOutput;
        if (!output) continue;
        if (output.state === 'published' && output.resolvedAt === undefined && candidate.delivery?.complete && candidate.notification === 'sent'
          && candidate.delivery.parts.length > 0 && candidate.delivery.parts.every(part => part.state === 'sent' && !!part.messageId)) {
          // Durable per-part message receipts are the resolution fence. No Native
          // history/session lookup is needed to retain an already-delivered body.
          this.store.resolveProtectedOutput(candidate, now, now + PROTECTED_OUTPUT_RETENTION_MS);
        }
        const current = this.store.get(candidate.id);
        if (!current?.protectedOutput) throw new AppError('PROTECTED_OUTPUT_CONFLICT', '保護出力Runを復元できません。');
        if (current.protectedOutput.state === 'published' && current.protectedOutput.expiresAt !== undefined && current.protectedOutput.expiresAt <= now) {
          const retiring = this.store.beginProtectedRetirement(current.id, now);
          if (retiring) await this.retireProtectedRun(retiring, now);
        } else if (current.protectedOutput.state === 'retiring') await this.retireProtectedRun(current, now);
      }
      this.store.verifyProtectedCapacity(await this.protectedPayloadStore!.stats());
    });
    this.maybeClearProtectedOutputFault();
  }
  async tick(notify: Notify, notifyWorking?: NotifyWorking): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.protectedOutputRequired) {
        try { await this.checkProtectedCapacity(); await this.reconcileProtectedOutputs(); this.maybeClearProtectedOutputFault(); }
        catch (error) { this.blockProtectedOutput(errorCode(error)); /* Persisted fault keeps admission/publication fenced. */ }
      }
      const verifiedWorkingRuns = new Set<string>();
      for (const stored of this.store.active()) {
        if (stored.state === 'dispatching') continue; // An in-flight submit owns this row until it settles.
        const run = structuredClone(stored);
        try {
          await this.session(run.sessionId, run); // Recheck cwd before every disclosure, including after restart.
          await this.restoreBody(run);
          const snapshot = await this.adapter.snapshot(run.sessionId);
          const events = await this.adapter.events(run.sessionId, snapshot.cursor, run.lastSeq);
          this.consume(run, events); run.updatedAt = Date.now();
          if (terminal(run.state) && run.requiresProtectedOutput) {
            await this.ensureProtectedOutput(run, 'native-turn'); this.maybeClearProtectedOutputFault();
          } else this.store.save(run);
          if (run.workNotice === 'ready' && run.workStartedSeq !== undefined && run.startStep !== undefined && run.startStep.seq < run.workStartedSeq) verifiedWorkingRuns.add(run.id);
        } catch (error) {
          // A post-commit capacity failure must never overwrite the terminal row
          // with this loop's stale pre-commit active snapshot.
          const latest = this.store.get(run.id);
          if (run.requiresProtectedOutput && latest?.protectedOutput?.state === 'published' && terminal(latest.state)) {
            this.blockProtectedOutput(errorCode(error)); continue;
          }
          // No partial cursor or output commit on a failed read. Do NOT infer success from idle.
          stored.lastError = errorCode(error); stored.updatedAt = Date.now(); this.store.save(stored);
        }
      }
      for (const run of this.store.pendingWorkingNotices()) {
        if (terminal(run.state) || run.contaminated) { run.workNotice = 'suppressed'; run.workNoticeError = ''; this.store.save(run); continue; }
        // Ready markers may survive restart, but delivery is gated on a fresh
        // complete, digest-checked Native observation in this tick.
        if (!verifiedWorkingRuns.has(run.id)) continue;
        if (notifyWorking) await this.deliverWorkingNotice(run, notifyWorking);
      }
      for (const run of this.store.pendingNotifications()) {
        if (this.protectedOutputRequired && this.protectedOutputFault && run.requiresProtectedOutput) continue;
        if (this.store.metadataOnly && run.guildId !== 'telegram') {
          if (!run.delivery) {
            // No digest on a legacy terminal row means no trustworthy baseline.
            if (!run.bodyDigest) { run.lastError = 'BODY_UNAVAILABLE'; run.notification = 'none'; this.store.save(run); continue; }
            try { await this.restoreBody(run); this.planDelivery(run); this.store.save(run); }
            catch (error) { run.lastError = errorCode(error); run.notification = 'none'; this.store.save(run); continue; }
          }
          if (run.delivery) await this.deliverParts(run, notify);
          continue;
        }
        if (!this.policy.stillAuthorized(run.userId, run.guildId, run.channelId)) continue;
        let notificationAttempted = false;
        try {
          await this.session(run.sessionId, run); await this.restoreBody(run);
          if (this.store.metadataOnly) {
            // Fence uncertain delivery BEFORE the network call. A crash must never
            // leave an attempted notification eligible for automatic replay.
            run.notifyAttempts++; run.notification = 'unknown'; run.lastError = 'NOTIFICATION_UNKNOWN';
            run.updatedAt = Date.now(); this.store.save(run);
          }
          notificationAttempted = true;
          await notify(run);
          run.notification = 'sent'; run.lastError = '';
        } catch (error) {
          if (!this.store.metadataOnly || !notificationAttempted) run.notifyAttempts++;
          run.lastError = errorCode(error);
          if (this.store.metadataOnly) {
            if (notificationAttempted) run.notification = run.lastError === 'DM_FAILED' && run.notifyAttempts < 8 ? 'pending' : 'unknown';
          }
          run.nextNotifyAt = Date.now() + Math.min(3600000, 10000 * 2 ** Math.min(run.notifyAttempts, 9));
        }
        this.store.save(run);
      }
    } finally { this.ticking = false; }
  }
}
