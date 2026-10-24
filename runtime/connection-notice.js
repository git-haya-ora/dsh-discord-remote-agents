import { normalize } from 'node:path';
import { escapeMarkdown } from 'discord.js';
import { AppError } from './errors.js';
/** Metadata only, never a prompt/history read or a synthetic Run. */
export async function connectionNotice(engine, config, actors) {
    if (!actors.length || actors.length > 100)
        throw new AppError('NOT_AUTHORIZED', '通知元を確認できません。');
    for (const actor of actors)
        engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
    const text = (value, limit, allowModelNamespace = false) => {
        let safe = engine.redactText(value).replace(/[\u0000-\u001f\u007f]/gu, ' ');
        // Titles are user-controlled: even metadata can accidentally contain a workstation path.
        for (const path of Object.values(config.workspaces)) {
            for (const variant of new Set([path, path.replace(/\\/gu, '/')])) {
                if (variant && (process.platform === 'win32' ? safe.toLowerCase().includes(variant.toLowerCase()) : safe.includes(variant)))
                    return '[パス非表示]';
            }
        }
        // Path boundaries are ambiguous in free text (especially spaces/quotes). Hide the
        // entire field rather than risk disclosing an unmatched private path suffix.
        // Only provider/model fields may contain a narrow identifier-only namespace.
        // Other slash-bearing free text is hidden regardless of surrounding delimiters.
        const namespace = allowModelNamespace && /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u.test(safe);
        if (safe.includes('\\') || (safe.includes('/') && !namespace))
            return '[パス非表示]';
        return escapeMarkdown(Array.from(safe).slice(0, limit).join(''));
    };
    const model = (value) => value
        ? `${text(value.provider, 40, true)} / ${text(value.model, 60, true)}${value.reasoningEffort ? `（推論: ${text(value.reasoningEffort, 24)}）` : ''}` : '未取得';
    const key = (path) => process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
    const guards = [];
    let content = 'Discord接続成功\n接続先: DSH（このPC）\n';
    const shown = actors.slice(0, 3);
    for (const actor of shown) {
        const id = engine.binding(actor), version = engine.bindingVersion(actor);
        guards.push(() => {
            engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
            if (engine.binding(actor) !== id || engine.bindingVersion(actor) !== version)
                throw new AppError('BINDING_CONFLICT', '通知の選択先が変更されました。');
        });
        let block = `\nチャンネルID: ${actor.channelId}\n`;
        try {
            const { session } = await engine.selectedSession(actor);
            if (!session)
                block += 'プロジェクト: 未選択\nSession: 未選択\n使用モデル: 未取得\n';
            else {
                const alias = Object.entries(config.workspaces).find(([, path]) => session.cwd && key(path) === key(session.cwd))?.[0];
                block += `プロジェクト: ${alias ? text(alias, 40) : '許可済み（別名未取得）'}\nSession: ${text(session.title, 55)}\nSession ID: ${text(session.sessionId, 100)}\n`;
                block += `使用モデル（直近のリクエスト）: ${model(session.lastUsedModel)}\n次回設定モデル: ${model(session.nextModel)}\n`;
            }
        }
        catch {
            engine.policy.authorize(actor.userId, actor.guildId, actor.channelId);
            block += '作業先・モデル: 確認できません（未選択とは限りません）\n';
        }
        // Keep the whole message below Discord's UTF-16 limit, including escaped labels.
        if ((content + block).length > 1750) {
            content += '\n残りの作業先は /agent current で確認してください。\n';
            break;
        }
        content += block;
    }
    if (actors.length > shown.length)
        content += `\n他${actors.length - shown.length}チャンネルの作業先は /agent current で確認してください。\n`;
    content += '\nモデル表示はNativeの観測情報です。現在実行中・次回実行済みを意味しません。';
    const assertCurrent = () => { for (const actor of actors)
        engine.policy.authorize(actor.userId, actor.guildId, actor.channelId); for (const guard of guards)
        guard(); };
    assertCurrent();
    return { content, assertCurrent };
}
//# sourceMappingURL=connection-notice.js.map