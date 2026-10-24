# はじめに — DiscordからDSHを使う

**初回はPCで設定し、その後はDiscordから操作します。** ソース開発と配布を統合した公開GitHubリポジトリから、ビルド済みpluginを導入します。ターミナル操作・ビルド・`.env`編集・ローカルtarballは不要です。正式導入・実Discord往復はまだ未検証です。

## 1. DSHに追加する（初回だけ）

1. 起動中のDSHで **Plugins → プラグイン追加** の正式操作を開きます。
2. 次の公開GitHubアドレスを入力します。package名は `dsh-discord-remote-agents` です。`#`以降は検証版を固定するための長い識別子でしたが、通常の導入では省略できます（mainの最新版を取得）。旧 `@local/dsh-discord-remote-agents` を使っていた場合は先に停止・無効化し、同時稼働させないでください。

   ```text
   github:git-haya-ora/dsh-discord-remote-agents
   ```

   [開発・配布リポジトリ](https://github.com/git-haya-ora/dsh-discord-remote-agents)。利用者はrootのビルド済みbundleを使い、開発者は同じrepoで開発します。旧private開発repoは使いません。
3. 導入結果を確認し、同じDSH画面を再読み込みして、このpluginの設定を開きます。再起動が必要と表示された場合は、作業が安全に終わってから通常の方法で再起動してください。

**npmレジストリへは公開していません。** `private: true` で誤公開を防ぎ、GitHubから導入します。レジストリ公開は別途の明示的な許可が必要です。

導入時はインターネット接続が必要です。別のWebサーバーやDSH接続tokenは使いません。対応環境や詳細な導入操作は[詳しい手順](<restricted-installation.md>)へ。

## 2. 設定を保存する

DSHのplugin設定を、**設定を保存 → Discordにコマンドを追加 → 接続を開始**の順に進めます。まず次の情報を入力します。

| 入力するもの | 調べ方 |
|---|---|
| Bot token | [Discord Developer Portal](https://discord.com/developers/applications) の自分のApplication → Bot。新しく発行したtokenをpassword欄だけへ入力 |
| Application ID | 同じApplicationのGeneral Informationからコピー |
| サーバーID | Discordのサーバーを右クリック → IDをコピー |
| 許可するユーザーID | 自分のプロフィールを右クリック → ユーザーIDをコピー。まず自分だけを許可 |
| 許可するチャンネルID | Botを使うチャンネルを右クリック → IDをコピー。thread利用時はthread自体のID |
| 作業フォルダー | 名前は初期値の `main` で構いません。フォルダーをエクスプローラーで開き、アドレスバーから絶対パスをコピー |

「IDをコピー」がなければ、Discordの **ユーザー設定 → 詳細設定 → 開発者モード** を有効にします。Botはあらかじめ自分のサーバーへ招待してください（scopeは `bot` と `applications.commands`、管理者権限・Message Content intentは不要）。

招待時の Permissions Integer は指定値 **`563156112238656`** を使用します。以下の `APPLICATION_ID` と `GUILD_ID` を自分の値に置き換え、ブラウザーで権限を確認して招待します。tokenはURLへ入れません。

```text
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&guild_id=GUILD_ID&disable_guild_select=true&scope=bot%20applications.commands&permissions=563156112238656
```

この指定値は最小権限ではなく、メッセージ管理なども含みます。一方、`View Channel` は含まないため、対象チャンネルをBotが閲覧できることをロール／チャンネル設定で確認してください。Botの招待権限は操作ユーザーの認可とは別で、許可User/Guild/Channelの設定は必要です。接続後は `/agent help topic:invite` でも設定済みIDの招待URLを確認できます。

**保存時にもBotを確認するので、別のtokenテストは必須ではありません。** token欄は送信時に空になります。保存済みtokenの読み戻しはなく、空欄での保存は既存tokenを維持します。チャットへ貼ったtokenは使わないでください。

## 3. Discordに追加して接続する

1. 内容を確認して、画面の **コマンド登録** を実行します。初回やcommand更新時に行う操作です。設定サーバーの `/agent` だけを追加・更新し、他のコマンドは削除しません。保存・接続・build/testでは自動登録しません。再読込後に登録済み表示がなくても、未登録と断定したものではありません。
2. 旧CLIや別receiverを止めたこと、同じSessionへPCとDiscordから同時送信しないことを確認して、**開始**します。
3. 状態が接続済みになったことを確認します。保存だけでは接続しません。自動起動などは「詳細設定」にあり、初回は変更不要です。

## 普段はDiscordでこの3操作

Botを許可したチャンネルで実行します。`ID`と`指示`は実際の内容に置き換えてください。短い操作案内は `/agent help topic:start` で表示できます。

1. **選ぶ**：`/agent sessions` で一覧を見て、`/agent bind session:ID` で続けたいSessionを選択。
2. **頼む**：`/agent prompt text:指示` で送信。
3. **確認する**：`/agent result` で途中出力・結果を確認。完了時は本人DMにも通知します。進み具合は `/agent status`。

新しい作業を始める場合は、選択の代わりに `/agent new workspace:main` を使えます。選択先はチャンネル内で共有され、送信済みの指示の行き先は後から変わりません。

## 困ったとき

- **保存前の変更が残っている**：保存するか、変更を破棄してから登録・接続してください。
- **DMが来ない**：同じチャンネルの `/agent result` で確認できます。指示をもう一度送る必要はありません。
- **結果が不明（unknown）**：指示も通知も再送せず、PCで元のSessionを確認してください。
- **承認・実行停止・ファイル操作**：PCのDSHで行います。pluginの「停止」はDiscord接続だけを止めます。
- **保存領域・権限・接続エラー**：画面の詳細と[復旧手順](<restricted-installation.md#6-保全更新復旧>)を確認してください。権限を無理に緩めたり、データを消して再実行したりしないでください。

この機能はPCのDSH実行権限を使います。許可フォルダーはサンドボックスではありません。PCとDiscordは同一Sessionを**交互に**使ってください。
