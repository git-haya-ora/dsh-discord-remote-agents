# Legacy Telegram guide — feature development deferred

Preserved for existing code/regression context only, not the supported Discord plugin onboarding. Use [restricted installation](<restricted-installation.md>). Live Telegram compatibility is unverified; do not use exposed credentials.

## 実装範囲

Discord版と同じDSH Adapter／実行エンジンを使い、Telegramから既存セッション一覧・選択、新規作成、指示送信、状態／結果確認、完了通知ができます。**許可した本人とのプライベートチャットだけ**対応します。グループ・チャンネル・編集メッセージ・転送メッセージ・Business経由・画像／ファイル入力は操作として受け付けません。

Telegram Bot APIへHTTPSでlong pollingします。公開HTTPサーバー、Webhook、ポート開放は不要です。PC上のBotとDSHが起動している必要があります。承認／停止はPCのDSHで行い、DSHの権限や承認ポリシーは変更しません。

**検証:** 自動テストでコマンド、認可、API要求、重複更新、再起動、Discordとの分離を確認。実Telegramトークン／DSHトークンが未設定のため、実サービスでの往復は未検証です。

## 1. Botを用意する

1. Telegramの公式[@BotFather](<https://t.me/BotFather>)で`/newbot`を実行し、この用途専用のBotを作ります。
2. Bot TokenをPC上に控えます。ユーザー名と表示名は認可には使わず、**数値User ID／Chat ID**で許可します。
3. BotFatherの`/setjoingroups`でグループへの追加を無効にすることを推奨します。実装側でもグループ操作は拒否します。
4. 自分からBotのプライベートチャットを開き、Startを押します。Botはユーザーが開始していないチャットへ勝手に通知を開始できません。
5. Webhookを使用している既存Botとは共用しないでください。起動時にWebhookがある場合は拒否し、自動削除や未処理更新の一括破棄はしません。

## 2. ローカル設定

[設定テンプレート](<../telegram.config.example.json>)と[環境変数テンプレート](<../.env.example>)を使います。既存の設定は上書きしないでください。

```powershell
# .envが既にある場合はコピーせず、必要な変数だけ追加する
Copy-Item .env.example .env
Copy-Item telegram.config.example.json telegram.config.json
notepad .env
notepad telegram.config.json
```

`.env`に次を設定します。**Telegramだけの場合、DiscordのトークンとApplication IDは不要**です。

```dotenv
TELEGRAM_BOT_TOKEN=BotFatherから取得した値
TELEGRAM_CONFIG=telegram.config.json
# PORTは既存DSHホストの実際のポートへ置換するplaceholderです。
DSH_URL=http://127.0.0.1:PORT
DSH_TOKEN=現在のDSH起動トークン
```

DSH_TOKENの取得方法とWindowsの安全設定は[README](<../README.md#3-ローカル設定を作る>)を確認してください。TelegramトークンもURL、ログ、チャット、Gitへ貼らないでください。BotのプライベートチャットはSecret Chatではなくクラウド側にも保存されるため、秘密の指示や結果を送らないでください。

Telegram設定JSONは次の形です。

```json
{
  "allowedUserIds": ["123456789"],
  "allowedChatIds": ["123456789"],
  "allowedWorkspaces": {
    "project-a": "C:\\Users\\YOUR_NAME\\Projects\\project-a"
  },
  "pollIntervalMs": 5000,
  "databasePath": "data/bot.sqlite"
}
```

- 正の数値IDを**文字列**で設定します。プライベートチャットではUser IDとChat IDが一致します。両方の許可リストに本人のIDを入れてください。
- 自分のIDが不明な場合、仮の正のIDを入れ、Botを起動してプライベートチャットから`/whoami`を送ります。このコマンドだけは認可前でも**送信者本人のIDのみ**返します。PCで設定を書き換え、Botを再起動します。DSH情報は認可前に返しません。
- 許可作業フォルダーは絶対パスと実ディレクトリの一致が必要です。配下全体の許可やOSのサンドボックスではありません。
- 設定変更は再起動後に反映します。許可ユーザー／Chat ID／作業フォルダーを削除した場合、その結果の自動配信も止まります。
- ローカル設定とデータは[Git除外設定](<../.gitignore>)の対象ですが、暗号化されません。NTFS権限で本人だけに制限し、クラウド同期対象にしないでください。

## 3. ビルドと起動

```powershell
npm ci --ignore-scripts
npm test
npm run check:dsh
npm run start:telegram
```

`[TELEGRAM_READY]`はBot本人確認、Webhook不存在、コマンドメニュー登録が済んだことを示します。DSHの認証やモデル実行の成功までは示しません。追加のnpmライブラリは導入せず、Node.js標準fetchを使用します。

Ctrl+Cで終了します。Bot終了は**DSHで開始した処理のキャンセルではありません**。

### Discordと同時に使う

1. [Discord用設定](<../README.md>)も準備し、`npm run register`でDiscordコマンドを登録します。
2. 両方の設定JSONの`databasePath`を同じパスにします。既定は双方とも`data/bot.sqlite`です。
3. `npm run start:all`で**一つのプロセスとして**起動します。

同時起動では、両サービスの実行・受信情報を一つのSQLiteとEngineで管理し、**同じDSHセッションにはどちらからでも未確定実行を一つだけ**許可します。ユーザー認可・許可作業フォルダー・選択・結果の閲覧権限はサービス別です。Discordから送った実行はDiscordのDMへ、Telegramから送った実行は元のTelegramプライベートチャットへ通知します。

単独起動を切り替える際も同じデータベースを使うと実行排他と履歴を維持できます。起動していない側の通知は保留され、対応するサービスを起動してから再開します。同じSQLiteを二つのプロセスで開くと起動を拒否します。**異なるSQLiteに分けて両Botを別々に起動し、同じDSHセッションを操作しないでください。** その場合、Bot間の実行排他を共有できません。

## 4. 操作

```text
/sessions
/bind セッションID
/prompt ツールを使わず、REMOTE_BOT_OKとだけ返答してください。
/status
/result
```

| コマンド | 用途 |
|---|---|
| `/sessions [ページ]` | 許可された既存セッションを5件ずつ表示 |
| `/bind セッションID` | 自分専用の選択先を設定 |
| `/new project-a` | 設定済み作業フォルダー別名で新規作成・選択 |
| `/prompt 指示` | 選択先に一度だけ送信。改行を含む指示も可 |
| `/status [実行ID]` | 状態と通知状況。省略時は本人の最新 |
| `/result [実行ID]` | 結果または途中出力。長い結果はUTF-8テキスト添付 |
| `/notify 実行ID` | 完了通知の再配信を予約 |
| `/unbind` | 選択解除。実行・セッションは削除しない |
| `/whoami` | 自分の数値User ID／Chat ID |
| `/help`、`/start` | 操作説明 |

通常のテキストはDSHへ転送しません。コマンド名の`@BotUsername`はこのBotに一致する場合だけ受け付けます。別のユーザー、Chat ID、Discordの実行IDから結果本文を取得することはできません。

Telegramの通常テキスト送信は4096文字制限を考慮し、長い出力は単一の文書メッセージとして送ります。HTML／Markdownのparse modeは付けません。リンクプレビューを無効にし、`protect_content`を付けますが、スクリーンショットや外部への漏えいを完全には防げません。

## 5. 実行の安全性と復旧

- 更新はBot ID＋update IDでSQLiteへ先に記録します。同じ更新を再取得してもコマンドを繰り返し実行しません。
- `/prompt`の実行IDは`tg-<Bot ID>-<update ID>`、DSH requestIdは`telegram:<実行ID>`です。DiscordのIDと混同しません。
- 更新を記録してからDSHへ送る前にクラッシュすると、そのコマンドが実行されない場合があります。**自動再実行しない設計**です。まず`/status`とPCのDSHで確認してください。
- 返信のネットワークエラーを指示失敗と決めつけません。DSHへの指示を再送せず、`/status`／`/result`で受付を確認します。
- DSH送信の応答が不明ならunknownにして同じセッションをロックし、履歴照合だけを続けます。
- 完了通知は保存後に配信し、失敗時はEngineのoutboxが再試行します。Telegramにexactly-onceな通知契約は仮定しないため、送信直後の通信断やクラッシュで通知が重複することがあります。
- 429は`retry_after`を尊重します。Webhook／別受信プロセスとの409競合は停止し、自動的に乗っ取りません。
- Telegramの未受信更新は最大24時間です。Botが停止中に送ったコマンドは復帰時に処理される場合があり、24時間を超えて消えた指示の復元はできません。
- 更新IDは1週間の無更新後にランダム化されるため、24時間以上経過した古い受信offsetは破棄します。保存した更新受領記録で再実行を防ぎます。
- 新規作成や選択操作も受信済み記録により再実行しません。作成応答が不明な場合は一覧とPCで確認します。
- 指示本文や更新JSONをSQLiteへ保存しません。ただしDSHが指示をモデル出力へ含めた場合、その出力は保存され得ます。受領記録の自動削除は未実装です。

## 6. 初回の実機確認

1. `npm run check:dsh`で認証付き一覧を確認する。
2. Telegramで`/whoami`の本人IDを確認し、許可設定へ反映する。
3. 待機中の既存セッションへbindし、前述の`REMOTE_BOT_OK`指示を一度だけ送る。
4. `/status`が受付済み→実行中→完了になること、`/result`と完了通知、DSH GUIの同じターンが一致することを確認する。
5. 未許可ユーザーとグループから指示が実行されないことを確認する。
6. Botを再起動し、最新状態と同じ実行IDの結果を確認する。
7. 同時起動を使う場合は、別サービスの実行結果を取得できないことと、同じDSHセッションへの追加送信が拒否されることを確認する。

実サービスでの確認が済むまでは、機密情報を含まない・ツールを使わない指示で試してください。[検証記録](<verification.md>)／[DSH接続契約](<dsh-connection.md>)。

## 参考

- [Telegram Bot API](<https://core.telegram.org/bots/api>)：getUpdates、getMe、getWebhookInfo、sendMessage、sendDocument、setMyCommands。
- [受信方式と更新保持期間](<https://core.telegram.org/bots/api#getting-updates>)。
- [getUpdatesとoffset](<https://core.telegram.org/bots/api#getupdates>)。
- [Bot作成ガイド](<https://core.telegram.org/bots/features#botfather>)。
