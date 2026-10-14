# Discord Remote Agents for DSH — Windows restricted preview

DSHの **Plugins → プラグイン追加** に次の公開GitHubアドレスを入力します。

```text
github:git-haya-ora/dsh-discord-remote-agents
```

このリポジトリは配布専用です。直下のpackage.jsonにDSH bundle／Client宣言があり、必要なJavaScriptと保護helperをビルド済みで含みます。利用者のビルド、ローカルtarball、開発リポジトリへのアクセスは不要です。固定revisionで導入したい場合はアドレス末尾に `#` と確認した完全なcommit SHAを付けてください。

**実DSHへの導入・画面表示・実Discord往復は未検証です。** GitHub取得や単体試験の成功を実機動作保証とはしません。契約調査対象はDSH 0.2.0-rc.2、Windows、Node >=22.23.0です。依存discord.js 14.27.0の取得にインターネットが必要です。

## 初回設定

1. インストール結果のHost activationとClient synchronizationを確認し、同じDSH画面を再読み込みしてplugin設定を開きます。再起動が必要なら、作業が安全に終わってから通常の方法で再起動してください。
2. サーバーID、Application ID、許可User ID、許可Channel ID、作業フォルダー名と絶対パスを指定します。DiscordのIDコピーには「ユーザー設定 → 詳細設定 → 開発者モード」を使います。まず自分だけを許可してください。
3. Discord Developer Portalで新規発行したBot tokenを設定画面のpassword欄だけに入力し、**設定を保存 → Discordにコマンドを追加 → 接続を開始**の順に進めます。保存時にBotを検証するため別のTokenテストは任意です。保存だけでは接続しません。
4. Botを自分のサーバーへ招待してください。scopeは `bot` と `applications.commands`。管理者権限・Message Content intentは不要です。tokenを会話やIssueへ貼らないでください。

## 普段の操作

許可したチャンネルで `/agent sessions` → `/agent bind session:ID` → `/agent prompt text:指示` → `/agent result`。IDと指示は実際の値に置き換えます。進み具合は `/agent status`、新規作業は `/agent new workspace:main`。完了通知は本人DMです。DM失敗でも指示を再送せず `/agent result` を確認します。選択先はチャンネル共有で、送信済み指示の行き先は後から変わりません。

## 必ず守る制限

- 認証済みDSH GUIの単一operatorを信頼します。別owner/admin権限はありません。ログイン済みDSHを他人と共有しないでください。
- 同じSessionをPCとDiscordで**交互に**使ってください。Desktopとの同時送信は原子的に排除できません。旧CLIや別receiverとの同時運用も避けてください。
- 承認、実行停止、添付、ArtifactはPCのDSHで操作します。pluginの停止はDiscord接続だけを止めます。
- 結果不明の指示・通知は自動再送しません。unknownならPCで元のSessionを確認してください。
- tokenは同じWindows利用者のCurrentUser DPAPIで保護し、読み戻しUIや平文fallbackはありません。保存領域のACLやlogging policyが安全検査に通らなければ停止します。権限を緩めたり、DBを削除して再送したりしないでください。
- 許可フォルダーはOSサンドボックスではありません。pluginはDSHの実行権限を持ちます。詳しくは[セキュリティ](<SECURITY.md>)を確認してください。

## 配布の検査

`MANIFEST.sha256`は実行ファイル等38件のSHA256一覧です。秘密やlocal設定を持たない配布専用の新規履歴として公開しています。checksumは完全性確認用であり、第三者の安全性保証や署名ではありません。自動更新・DSHへの自動インストールは行いません。
