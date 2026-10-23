import { escapeMarkdown } from 'discord.js';
import { AppError, errorCode } from './errors.js';
import { terminal } from './types.js';
import { HELP } from './commands.js';
import { normalize, resolve } from 'node:path';
const STATE_LABELS = {
    dispatching: '送信中', accepted: 'DSH受付済み（完了ではありません）', running: '実行中',
    unknown: '送信結果不明・照合中（再送禁止）', succeeded: '完了', failed: '失敗', interrupted: '中断'
};
const ACTIVE_STATES = new Set(['dispatching', 'accepted', 'running', 'unknown']);
const KNOWN_STATES = new Set(['dispatching', 'accepted', 'running', 'unknown', 'succeeded', 'failed', 'interrupted']);
const LIST_REPLY_BODY_BUDGET = 1450;
const LIST_PAGE_SIZE = 5;
function actorFor(interaction, engine) {
    if (interaction.user.bot)
        throw new AppError('NOT_AUTHORIZED', 'Bot利用者からの操作は受け付けません。');
    if (!interaction.guildId || !interaction.channelId)
        throw new AppError('NOT_AUTHORIZED', '許可されたサーバーチャンネルから操作してください。');
    const actor = { userId: interaction.user.id, guildId: interaction.guildId, channelId: interaction.channelId };
    engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    return actor;
}
function pageBounds(page, length, size = LIST_PAGE_SIZE) {
    const pages = Math.max(1, Math.ceil(length / size));
    if (!Number.isSafeInteger(page) || page < 1 || page > pages)
        throw new AppError('PAGE_INVALID', `ページは1〜${pages}で指定してください。`);
    const start = (page - 1) * size;
    return { page, pages, rows: Array.from({ length: Math.min(size, Math.max(0, length - start)) }, (_, i) => start + i) };
}
function boundedPageLines(page, lines, maxPageSize = LIST_PAGE_SIZE) {
    const maxLine = Math.max(1, ...lines.map(line => line.length));
    if (maxLine > LIST_REPLY_BODY_BUDGET)
        throw new AppError('OUTPUT_TOO_LARGE', 'このNative IDはDiscord応答に安全に収まらないため省略せず表示を拒否しました。DSH GUIで確認してください。');
    const size = Math.max(1, Math.min(maxPageSize, Math.floor(LIST_REPLY_BODY_BUDGET / maxLine)));
    const bounds = pageBounds(page, lines.length, size);
    return { page: bounds.page, pages: bounds.pages, lines: bounds.rows.map(index => lines[index]) };
}
function boundedRenderedPage(page, lines, render, maxLength = 1900) {
    if (!Number.isSafeInteger(page) || page < 1)
        throw new AppError('PAGE_INVALID', 'ページは1以上で指定してください。');
    for (let size = Math.min(LIST_PAGE_SIZE, Math.max(1, lines.length)); size >= 1; size--) {
        const pages = Math.max(1, Math.ceil(lines.length / size));
        if (page > pages)
            continue;
        const start = (page - 1) * size;
        const content = render(lines.slice(start, start + size), page, pages);
        // Discord counts UTF-16 code units; enforce against the complete escaped reply.
        if (content.length <= maxLength)
            return content;
    }
    if (page > Math.max(1, lines.length))
        throw new AppError('PAGE_INVALID', `ページは1〜${Math.max(1, lines.length)}で指定してください。`);
    throw new AppError('OUTPUT_TOO_LARGE', 'このNative catalogはDiscord応答に安全に収まらないため省略せず表示を拒否しました。');
}
function safeTitle(engine, title, maxPoints = 80) {
    const safe = engine.redactText(title).replace(/[\r\n\t]/gu, ' ');
    const points = Array.from(safe);
    const clipped = points.length > maxPoints ? `${points.slice(0, maxPoints).join('')}…` : safe;
    return escapeMarkdown(clipped);
}
function safeId(engine, value) {
    const safe = engine.redactText(value).replace(/[\r\n\t]/gu, ' ');
    if (Array.from(safe).length > 200)
        throw new AppError('IDENTIFIER_TOO_LONG', 'Native IDがDiscord入力上限を超えるため、切り詰めず表示を拒否しました。DSH GUIで確認してください。');
    return escapeMarkdown(safe);
}
function modelLabel(engine, model) {
    if (!model)
        return '未取得';
    const base = `${safeTitle(engine, model.provider, 64)}/${safeTitle(engine, model.model, 96)}`;
    return model.reasoningEffort ? `${base} (reasoning: ${safeTitle(engine, model.reasoningEffort, 48)})` : base;
}
function projectedModel(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const candidate = value;
    const valid = (item) => typeof item === 'string' && item.length > 0 && item.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(item);
    if (!valid(candidate.provider) || !valid(candidate.model)
        || candidate.reasoningEffort !== undefined && !valid(candidate.reasoningEffort))
        return undefined;
    return { provider: candidate.provider, model: candidate.model, ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }) };
}
function dateLabel(value) {
    if (!Number.isFinite(value) || value < 0)
        return '不明';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '不明' : date.toISOString();
}
function durationLabel(milliseconds) {
    if (!Number.isFinite(milliseconds))
        return '不明';
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60)
        return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}分${seconds % 60}秒`;
    return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}
function workspaceKey(path) {
    const normalized = normalize(resolve(path));
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
function workspaceAlias(config, session) {
    if (!session.cwd)
        return '不明';
    try {
        const key = workspaceKey(session.cwd);
        return Object.keys(config.workspaces).sort().find(alias => workspaceKey(config.workspaces[alias]) === key) ?? '許可済み（alias未確定）';
    }
    catch {
        return '許可済み（alias未確定）';
    }
}
function workNoticeLabel(run) {
    switch (run.workNotice) {
        case 'ready': return '開始確認済み・送信待ち';
        case 'sent': return '送信済み';
        case 'unknown': return '配送不明（自動再送しない）';
        case 'blocked': return `blocked${run.workNoticeError ? ` (${safeErrorLabel(run.workNoticeError)})` : ''}`;
        case 'suppressed': return '同一poll内完了/混在により抑制';
        default: return '未開始';
    }
}
function notificationLabel(run) {
    if (run.delivery?.parts.some(part => part.state === 'blocked'))
        return '配信blocked（権限／配送先を要確認）';
    if (run.delivery && !run.delivery.complete)
        return '全文未完了（自動配信上限）';
    return { none: '未予約', pending: '未送信／再試行待ち', sent: '送信済み', unknown: '配送不明（自動再送しない）' }[run.notification];
}
function notificationScope(engine, actor) {
    const sessionId = engine.binding(actor);
    return `確認scope — 本人User ${safeId(engine, actor.userId)} / Guild ${safeId(engine, actor.guildId)} / Channel ${safeId(engine, actor.channelId)} / Binding ${safeId(engine, sessionId ?? 'なし')} / version ${engine.bindingVersion(actor)}`;
}
function safeErrorLabel(value) {
    return /^[A-Z][A-Z0-9_]{0,47}$/u.test(value) ? value : 'UNKNOWN';
}
function unsupportedCreateOption(options) {
    const forbidden = new Set(['title', 'model', 'effort']);
    const scan = (items) => {
        if (!Array.isArray(items))
            return undefined;
        for (const item of items) {
            if (!item || typeof item !== 'object' || Array.isArray(item))
                continue;
            const option = item;
            if (typeof option.name === 'string' && forbidden.has(option.name) && option.value !== undefined && option.value !== null)
                return option.name;
            const nested = scan(option.options);
            if (nested)
                return nested;
        }
        return undefined;
    };
    return scan(options);
}
function runSummary(engine, run, now = Date.now()) {
    const completedAt = terminal(run.state) ? run.updatedAt : now;
    const delivery = run.delivery;
    const deliverySummary = delivery
        ? `\n通知先: ${delivery.destination === 'dm' ? '本人DM' : '受付元サーバーチャンネル'}\n通知part: ${delivery.parts.filter(part => part.state === 'sent').length}/${delivery.parts.length}送信済み${delivery.parts.some(part => part.state === 'unknown') ? '・配送不明あり' : ''}${delivery.complete ? '' : '・自動配信上限超過あり'}`
        : '';
    return `Run ID: ${safeId(engine, run.id)}\nSession ID: ${safeId(engine, run.sessionId)}\n状態: ${STATE_LABELS[run.state]}\n経過: ${durationLabel(completedAt - run.createdAt)}\n最終観測: ${dateLabel(run.updatedAt)}\n承認待ち: 不明（現行Native契約では取得不可。DSH GUIで確認）\n開始通知: ${workNoticeLabel(run)}\n通知: ${notificationLabel(run)}${deliverySummary}${run.lastError ? `\n最後の安全なエラー: ${safeErrorLabel(run.lastError)}` : ''}`;
}
function stateLabel(state) { return STATE_LABELS[state]; }
async function currentSession(engine, actor) {
    const firstBinding = engine.binding(actor);
    const bindingVersion = engine.bindingVersion(actor);
    if (!firstBinding)
        return { content: '選択中のSessionはありません。/agent sessionsで確認して/agent bind session:<id>を実行してください。' };
    const sessions = await engine.sessions(actor);
    engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    if (engine.binding(actor) !== firstBinding || engine.bindingVersion(actor) !== bindingVersion)
        throw new AppError('BINDING_CONFLICT', 'Session選択が変更されました。もう一度実行してください。');
    const session = sessions.find(item => item.sessionId === firstBinding);
    if (!session)
        return { content: '保存された選択先は現在の許可Session一覧で確認できません。IDやタイトルは開示しません。/agent sessionsで確認してください。' };
    return { sessionId: firstBinding, session, bindingVersion };
}
async function revalidateCurrentSession(engine, actor, sessionId, bindingVersion) {
    engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    if (engine.binding(actor) !== sessionId || engine.bindingVersion(actor) !== bindingVersion)
        throw new AppError('BINDING_CONFLICT', 'Session選択が変更されました。もう一度実行してください。');
    const session = (await engine.sessions(actor)).find(item => item.sessionId === sessionId);
    engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    if (engine.binding(actor) !== sessionId || engine.bindingVersion(actor) !== bindingVersion)
        throw new AppError('BINDING_CONFLICT', 'Session選択が変更されました。もう一度実行してください。');
    if (!session)
        throw new AppError('SESSION_NOT_FOUND', '選択Sessionは現在の許可一覧で確認できません。もう一度選択してください。');
    if (engine.adapter.verifySession) {
        await engine.adapter.verifySession(sessionId);
        const confirmed = (await engine.sessions(actor)).find(item => item.sessionId === sessionId);
        engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
        if (engine.binding(actor) !== sessionId || engine.bindingVersion(actor) !== bindingVersion)
            throw new AppError('BINDING_CONFLICT', 'Session選択が変更されました。もう一度実行してください。');
        if (!confirmed || confirmed.cwd !== session.cwd)
            throw new AppError('SESSION_CHANGED', 'Native Session/workspace identityが変わりました。操作を停止しました。');
        return confirmed;
    }
    return session;
}
function helpFor(topic) {
    const normalized = topic?.trim().toLocaleLowerCase('en-US');
    if (!normalized)
        return HELP;
    const unavailable = {
        model: 'model選択は未対応です。/agent modelsはread-only catalog、/agent currentは直近要求と次回設定を表示します。selectModelはHost既定も変更し、Session専用CAS/readbackがないため実行しません。',
        models: '利用可能model catalogは/agent modelsで検索できます。provider/modelとNativeが公開するmodel別reasoning effort候補だけを表示し、provider failure本文は表示しません。model選択は未対応です。',
        reasoning: 'reasoning effort候補は/agent modelsと/agent currentに表示します。effort変更は正式なSession専用read/write/CAS/readback適用確認がないため未対応です。',
        settings: '/agent settings title value:<title>（/agent rename alias）は待機Sessionのtitleだけ変更します。model/reasoning settings変更・resetはSession単位の安全なrevision/CAS/readback根拠がないため未対応です。',
        context: 'contextの実測値・上限・使用率は未対応です。/agent context compact confirm:trueは明示確認の上でNative commandを実行します。結果不明の場合は再送せずDSH GUIで確認してください。',
        compact: 'Native Compact commandを実行します。Session historyを変更する可能性があり、成功はsourceEventSeq付きNative command結果でのみ確定します。結果不明は再送せずDSH GUIで確認してください。',
        dm: 'DM-onlyは設計・実証待ちです。コマンド登録はserver-onlyで、DM slash/通常メッセージは受け付けません。完了通知DMはDM操作の根拠ではありません。',
        stop: 'stop未対応: 特定Run停止は未対応です。Native Session cancelはSession全体対象でRun/turn/CAS指定がありません。他のDesktop実行を止めない保証がないため代用しません。DSH GUIを利用してください。',
        approval: 'remote approvalは未対応です。Native ApprovalServiceは同一process内のrequest/decide pipelineですが、Discord actor/Run scope・期限・version/CASの契約を確認できません。DSH GUIを利用してください。',
        queue: 'bridge FIFO queue/cancelは未対応です。Native queueのpending MessageId編集APIはありますが、shared Desktopとのadmission・actor/Run所有・耐久FIFO/restart契約がありません。',
        files: '任意attachment/Artifact取得は未対応です。Native image attachment lookupは画像到達確認に限られ、認可・任意file downloadの証拠ではありません。',
        chat: '通常メッセージは指示として扱いません。明示chat enableの契約もなく、過去メッセージの実行もしません。'
    };
    if (normalized === 'history')
        return 'history未対応・未登録: 現行Native page契約にevent type/fieldを限定する正式filterがなく、reasoning/secretsを取得しない保証がありません。raw pageを取得してcommand側で後から絞る代替は行いません。結果は/agent resultで確認してください。';
    if (normalized === 'notifications' || normalized === 'notification')
        return 'notifications showは宛先・本人/Guild/Channel/Binding scope・pending/unknown/sending/blocked/incomplete/未送信part件数を表示します。進捗通知は未対応で最終回答のみです。setは今後のRunだけに適用され、originには選択Bindingのある現在scopeへの明示確認が必要です。retryは通知だけが対象で、Native promptを再送しません。';
    return unavailable[normalized] ?? HELP;
}
function compactResponse(state) {
    if (state === 'completed')
        return 'Native Compact commandの成功を記録しました（完了eventを確認済み）。内容の変化はDSH GUIで確認してください。';
    if (state === 'noop')
        return 'Native Compactをcanonical no-opとして記録しました。Session全体が不変という意味ではありません。';
    return 'Native Compactの結果は不明です。実行済みの可能性があります。再送せず、DSH GUIで状態を確認してください。';
}
export async function handleAgentCommand(interaction, engine, config, textOnly) {
    // The Bot also authorizes before deferReply; repeat authorization at the operation boundary.
    const actor = actorFor(interaction, engine);
    if (interaction.commandName !== 'agent')
        throw new AppError('UNKNOWN_COMMAND', '未対応コマンドです。');
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);
    if (sub === 'history')
        throw new AppError('HISTORY_UNAVAILABLE', '履歴は未登録です。Native field-filtered history契約がないため、private event dataを取得する代替は行いません。');
    if (sub === 'new') {
        const unsupported = unsupportedCreateOption(interaction.options.data);
        if (unsupported)
            throw new AppError('CREATE_OPTION_UNSUPPORTED', `${unsupported}指定は未対応です。Native create設定契約がないためSessionは作成していません。`);
    }
    if (group === 'notifications') {
        if (sub === 'show') {
            const preferences = engine.notificationPreferences(actor);
            return { content: `現在の通知先: ${preferences.destination === 'dm' ? '本人DM' : '許可サーバーの元チャンネル'}\n${notificationScope(engine, actor)}\n進捗通知: 未対応（最終回答のみ）\n未送信／再試行待ち: ${preferences.pending}\n配送不明／sending: ${preferences.unknown}\nblocked: ${preferences.blocked}\n自動配信未完了（上限）: ${preferences.incomplete}\n未送信part数: ${preferences.undeliveredParts}\n変更は今後のRunだけに適用されます。既存Runの配送先は固定済みです。` };
        }
        if (sub === 'set') {
            const destination = interaction.options.getString('destination', true);
            if (destination !== 'dm' && destination !== 'origin')
                throw new AppError('PREFERENCE_INVALID', '通知先はdmまたはoriginで指定してください。');
            const confirmOrigin = interaction.options.getBoolean('confirm-origin') === true;
            if (destination === 'origin' && !confirmOrigin)
                throw new AppError('CONFIRMATION_REQUIRED', '元のサーバーチャンネルへ公開することをconfirm-origin:trueで確認してください。');
            const confirmedBinding = engine.binding(actor);
            const confirmedVersion = engine.bindingVersion(actor);
            if (destination === 'origin' && !confirmedBinding)
                throw new AppError('NOT_BOUND', '元チャンネルへの公開を確認する前に、この操作元で許可Sessionを選択してください。');
            engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
            engine.setNotificationPreferences(actor, { destination }, confirmOrigin);
            engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
            if (engine.binding(actor) !== confirmedBinding || engine.bindingVersion(actor) !== confirmedVersion)
                throw new AppError('BINDING_CONFLICT', '通知設定中にBindingが変更されました。設定を再確認してください。');
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
    if (sub === 'compact') {
        if (group !== null && group !== 'context')
            throw new AppError('UNKNOWN_COMMAND', '未対応のcontext操作です。');
        if (interaction.options.getBoolean('confirm', true) !== true)
            throw new AppError('CONFIRMATION_REQUIRED', 'Native CompactがSession contextを変更する可能性をconfirm:trueで確認してください。');
        const outcome = await engine.compact(actor, true);
        return { content: compactResponse(outcome.state) };
    }
    if (group === 'context')
        throw new AppError('UNKNOWN_COMMAND', '未対応のcontext操作です。');
    switch (sub) {
        case 'help':
            return { content: helpFor(interaction.options.getString('topic')) };
        case 'models': {
            const adapter = engine.adapter;
            if (typeof adapter.modelCatalog !== 'function')
                throw new AppError('MODEL_CATALOG_UNAVAILABLE', 'Native model catalogは利用できません。');
            const providerInput = interaction.options.getString('provider')?.trim() ?? '';
            const queryInput = interaction.options.getString('query')?.trim() ?? '';
            if (Array.from(providerInput).length > 100 || Array.from(queryInput).length > 100)
                throw new AppError('MODEL_QUERY_INVALID', 'provider/queryは100文字以内で指定してください。');
            const catalog = await adapter.modelCatalog();
            engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
            const providerNeedle = providerInput.toLocaleLowerCase('en-US');
            const queryNeedle = queryInput.toLocaleLowerCase('en-US');
            const routable = new Set(catalog.routableProviders);
            const models = catalog.groups.filter(group => routable.has(group.id)
                && (!providerNeedle || group.id.toLocaleLowerCase('en-US').includes(providerNeedle) || group.name.toLocaleLowerCase('en-US').includes(providerNeedle)))
                .flatMap(group => group.models.map(model => ({ group, model })))
                .filter(({ group, model }) => !queryNeedle || [group.id, group.name, model.id, model.name,
                ...(model.reasoning?.efforts.flatMap(effort => [effort.id, effort.name]) ?? []), ...(model.reasoning?.defaultEffort ? [model.reasoning.defaultEffort] : [])]
                .some(value => value.toLocaleLowerCase('en-US').includes(queryNeedle)));
            const lines = models.map(({ group, model }) => {
                const efforts = model.reasoning?.efforts ?? [];
                const visibleEfforts = efforts.slice(0, 12).map(effort => `${safeTitle(engine, effort.name, 40)} (${safeTitle(engine, effort.id, 40)})`);
                const effortLabel = efforts.length ? `\n   reasoning: ${visibleEfforts.join(', ')}${efforts.length > visibleEfforts.length ? ` (+${efforts.length - visibleEfforts.length} more)` : ''}${model.reasoning?.defaultEffort ? `; default ${safeTitle(engine, model.reasoning.defaultEffort, 40)}` : ''}` : '';
                return `• ${safeTitle(engine, group.name, 48)} (${safeTitle(engine, group.id, 64)}) / ${safeTitle(engine, model.id, 96)} — ${safeTitle(engine, model.name, 96)}${effortLabel}`;
            });
            const page = interaction.options.getInteger('page') ?? 1;
            const selectedDefault = modelLabel(engine, catalog.default);
            const failureLabel = catalog.failedProviders ? `\n取得できないprovider: ${catalog.failedProviders}（詳細は非表示）` : '';
            return { content: boundedRenderedPage(page, lines, (selected, currentPage, pages) => `Native model catalog（read-only・${models.length}件）${providerInput ? ` / provider filter: ${safeTitle(engine, providerInput, 80)}` : ''}${queryInput ? ` / query filter: ${safeTitle(engine, queryInput, 80)}` : ''}\nHost既定（Session設定とは別）: ${selectedDefault}\n${currentPage}/${pages}\n${selected.join('\n') || '一致するroutable modelはありません。'}${failureLabel}\nreasoning候補はmodelごとのNative metadataです。設定変更は未対応です.`) };
        }
        case 'rename':
        case 'title': {
            if (sub === 'title' && group !== 'settings' || sub === 'rename' && group !== null)
                throw new AppError('UNKNOWN_COMMAND', '未対応のsettings操作です。');
            if (interaction.options.getBoolean('confirm-no-cas') !== true)
                throw new AppError('CONFIRMATION_REQUIRED', 'Native title CASがなくDesktop同時変更を保護できないため、confirm-no-cas:trueで理解を確認してください。');
            const selected = await currentSession(engine, actor);
            if (!selected.session || !selected.sessionId || selected.bindingVersion === undefined)
                return { content: selected.content };
            const { sessionId, bindingVersion } = selected;
            const requestedTitle = interaction.options.getString(sub === 'title' ? 'value' : 'title', true).trim();
            if (!requestedTitle || Array.from(requestedTitle).length > 100 || /[\u0000-\u001f\u007f]/u.test(requestedTitle))
                throw new AppError('SESSION_TITLE_INVALID', 'titleは空でない100文字以内で指定してください。');
            const renameSession = engine.adapter.rename?.bind(engine.adapter);
            if (!renameSession)
                throw new AppError('SESSION_RENAME_UNAVAILABLE', 'Native Session title updateは利用できません。');
            return engine.withSessionMutation(sessionId, async () => {
                const current = await revalidateCurrentSession(engine, actor, sessionId, bindingVersion);
                const snapshot = await engine.adapter.snapshot(sessionId);
                if (typeof snapshot.values.title !== 'string' || !snapshot.values.title)
                    throw new AppError('SESSION_STATE_UNKNOWN', 'Native title projectionを確認できません。変更せずDSH GUIで確認してください。');
                const currentTitle = snapshot.values.title;
                if (requestedTitle === currentTitle)
                    return { content: 'titleは既に指定値です。Nativeへの変更要求は送信していません。' };
                const rawInbox = snapshot.values.inbox;
                if (!rawInbox || typeof rawInbox !== 'object' || Array.isArray(rawInbox))
                    throw new AppError('SESSION_STATE_UNKNOWN', 'Native queue状態を確認できません。変更せずDSH GUIで確認してください。');
                const inbox = rawInbox;
                for (const key of ['next-turn', 'next-step'])
                    if (!Array.isArray(inbox[key]))
                        throw new AppError('SESSION_STATE_UNKNOWN', 'Native queue状態を確認できません。変更せずDSH GUIで確認してください。');
                const queued = ['next-turn', 'next-step'].some(key => inbox[key].length > 0);
                const tracked = engine.store.allRuns().some(run => run.sessionId === sessionId && ACTIVE_STATES.has(run.state));
                if (current.running || queued || tracked)
                    throw new AppError('SESSION_BUSY', '実行中・処理待ち・結果不明のSessionは変更しません。');
                engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
                if (engine.binding(actor) !== sessionId || engine.bindingVersion(actor) !== bindingVersion)
                    throw new AppError('BINDING_CONFLICT', 'Session選択が変更されました。titleは変更していません。');
                const value = await renameSession({ sessionId, title: requestedTitle });
                try {
                    await revalidateCurrentSession(engine, actor, sessionId, bindingVersion);
                    const readback = await engine.adapter.snapshot(sessionId);
                    if (readback.cursor < value.seq || readback.values.title !== value.title)
                        throw new AppError('SESSION_RENAME_UNCONFIRMED', 'Native titleのreadbackを確認できません。');
                }
                catch (error) {
                    if (errorCode(error) === 'NOT_AUTHORIZED' || errorCode(error) === 'BINDING_CONFLICT')
                        throw error;
                    throw new AppError('SESSION_RENAME_UNCONFIRMED', 'Native title変更後のreadbackを確認できません。自動再送せずDSH GUIで確認してください。');
                }
                return { content: `選択中SessionのtitleをNativeで変更・readback確認しました。\nSession ID: ${safeId(engine, sessionId)}\ntitle: ${safeTitle(engine, value.title)}\nNative seq: ${value.seq}\nNative title CASはありません。外部Desktopとの同時変更はDSH GUIで確認してください。` };
            });
        }
        case 'current': {
            const selected = await currentSession(engine, actor);
            if (!selected.session || !selected.sessionId || selected.bindingVersion === undefined)
                return { content: selected.content };
            const { sessionId, bindingVersion } = selected;
            let session = selected.session;
            let busy = '不明（Native queue projectionを確認できません）';
            let lastUsedModel;
            let nextModel;
            try {
                const snapshot = await engine.adapter.snapshot(sessionId);
                const rawInbox = snapshot.values.inbox;
                const inbox = rawInbox && typeof rawInbox === 'object' && !Array.isArray(rawInbox) ? rawInbox : undefined;
                if (!inbox || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) {
                    busy = session.running ? '実行中（Native list）・queue状態は不明' : '不明（inbox projectionが欠落または不正）';
                }
                else {
                    const queued = inbox['next-turn'].length > 0 || inbox['next-step'].length > 0;
                    const tracked = engine.store.allRuns().some(run => run.sessionId === sessionId && ACTIVE_STATES.has(run.state));
                    const reasons = [session.running ? 'Native list running' : '', queued ? 'Native inbox nonempty' : '', tracked ? 'Bridge active/unknown Run' : ''].filter(Boolean);
                    busy = reasons.length ? `待機ではありません（${reasons.join('、')}）` : `待機を観測（Native snapshot seq ${snapshot.cursor}、最後のlist応答）`;
                }
                const selection = snapshot.values.modelSelection;
                if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
                    const values = selection;
                    lastUsedModel = projectedModel(values.lastUsed);
                    nextModel = projectedModel(values.next);
                }
            }
            catch {
                busy = session.running ? '実行中（Native list）・queue状態は不明' : '不明（snapshot取得不可）';
            }
            session = await revalidateCurrentSession(engine, actor, sessionId, bindingVersion);
            if (session.running)
                busy = '実行中（再検証後の最新Native list観測）';
            else if (busy.startsWith('待機を観測'))
                busy += '、再検証後のNative listはidle（完全な同時点保証なし）';
            const preferences = engine.notificationPreferences(actor);
            return { content: `Agent: DSH\nSession ID: ${safeId(engine, sessionId)}\nタイトル: ${safeTitle(engine, session.title)}\nWorkspace: ${safeTitle(engine, workspaceAlias(config, session), 80)}\n使用モデル（直近リクエスト）: ${modelLabel(engine, lastUsedModel)}\n次回設定モデル: ${modelLabel(engine, nextModel)}\nReasoningは各modelのNative metadata表示のみで、変更は未対応です。Busy: ${busy}\nBinding version: ${bindingVersion}\n通知先: ${preferences.destination === 'dm' ? '本人DM' : '許可サーバーの元チャンネル'}\n進捗通知: 未対応（最終回答のみ）` };
        }
        case 'workspace-add': {
            if (!engine.registerWorkspace)
                throw new AppError('WORKSPACE_SETUP_UNAVAILABLE', 'このHostはDiscordからの作業フォルダー登録に対応していません。');
            if (interaction.options.getBoolean('confirm-access') !== true)
                throw new AppError('CONFIRMATION_REQUIRED', 'このフォルダーへの作業アクセス追加を confirm-access:true で明示確認してください。');
            const alias = interaction.options.getString('alias', true);
            await engine.registerWorkspace(actor, alias, interaction.options.getString('path', true), interaction.options.getBoolean('confirm-access') === true);
            engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
            return { content: `作業フォルダー ${safeTitle(engine, alias, 40)}を許可・保存しました。パスは表示しません。\n/agent new workspace:<別名> で新規作成、または /agent sessions → /agent bind session:<ID> で選択してください。\n既存Run・選択Sessionは変更していません。設定版の更新により今後の自動起動は解除されます。必要ならGUIで再確認してください。フォルダー許可はOS sandboxではありません。` };
        }
        case 'workspaces': {
            const aliases = Object.keys(config.workspaces).filter(alias => {
                try {
                    engine.policy.workspace(alias, actor.guildId);
                    return true;
                }
                catch {
                    return false;
                }
            }).sort((a, b) => a.localeCompare(b));
            const bounds = pageBounds(interaction.options.getInteger('page') ?? 1, aliases.length, 20);
            const lines = bounds.rows.map(index => `• ${safeTitle(engine, aliases[index], 40)}`);
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
            if (!run)
                return { content: `この操作元のRun履歴はありません。\n選択Session: ${safeId(engine, engine.binding(actor) ?? 'なし')}` };
            return { content: runSummary(engine, run) };
        }
        case 'tasks': {
            const requestedState = interaction.options.getString('state');
            if (requestedState !== null && !KNOWN_STATES.has(requestedState))
                throw new AppError('PAGE_INVALID', 'Run状態の選択肢が不正です。');
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
            let connectivity;
            let allowedSessions = 0;
            try {
                allowedSessions = (await engine.sessions(actor)).length;
                connectivity = `DSH Session list read: 成功（許可Session ${allowedSessions}件）`;
            }
            catch (error) {
                connectivity = `DSH Session list read: 失敗（${safeErrorLabel(errorCode(error))}）`;
            }
            const adapter = engine.adapter;
            const capabilities = [
                ['list', typeof adapter.list === 'function'], ['create', typeof adapter.create === 'function'],
                ['snapshot/projections', typeof adapter.snapshot === 'function'], ['prompt', typeof adapter.prompt === 'function'],
                ['model catalog', typeof adapter.modelCatalog === 'function'], ['Session title rename', typeof adapter.rename === 'function'],
                ['Native Compact command', typeof adapter.executeCompact === 'function']
            ].map(([name, available]) => `${name}: ${available ? 'adapter method available' : 'unavailable'}`);
            const preferences = engine.notificationPreferences(actor);
            const lastRunError = engine.store.allRuns()
                .filter(run => run.userId === actor.userId && run.guildId === actor.guildId && run.channelId === actor.channelId && run.lastError)
                .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.lastError;
            return { content: `接続診断（server-only / authorized）\n${connectivity}\nAdapter mapping:\n${capabilities.join('\n')}\nNative version: 不明（Adapterの公開契約なし）\nHistory: unavailable（Native sessionQuery.filterEvents is available, but role/output and bounded materialization are not safely implemented）\nModel catalog: methodがあればread-only表示可能。model/reasoning選択はHost既定も変える可能性があり未対応\nSettings reset: unavailable（Session専用CAS/readbackなし）\nContext: sessionStatsの実測context使用量・上限は保証なし\n通知滞留: ${preferences.pending} pending / ${preferences.unknown} unknown/sending / ${preferences.blocked} blocked / ${preferences.incomplete} incomplete / ${preferences.undeliveredParts} 未送信part\n最後の安全なエラーコード: ${lastRunError ? safeErrorLabel(lastRunError) : '記録なし'}\nToken・ローカルパス・raw errorは表示しません。` };
        }
        default:
            throw new AppError('UNKNOWN_COMMAND', '未対応コマンドです。/agent helpで使用可能な操作を確認してください.');
    }
}
//# sourceMappingURL=command-handler.js.map