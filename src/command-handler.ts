import { AttachmentBuilder, escapeMarkdown, type ChatInputCommandInteraction } from 'discord.js';
import type { Config } from './config.js';
import { Engine, type Actor } from './engine.js';
import { AppError, errorCode } from './errors.js';
import type { Run, RunState, SessionInfo } from './types.js';
import { terminal } from './types.js';
import { HELP } from './commands.js';
import { normalize, resolve } from 'node:path';

export interface AgentCommandResponse { content: string; files?: AttachmentBuilder[] }

const STATE_LABELS: Record<RunState, string> = {
  dispatching: '送信中', accepted: 'DSH受付済み（完了ではありません）', running: '実行中',
  unknown: '送信結果不明・照合中（再送禁止）', succeeded: '完了', failed: '失敗', interrupted: '中断'
};
const ACTIVE_STATES = new Set<RunState>(['dispatching', 'accepted', 'running', 'unknown']);
const KNOWN_STATES = new Set<RunState>(['dispatching', 'accepted', 'running', 'unknown', 'succeeded', 'failed', 'interrupted']);
const LIST_REPLY_BODY_BUDGET = 1450;
const LIST_PAGE_SIZE = 5;

function actorFor(interaction: ChatInputCommandInteraction, engine: Engine): Actor {
  if (interaction.user.bot) throw new AppError('NOT_AUTHORIZED', 'Bot利用者からの操作は受け付けません。');
  if (!interaction.guildId || !interaction.channelId) throw new AppError('NOT_AUTHORIZED', '許可されたサーバーチャンネルから操作してください。');
  const actor: Actor = { userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId };
  engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
  return actor;
}

function pageBounds(page: number, length: number, size = LIST_PAGE_SIZE): { page: number; pages: number; rows: number[] } {
  const pages = Math.max(1, Math.ceil(length / size));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new AppError('PAGE_INVALID', `ページは1〜${pages}で指定してください。`);
  const start = (page - 1) * size;
  return { page, pages, rows: Array.from({ length: Math.min(size, Math.max(0, length - start)) }, (_, i) => start + i) };
}

function boundedPageLines(page: number, lines: string[], maxPageSize = LIST_PAGE_SIZE): { page: number; pages: number; lines: string[] } {
  const maxLine = Math.max(1, ...lines.map(line => line.length));
  if (maxLine > LIST_REPLY_BODY_BUDGET) throw new AppError('OUTPUT_TOO_LARGE', 'このNative IDはDiscord応答に安全に収まらないため省略せず表示を拒否しました。DSH GUIで確認してください。');
  const size = Math.max(1, Math.min(maxPageSize, Math.floor(LIST_REPLY_BODY_BUDGET / maxLine)));
  const bounds = pageBounds(page, lines.length, size);
  return { page: bounds.page, pages: bounds.pages, lines: bounds.rows.map(index => lines[index]!) };
}

function safeTitle(engine: Engine, title: string, maxPoints = 80): string {
  const safe = engine.redactText(title).replace(/[\r\n\t]/gu, ' ');
  const points = Array.from(safe);
  const clipped = points.length > maxPoints ? `${points.slice(0, maxPoints).join('')}…` : safe;
  return escapeMarkdown(clipped);
}

function safeId(engine: Engine, value: string): string {
  const safe = engine.redactText(value).replace(/[\r\n\t]/gu, ' ');
  if (Array.from(safe).length > 200) throw new AppError('IDENTIFIER_TOO_LONG', 'Native IDがDiscord入力上限を超えるため、切り詰めず表示を拒否しました。DSH GUIで確認してください。');
  return escapeMarkdown(safe);
}

function dateLabel(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '不明';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '不明' : date.toISOString();
}

function durationLabel(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return '不明';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

function workspaceKey(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function workspaceAlias(config: Config, session: SessionInfo): string {
  if (!session.cwd) return '不明';
  try {
    const key = workspaceKey(session.cwd);
    return Object.keys(config.workspaces).sort().find(alias => workspaceKey(config.workspaces[alias]!) === key) ?? '許可済み（alias未確定）';
  } catch { return '許可済み（alias未確定）'; }
}

function notificationLabel(run: Run): string {
  if (run.delivery?.parts.some(part => part.state === 'blocked')) return '配信blocked（権限／配送先を要確認）';
  if (run.delivery && !run.delivery.complete) return '全文未完了（自動配信上限）';
  return ({ none: '未予約', pending: '未送信／再試行待ち', sent: '送信済み', unknown: '配送不明（自動再送しない）' } as const)[run.notification];
}

function notificationScope(engine: Engine, actor: Actor): string {
  const sessionId = engine.binding(actor);
  return `確認scope — 本人User ${safeId(engine, actor.userId)} / Guild ${safeId(engine, actor.guildId)} / Channel ${safeId(engine, actor.channelId)} / Binding ${safeId(engine, sessionId ?? 'なし')} / version ${engine.bindingVersion(actor)}`;
}

function safeErrorLabel(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,47}$/u.test(value) ? value : 'UNKNOWN';
}

function unsupportedCreateOption(options: unknown): string | undefined {
  const forbidden = new Set(['title', 'model', 'effort']);
  const scan = (items: unknown): string | undefined => {
    if (!Array.isArray(items)) return undefined;
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const option = item as { name?: unknown; value?: unknown; options?: unknown };
      if (typeof option.name === 'string' && forbidden.has(option.name) && option.value !== undefined && option.value !== null) return option.name;
      const nested = scan(option.options);
      if (nested) return nested;
    }
    return undefined;
  };
  return scan(options);
}

function runSummary(engine: Engine, run: Run, now = Date.now()): string {
  const completedAt = terminal(run.state) ? run.updatedAt : now;
  const delivery = run.delivery;
  const deliverySummary = delivery
    ? `\n通知先: ${delivery.destination === 'dm' ? '本人DM' : '受付元サーバーチャンネル'}\n通知part: ${delivery.parts.filter(part => part.state === 'sent').length}/${delivery.parts.length}送信済み${delivery.parts.some(part => part.state === 'unknown') ? '・配送不明あり' : ''}${delivery.complete ? '' : '・自動配信上限超過あり'}`
    : '';
  return `Run ID: ${safeId(engine, run.id)}\nSession ID: ${safeId(engine, run.sessionId)}\n状態: ${STATE_LABELS[run.state]}\n経過: ${durationLabel(completedAt - run.createdAt)}\n最終観測: ${dateLabel(run.updatedAt)}\n承認待ち: 不明（現行Native契約では取得不可。DSH GUIで確認）\n通知: ${notificationLabel(run)}${deliverySummary}${run.lastError ? `\n最後の安全なエラー: ${safeErrorLabel(run.lastError)}` : ''}`;
}

function stateLabel(state: RunState): string { return STATE_LABELS[state]; }

async function currentSession(engine: Engine, actor: Actor): Promise<{ sessionId?: string; session?: SessionInfo; bindingVersion?: number; content?: string }> {
  const firstBinding = engine.binding(actor);
  const bindingVersion = engine.bindingVersion(actor);
  if (!firstBinding) return { content: '選択中のSessionはありません。/agent sessionsで確認して/agent bind session:<id>を実行してください。' };
  const sessions = await engine.sessions(actor);
  engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
  if (engine.binding(actor) !== firstBinding || engine.bindingVersion(actor) !== bindingVersion) throw new AppError('BINDING_CONFLICT', 'Session選択が変更されました。もう一度実行してください。');
  const session = sessions.find(item => item.sessionId === firstBinding);
  if (!session) return { content: '保存された選択先は現在の許可Session一覧で確認できません。IDやタイトルは開示しません。/agent sessionsで確認してください。' };
  return { sessionId: firstBinding, session, bindingVersion };
}

async function revalidateCurrentSession(engine: Engine, actor: Actor, sessionId: string, bindingVersion: number): Promise<SessionInfo> {
  engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
  if (engine.binding(actor) !== sessionId || engine.bindingVersion(actor) !== bindingVersion) throw new AppError('BINDING_CONFLICT', 'Session選択が変更されました。もう一度実行してください。');
  const session = (await engine.sessions(actor)).find(item => item.sessionId === sessionId);
  engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
  if (engine.binding(actor) !== sessionId || engine.bindingVersion(actor) !== bindingVersion) throw new AppError('BINDING_CONFLICT', 'Session選択が変更されました。もう一度実行してください。');
  if (!session) throw new AppError('SESSION_NOT_FOUND', '選択Sessionは現在の許可一覧で確認できません。もう一度選択してください。');
  return session;
}

function helpFor(topic: string | null): string {
  const normalized = topic?.trim().toLocaleLowerCase('en-US');
  if (!normalized) return HELP;
  const unavailable: Record<string, string> = {
    model: 'model未対応: 現行Native Session契約にprovider/model catalog・Session設定read/write・再読込適用確認がありません。設定変更を実行するコマンドは登録していません。',
    models: 'models未対応: APIキーを隠した利用可能model一覧を取得する正式Native catalogがありません。',
    reasoning: 'reasoning未対応: provider/model別の正式なeffort metadataとSession設定read/writeがありません。固定候補を当てはめません。',
    settings: 'settings未対応: Session設定の読込・CAS付き変更・readback適用確認契約がありません。title変更やresetも行いません。',
    context: 'context未対応: Nativeのcontext使用量・上限・Run token/cost usage契約がありません。推測値を実測として表示しません。',
    dm: 'DM-onlyは設計・実証待ちです。コマンド登録はserver-onlyで、DM slash/通常メッセージは受け付けません。完了通知DMはDM操作の根拠ではありません。',
    stop: 'stop未対応: 特定Run停止の正式Native契約がありません。Session全体cancelで代用しません。DSH GUIを利用してください。',
    approval: 'approval未対応: 対象・期限・競合を検査するNative承認契約がありません。DSH GUIを利用してください。',
    queue: 'queue未対応: Native queue/未開始取消契約がありません。',
    files: 'files未対応: 認可・パス・内容検査付きArtifact契約がありません。',
    chat: '通常メッセージは指示として扱いません。明示chat enableの契約もなく、過去メッセージの実行もしません。'
  };
  if (normalized === 'history') return 'history未対応・未登録: 現行Native page契約にevent type/fieldを限定する正式filterがなく、reasoning/secretsを取得しない保証がありません。raw pageを取得してcommand側で後から絞る代替は行いません。結果は/agent resultで確認してください。';
  if (normalized === 'notifications' || normalized === 'notification') return 'notifications showは宛先・本人/Guild/Channel/Binding scope・pending/unknown/sending/blocked/incomplete/未送信part件数を表示します。進捗通知は未対応で最終回答のみです。setは今後のRunだけに適用され、originには選択Bindingのある現在scopeへの明示確認が必要です。retryは通知だけが対象で、Native promptを再送しません。';
  return unavailable[normalized] ?? HELP;
}

export async function handleAgentCommand(
  interaction: ChatInputCommandInteraction,
  engine: Engine,
  config: Config,
  textOnly: boolean
): Promise<{ content: string; files?: AttachmentBuilder[] }> {
  // The Bot also authorizes before deferReply; repeat authorization at the operation boundary.
  const actor = actorFor(interaction, engine);
  if (interaction.commandName !== 'agent') throw new AppError('UNKNOWN_COMMAND', '未対応コマンドです。');
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);
  if (sub === 'history') throw new AppError('HISTORY_UNAVAILABLE', '履歴は未登録です。Native field-filtered history契約がないため、private event dataを取得する代替は行いません。');
  if (sub === 'new') {
    const unsupported = unsupportedCreateOption(interaction.options.data);
    if (unsupported) throw new AppError('CREATE_OPTION_UNSUPPORTED', `${unsupported}指定は未対応です。Native create設定契約がないためSessionは作成していません。`);
  }

  if (group === 'notifications') {
    if (sub === 'show') {
      const preferences = engine.notificationPreferences(actor);
      return { content: `現在の通知先: ${preferences.destination === 'dm' ? '本人DM' : '許可サーバーの元チャンネル'}\n${notificationScope(engine, actor)}\n進捗通知: 未対応（最終回答のみ）\n未送信／再試行待ち: ${preferences.pending}\n配送不明／sending: ${preferences.unknown}\nblocked: ${preferences.blocked}\n自動配信未完了（上限）: ${preferences.incomplete}\n未送信part数: ${preferences.undeliveredParts}\n変更は今後のRunだけに適用されます。既存Runの配送先は固定済みです。` };
    }
    if (sub === 'set') {
      const destination = interaction.options.getString('destination', true);
      if (destination !== 'dm' && destination !== 'origin') throw new AppError('PREFERENCE_INVALID', '通知先はdmまたはoriginで指定してください。');
      const confirmOrigin = interaction.options.getBoolean('confirm-origin') === true;
      if (destination === 'origin' && !confirmOrigin) throw new AppError('CONFIRMATION_REQUIRED', '元のサーバーチャンネルへ公開することをconfirm-origin:trueで確認してください。');
      const confirmedBinding = engine.binding(actor);
      const confirmedVersion = engine.bindingVersion(actor);
      if (destination === 'origin' && !confirmedBinding) throw new AppError('NOT_BOUND', '元チャンネルへの公開を確認する前に、この操作元で許可Sessionを選択してください。');
      engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
      engine.setNotificationPreferences(actor, { destination }, confirmOrigin);
      engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
      if (engine.binding(actor) !== confirmedBinding || engine.bindingVersion(actor) !== confirmedVersion) throw new AppError('BINDING_CONFLICT', '通知設定中にBindingが変更されました。設定を再確認してください。');
      const updated = engine.notificationPreferences(actor);
      return { content: `今後のRunの通知先を${updated.destination === 'dm' ? '本人DM' : '許可サーバーの元チャンネル'}に設定しました。\n${notificationScope(engine, actor)}\n確認scopeは本人/Guild/Channelと表示中のBindingです。通知設定はactor+channel単位で今後のRunに適用され、既存Runの通知先は変更していません。\n進捗通知は未対応です（最終回答のみ）。` };
    }
    if (sub === 'retry') {
      const id = interaction.options.getString('delivery', true);
      const part = interaction.options.getInteger('part');
      const confirmDuplicateRisk = interaction.options.getBoolean('confirm-duplicate-risk') === true;
      await engine.retryNotification(actor, id, part ?? undefined, confirmDuplicateRisk);
      return { content: `Run/delivery ${safeId(engine, id)}の通知再試行を受け付けました。Native promptは再実行していません。` };
    }
    throw new AppError('UNKNOWN_COMMAND', '未対応のnotifications操作です。');
  }

  switch (sub) {
    case 'help':
      return { content: helpFor(interaction.options.getString('topic')) };
    case 'current': {
      const selected = await currentSession(engine, actor);
      if (!selected.session || !selected.sessionId || selected.bindingVersion === undefined) return { content: selected.content! };
      const { sessionId, bindingVersion } = selected;
      let session = selected.session;
      let busy: string;
      try {
        const snapshot = await engine.adapter.snapshot(sessionId);
        const inbox = snapshot.values.inbox && typeof snapshot.values.inbox === 'object' && !Array.isArray(snapshot.values.inbox)
          ? snapshot.values.inbox as Record<string, unknown> : {};
        const queued = ['next-turn', 'next-step'].some(key => Array.isArray(inbox[key]) && (inbox[key] as unknown[]).length > 0);
        const tracked = engine.store.allRuns().some(run => run.sessionId === sessionId && ACTIVE_STATES.has(run.state));
        busy = session.running || queued || tracked ? '実行中／処理待ちあり' : '待機中（Native snapshot時点）';
      } catch {
        busy = session.running ? '実行中（list応答）・queue状態は不明' : '不明（snapshot取得不可）';
      }
      session = await revalidateCurrentSession(engine, actor, sessionId, bindingVersion);
      const preferences = engine.notificationPreferences(actor);
      return { content: `Agent: DSH\nSession ID: ${safeId(engine, sessionId)}\nタイトル: ${safeTitle(engine, session.title)}\nWorkspace: ${safeTitle(engine, workspaceAlias(config, session), 80)}\nModel: 不明（Native Session契約未公開）\nReasoning: 不明（model別metadata未公開）\nBusy: ${busy}\nBinding version: ${bindingVersion}\n通知先: ${preferences.destination === 'dm' ? '本人DM' : '許可サーバーの元チャンネル'}\n進捗通知: 未対応（最終回答のみ）` };
    }
    case 'workspace-add': {
      if (!engine.registerWorkspace) throw new AppError('WORKSPACE_SETUP_UNAVAILABLE', 'このHostはDiscordからの作業フォルダー登録に対応していません。');
      if (interaction.options.getBoolean('confirm-access') !== true) throw new AppError('CONFIRMATION_REQUIRED', 'このフォルダーへの作業アクセス追加を confirm-access:true で明示確認してください。');
      const alias = interaction.options.getString('alias', true);
      await engine.registerWorkspace(actor, alias, interaction.options.getString('path', true), interaction.options.getBoolean('confirm-access') === true);
      engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
      return { content: `作業フォルダー ${safeTitle(engine, alias, 40)}を許可・保存しました。パスは表示しません。\n/agent new workspace:<別名> で新規作成、または /agent sessions → /agent bind session:<ID> で選択してください。\n既存Run・選択Sessionは変更していません。設定版の更新により今後の自動起動は解除されます。必要ならGUIで再確認してください。フォルダー許可はOS sandboxではありません。` };
    }
    case 'workspaces': {
      const aliases = Object.keys(config.workspaces).filter(alias => {
        try { engine.policy.workspace(alias, actor.guildId); return true; } catch { return false; }
      }).sort((a, b) => a.localeCompare(b));
      const bounds = pageBounds(interaction.options.getInteger('page') ?? 1, aliases.length, 20);
      const lines = bounds.rows.map(index => `• ${safeTitle(engine, aliases[index]!, 40)}`);
      return { content: `許可Workspace alias ${bounds.page}/${bounds.pages}（${aliases.length}件）\n${lines.join('\n') || '許可Workspaceはありません。'}\nローカルパスは表示しません。` };
    }
    case 'sessions': {
      const query = (interaction.options.getString('query') ?? '').trim().toLocaleLowerCase('en-US');
      const sessions = (await engine.sessions(actor)).filter(session => !query || session.sessionId.toLocaleLowerCase('en-US').includes(query) || engine.redactText(session.title).toLocaleLowerCase('en-US').includes(query));
      const sessionLines = sessions.map(session => `• ${safeId(engine, session.sessionId)} | ${session.running ? '実行中' : '待機'} | ${safeTitle(engine, session.title, 64)}`);
      const bounds = boundedPageLines(interaction.options.getInteger('page') ?? 1, sessionLines);
      return { content: `許可Session ${bounds.page}/${bounds.pages}（${sessions.length}件）\n${bounds.lines.join('\n') || '一致する許可Sessionはありません。'}\n/agent bind session:<完全なSession ID>で選択` };
    }
    case 'new': {
      const alias = interaction.options.getString('workspace', true);
      const id = await engine.create(actor, alias);
      return { content: `Workspace ${safeTitle(engine, alias)}に新規Sessionを作成・選択しました。\nSession ID: ${safeId(engine, id)}\nmodel/title/effortは指定・変更していません。` };
    }
    case 'bind': {
      const id = interaction.options.getString('session', true);
      await engine.bind(actor, id);
      return { content: `許可Sessionを選択しました: ${safeId(engine, id)}\nBinding version: ${engine.bindingVersion(actor)}` };
    }
    case 'unbind':
      engine.unbind(actor);
      return { content: '選択だけを解除しました。既存Run・Native Session・通知先は削除／停止していません。' };
    case 'prompt': {
      const run = await engine.submit(actor, interaction.id, interaction.options.getString('text', true));
      return { content: `${runSummary(engine, run)}\n/agent result run:${safeId(engine, run.id)} page:1で本文を確認できます。` };
    }
    case 'status': {
      const id = interaction.options.getString('run') ?? undefined;
      const run = await engine.status(actor, id, true, false);
      if (!run) return { content: `この操作元のRun履歴はありません。\n選択Session: ${safeId(engine, engine.binding(actor) ?? 'なし')}` };
      return { content: runSummary(engine, run) };
    }
    case 'tasks': {
      const requestedState = interaction.options.getString('state');
      if (requestedState !== null && !KNOWN_STATES.has(requestedState as RunState)) throw new AppError('PAGE_INVALID', 'Run状態の選択肢が不正です。');
      const allowedSessionIds = new Set((await engine.sessions(actor)).map(session => session.sessionId));
      const runs = engine.store.allRuns().filter(run => run.userId === actor.userId && run.guildId === actor.guildId && run.channelId === actor.channelId && allowedSessionIds.has(run.sessionId) && (!requestedState || run.state === requestedState))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const taskLines = runs.map(run => `• ${safeId(engine, run.id)} | ${stateLabel(run.state)} | Session ${safeId(engine, run.sessionId)} | 通知 ${notificationLabel(run)}`);
      const bounds = boundedPageLines(interaction.options.getInteger('page') ?? 1, taskLines);
      return { content: `自分の許可SessionのRun ${bounds.page}/${bounds.pages}（${runs.length}件）\n${bounds.lines.join('\n') || '表示できるRunはありません。'}\n/agent status run:<Run ID>で状態を確認` };
    }
    case 'result': {
      const runId = interaction.options.getString('run') ?? undefined;
      const page = interaction.options.getInteger('page') ?? 1;
      const result = await engine.resultPage(actor, runId, page);
      return { content: result.content };
    }
    case 'notify': {
      const id = interaction.options.getString('run', true);
      await engine.retryNotification(actor, id);
      return { content: `Run ${safeId(engine, id)}の通知再試行を受け付けました。Native promptは再実行していません。` };
    }
    case 'diagnose': {
      let connectivity: string;
      let allowedSessions = 0;
      try {
        allowedSessions = (await engine.sessions(actor)).length;
        connectivity = `DSH Session list read: 成功（許可Session ${allowedSessions}件）`;
      } catch (error) { connectivity = `DSH Session list read: 失敗（${safeErrorLabel(errorCode(error))}）`; }
      const adapter = engine.adapter;
      const capabilities = [
        ['list', typeof adapter.list === 'function'], ['create', typeof adapter.create === 'function'],
        ['snapshot/projections', typeof adapter.snapshot === 'function'],
        ['prompt', typeof adapter.prompt === 'function']
      ].map(([name, available]) => `${name}: ${available ? 'adapter method available' : 'unavailable'}`);
      const preferences = engine.notificationPreferences(actor);
      const lastRunError = engine.store.allRuns()
        .filter(run => run.userId === actor.userId && run.guildId === actor.guildId && run.channelId === actor.channelId && run.lastError)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.lastError;
      return { content: `接続診断（server-only / authorized）\n${connectivity}\nAdapter mapping:\n${capabilities.join('\n')}\nNative version: 不明（Adapterの公開契約なし）\nHistory: unavailable（official field-filtered Native contract unverified）\nModel/settings/reasoning/context: 未対応（正式Native契約なし）\n通知滞留: ${preferences.pending} pending / ${preferences.unknown} unknown/sending / ${preferences.blocked} blocked / ${preferences.incomplete} incomplete / ${preferences.undeliveredParts} 未送信part\n最後の安全なエラーコード: ${lastRunError ? safeErrorLabel(lastRunError) : '記録なし'}\nToken・ローカルパス・raw errorは表示しません。` };
    }
    default:
      throw new AppError('UNKNOWN_COMMAND', '未対応コマンドです。/agent helpで使用可能な操作を確認してください.');
  }
}
