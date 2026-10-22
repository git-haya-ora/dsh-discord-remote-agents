import { SlashCommandBuilder } from 'discord.js';
/**
 * Registered command surface is deliberately limited to operations backed by
 * Engine/AgentAdapter contracts. Every nested option list stays below Discord's
 * 25-option limit; only verified settings subcommands are registered; model/DM/C gaps remain help-only.
 */
export const command = new SlashCommandBuilder().setName('agent').setDescription('許可済みDSH Sessionを安全に確認・操作')
    .setDMPermission(false)
    .addSubcommand(c => c.setName('help').setDescription('使用可能な操作と未対応機能の理由').addStringOption(o => o.setName('topic').setDescription('説明する機能（models/model/reasoning/settings/context等）').setMaxLength(32)))
    .addSubcommand(c => c.setName('current').setDescription('現在のSessionと確認可能な設定を表示'))
    .addSubcommand(c => c.setName('models').setDescription('Nativeが広告する利用可能model catalogを検索')
    .addStringOption(o => o.setName('provider').setDescription('provider IDまたは表示名').setMaxLength(100))
    .addStringOption(o => o.setName('query').setDescription('model ID/nameまたはreasoning effortを検索').setMaxLength(100))
    .addIntegerOption(o => o.setName('page').setDescription('ページ番号（1から）').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(c => c.setName('rename').setDescription('選択Sessionのtitleを変更（Native CASなし・実行中不可）')
    .addStringOption(o => o.setName('title').setDescription('新しいSession title（最大100文字）').setRequired(true).setMaxLength(100))
    .addBooleanOption(o => o.setName('confirm-no-cas').setDescription('Native CASがなくDesktop同時変更を保護できないことを確認').setRequired(true)))
    .addSubcommandGroup(g => g.setName('settings').setDescription('Nativeが対応するSession設定')
    .addSubcommand(c => c.setName('title').setDescription('Session titleを変更（Native CASなし）')
    .addStringOption(o => o.setName('value').setDescription('新しいSession title（最大100文字）').setRequired(true).setMaxLength(100))
    .addBooleanOption(o => o.setName('confirm-no-cas').setDescription('Native CASがなくDesktop同時変更を保護できないことを確認').setRequired(true))))
    .addSubcommand(c => c.setName('workspaces').setDescription('許可済みWorkspace aliasをページ表示')
    .addIntegerOption(o => o.setName('page').setDescription('ページ番号（1から）').setMinValue(1).setMaxValue(100)))
    .addSubcommand(c => c.setName('workspace-add').setDescription('接続後に既存フォルダーを許可（アクセス追加の明示確認が必要）')
    .addStringOption(o => o.setName('alias').setDescription('新しい作業フォルダーの別名').setRequired(true).setMaxLength(40))
    .addStringOption(o => o.setName('path').setDescription('このPCの既存フォルダーの絶対パス（OS sandboxではありません）').setRequired(true).setMaxLength(1024))
    .addBooleanOption(o => o.setName('confirm-access').setDescription('許可ユーザーによるこのフォルダーへの作業アクセス追加を確認').setRequired(true)))
    .addSubcommand(c => c.setName('sessions').setDescription('許可Sessionを検索・ページ表示')
    .addStringOption(o => o.setName('query').setDescription('Session IDまたはタイトルで検索').setMaxLength(100))
    .addIntegerOption(o => o.setName('page').setDescription('ページ番号（1から）').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(c => c.setName('new').setDescription('許可WorkspaceにSessionを作成・選択（model/title指定なし）')
    .addStringOption(o => o.setName('workspace').setDescription('設定済み作業フォルダーの別名').setRequired(true).setMaxLength(40)))
    .addSubcommand(c => c.setName('bind').setDescription('許可済み既存Sessionを選択')
    .addStringOption(o => o.setName('session').setDescription('完全なDSH Session ID').setRequired(true).setMaxLength(200)))
    .addSubcommand(c => c.setName('unbind').setDescription('選択だけ解除（実行・Sessionは削除しない）'))
    .addSubcommand(c => c.setName('prompt').setDescription('選択Sessionへ指示を送信')
    .addStringOption(o => o.setName('text').setDescription('DSHへの指示（OS権限で実行されます）').setRequired(true).setMaxLength(6000)))
    .addSubcommand(c => c.setName('status').setDescription('Run状態と配信状態を確認')
    .addStringOption(o => o.setName('run').setDescription('Run ID（省略時はこの操作元の最新）').setMaxLength(30)))
    .addSubcommand(c => c.setName('tasks').setDescription('自分の許可範囲内のRunを表示')
    .addStringOption(o => o.setName('state').setDescription('Run状態で絞り込み').addChoices({ name: '送信中', value: 'dispatching' }, { name: '受付済み', value: 'accepted' }, { name: '実行中', value: 'running' }, { name: '結果不明', value: 'unknown' }, { name: '完了', value: 'succeeded' }, { name: '失敗', value: 'failed' }, { name: '中断', value: 'interrupted' }))
    .addIntegerOption(o => o.setName('page').setDescription('ページ番号（1から）').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(c => c.setName('result').setDescription('Runの途中出力または最終回答をページ表示')
    .addStringOption(o => o.setName('run').setDescription('Run ID（省略時はこの操作元の最新）').setMaxLength(30))
    .addIntegerOption(o => o.setName('page').setDescription('結果ページ（1から）').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(c => c.setName('notify').setDescription('旧互換: 完了通知を再試行（unknownは不可）')
    .addStringOption(o => o.setName('run').setDescription('この操作元の完了Run ID').setRequired(true).setMaxLength(30)))
    .addSubcommand(c => c.setName('diagnose').setDescription('接続・公開capability・安全なエラーを確認'))
    .addSubcommandGroup(g => g.setName('notifications').setDescription('配信方針の確認・変更と明示再試行')
    .addSubcommand(c => c.setName('show').setDescription('現在の配信先と滞留状態を表示'))
    .addSubcommand(c => c.setName('set').setDescription('今後のRunの配信方針を変更')
    .addStringOption(o => o.setName('destination').setDescription('通知先').setRequired(true).addChoices({ name: '本人DM', value: 'dm' }, { name: '許可サーバーの元チャンネル', value: 'origin' }))
    .addBooleanOption(o => o.setName('confirm-origin').setDescription('表示中のUser/Guild/Channel/Bindingへ公開することを確認')))
    .addSubcommand(c => c.setName('retry').setDescription('通知だけを明示再試行（Native promptは再実行しない）')
    .addStringOption(o => o.setName('delivery').setDescription('Run/delivery ID').setRequired(true).setMaxLength(30))
    .addIntegerOption(o => o.setName('part').setDescription('対象part（省略時は未完了part）').setMinValue(1).setMaxValue(128))
    .addBooleanOption(o => o.setName('confirm-duplicate-risk').setDescription('unknown配送の重複リスクを確認'))));
export const HELP = `**DSH遠隔操作 — server-only**
作業フォルダー未指定でも接続できます。接続後、/agent workspace-add alias:<別名> path:<PC上の絶対パス> confirm-access:true で既存フォルダーを許可し、/agent new workspace:<別名> または /agent sessions → /agent bind で作業先を選びます。登録は許可ユーザー・Guild・Channel限定で、既存別名は上書きしません。パスをコマンド引数としてDiscordに渡すため、秘密の文字列を含めないでください。
使用可能: /agent current, /agent models, /agent settings title value:<title>（/agent renameは互換alias）, /agent workspaces [page], /agent workspace-add, /agent sessions, /agent new, /agent bind, /agent unbind, /agent prompt, /agent status, /agent tasks, /agent result, /agent diagnose, /agent notifications show|set|retry, /agent notify（旧互換）。すべて許可ユーザー・Guild・Channelを毎回検査します。
/agent currentは直近リクエストで使用されたmodelと次回設定modelを区別して表示します。Nativeが値を返さない場合は推測せず未取得とします。実行中modelの断定やcontext使用量は表示しません。
/agent modelsはNative model catalogのprovider/modelと実在するmodel別reasoning effort候補を検索するread-only機能です。providerの失敗本文は表示しません。model選択・reasoning変更・/agent newのtitle/model/effort指定・settings resetは未対応です。selectModelはSession専用CAS/readbackの根拠がなくHost既定も変更するため使いません。
/agent renameは選択中・待機中SessionのtitleをNativeで変更しreadbackを確認します。Native title CASはありません。結果不明時は自動再送しないでDSH GUIで確認してください。
/agent historyは未登録です。現行Native page契約にevent type/fieldを絞る正式filterがないため、reasoning/secretsを取得しない保証ができません。raw pageを後から絞る代替は行いません。結果全文は/agent resultから確認してください。
/agent contextの実測値・上限は未対応です。通知先変更は今後のRunだけに適用され、origin公開には表示scopeでの明示確認が必要です。unknown通知は重複リスクを明示確認しない限り再試行できません。進捗通知は未対応で最終回答のみです。
C機能（targeted stop、approval、bridge FIFO queue、attachments/artifacts、chat enable）は未登録・無効です。DM-only操作は設計・実証待ちで、DMからのコマンドは無効です。通常DM本文を実行しません。DSH GUIで停止・承認を確認してください。
通知は実行状態と別管理です。結果は/agent resultでページごとに確認できます。DSHのOS権限が適用されます。`;
//# sourceMappingURL=commands.js.map