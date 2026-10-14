import { SlashCommandBuilder } from 'discord.js';
export const command = new SlashCommandBuilder().setName('agent').setDescription('WindowsのDSHを安全に遠隔操作')
    .setDMPermission(false)
    .addSubcommand(c => c.setName('sessions').setDescription('許可フォルダーの既存セッションを表示')
    .addIntegerOption(o => o.setName('page').setDescription('ページ番号（1から）').setMinValue(1).setMaxValue(100)))
    .addSubcommand(c => c.setName('new').setDescription('許可フォルダーに新規セッションを作成・選択')
    .addStringOption(o => o.setName('workspace').setDescription('設定済み作業フォルダーの別名').setRequired(true).setMaxLength(40)))
    .addSubcommand(c => c.setName('bind').setDescription('既存セッションを自分用に選択')
    .addStringOption(o => o.setName('session').setDescription('DSHのセッションID').setRequired(true).setMaxLength(200)))
    .addSubcommand(c => c.setName('unbind').setDescription('セッション選択を解除（実行は停止しない）'))
    .addSubcommand(c => c.setName('prompt').setDescription('選択セッションへ指示を送信')
    .addStringOption(o => o.setName('text').setDescription('DSHへの指示（OS権限で実行されます）').setRequired(true).setMaxLength(6000)))
    .addSubcommand(c => c.setName('status').setDescription('実行状況と配信状況を確認')
    .addStringOption(o => o.setName('run').setDescription('実行ID（省略時はこの操作元の最新）').setMaxLength(30)))
    .addSubcommand(c => c.setName('result').setDescription('実行結果・途中のテキストを自分だけに表示')
    .addStringOption(o => o.setName('run').setDescription('実行ID（省略時はこの操作元の最新）').setMaxLength(30)))
    .addSubcommand(c => c.setName('notify').setDescription('完了結果のDM配信を再試行')
    .addStringOption(o => o.setName('run').setDescription('完了した実行ID').setRequired(true).setMaxLength(30)))
    .addSubcommand(c => c.setName('help').setDescription('使い方と安全上の注意を表示'));
export const HELP = `**DSH遠隔操作**\n1. /agent sessions → IDを確認\n2. /agent bind session:ID → 自分用に選択\n3. /agent prompt text:指示 → 実行IDを受領\n4. /agent status または /agent result → 自分だけに表示\n完了結果はDMにも通知します。DM拒否時はresultで確認できます。\n選択はユーザー×サーバー×チャンネルごと、実行IDは送信時のセッションに固定です。\nDSHのOS権限・承認設定が適用されます。承認待ちはPCで対応してください。Botからの承認・強制停止・自動再送はありません。\n送信結果unknownは再送しないでください。実行中はDSH GUIから同じセッションへ指示しないでください。`;
//# sourceMappingURL=commands.js.map