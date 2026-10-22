# Discord Remote Agents

**Discordから、PCのDSHで開いている会話を続けるプラグインです。**

既存のSessionを選んで指示を送り、実行状況や結果を確認できます。新しいSessionの作成、最終回答の分割DM配信、通知先の設定・配送の再試行を実装しています。

**操作は許可したサーバーのチャンネルから行います。DMは通知・結果の受信専用で、DMから指示を送ることはできません。**

> **開発プレビューです。** DSHへのローカル導入、日本語設定画面、Host状態の取得は確認しましたが、Discordとの実往復と新しい接続通知は未検証です。完成版ではありません。作業中の変更がGitHub配布版やインストール済みの版に反映されているとは限りません。

## 必要なもの

- Windows上で動作するDSHと、利用可能なモデル。契約の調査対象はDSH **0.2.0-rc.2**です。
- 自分が管理するDiscordサーバーとBot。
- 導入時のインターネット接続。実行環境はNode.js **22.23.0以上**が必要です。

## 1. DSHに追加する

DSHの **Plugins → プラグイン追加** に、次を入力します。

```text
github:git-haya-ora/dsh-discord-remote-agents
```

導入結果を確認してDSHの画面を再読み込みし、このプラグインの設定を開きます。再起動を求められた場合は、実行中の作業を終えてから通常の方法で再起動してください。

ソースのダウンロード・ビルド・設定ファイルの編集は不要です。上の指定は最新版を取得します。版を固定したい場合だけ、末尾に `#コミットSHA` を付けます。

**npmレジストリへは公開していません。** 上記のGitHub指定を使ってください。`private: true` はnpmへの誤公開防止設定で、GitHubからの導入を禁止するものではありません。

旧 `@local/dsh-discord-remote-agents` を使っていた場合は、先にその接続を停止してプラグインを無効にしてください。新旧を同時に動かさないでください。

## 2. Discord Botを用意する

1. [Discord Developer Portal](https://discord.com/developers/applications)でApplicationとBotを作成します。
2. **Application ID**を控え、Botの画面で**Bot token**を発行します。tokenは後でDSHの設定画面に入力します。
3. OAuth2の招待URLで `bot` と `applications.commands` を選び、自分のサーバーへBotを招待します。使うチャンネルを閲覧・送信できる権限を付けてください。管理者権限とMessage Content Intentは不要です。
4. Discordの **ユーザー設定 → 詳細設定 → 開発者モード** を有効にします。サーバー、自分のユーザー、使うチャンネルをそれぞれ右クリックしてIDをコピーします。

**tokenをチャットやIssueに貼らないでください。** 一度でも公開したtokenは再発行してください。

## 3. DSHで設定して接続する

プラグインの設定画面に、次を入力します。

| 項目 | 入力するもの |
|---|---|
| Bot token | 発行したtoken。パスワード欄にだけ入力 |
| Application ID | Developer PortalからコピーしたID |
| サーバーID | Botを招待したサーバーのID |
| 許可ユーザーID | まずは自分のIDだけ |
| 許可チャンネルID | Botを使うチャンネルのID。スレッドならスレッド自体のID |
| 作業フォルダー | **任意。空欄のまま接続できます。** 接続後にDiscordコマンドで追加できます |

**設定を保存 → Discordにコマンドを追加 → 接続を開始** の順に進めます。保存だけでは接続しません。

tokenは送信時に入力欄から消えます。保存済みtokenを表示する機能はありません。以後、token欄を空にして保存すれば、保存済みのtokenをそのまま使います。

### 接続できたことをDiscordで受け取る（作業版 restricted.8）

設定画面の **「接続できたことをDiscordへ通知」** で、DM・許可チャンネルを個別に選んで保存します。初期状態は両方オフです。両方を選ぶと、接続成功後に両方へ1回ずつ通知します。**チャンネルへの通知は、そのチャンネルの参加者にも見えます。** DMは許可ユーザー全員、チャンネルは許可チャンネル全てが対象です。

通知にはDSHへの接続成功、選択済みのプロジェクト別名・Session名／ID、Nativeで観測できた直近の使用モデル・推論レベルと次回設定モデルを載せます。直近の使用モデルと次回の設定は別で、現在の実行状態を保証しません。未選択・未取得を推測で埋めず、別のSessionを自動選択しません。DMには最大3チャンネルの選択先を載せ、残りは `/agent current` で確認します。本文や履歴は読みません。絶対パスの出力を避けますが、Session名などのメタデータ自体に秘密を書かないでください。

通知はReceiver起動が成功した後に送ります。状態更新・Gatewayの自動再接続では送り直しません。送達が不明でも通知を自動再送・別の宛先へ転送せず、Nativeへの指示も再実行しません。通知の失敗や遅延は接続失敗として扱いません。DSHが落ちた場合、同じ通知の配送を復元・再開する機能はありません。次回の明示的な起動／有効化済み自動起動は、新たな接続通知の対象です。

この追加は未公開の作業版です。インストール済みの restricted.7 や公開済みGitHub版には、まだ反映していません。

## 普段の使い方

許可したチャンネルで操作します。`SESSION_ID`・`RUN_ID`・`指示`は実際の値に置き換えてください。SessionはDSHの会話、Runはこのプラグインから送った1回の指示に対応します。

### 会話を選んで指示する

| やりたいこと | コマンド例 |
|---|---|
| 現在のSession・作業先・通知先を見る | `/agent current` |
| 利用可能なmodel候補を検索する（read-only） | `/agent models query:名前 page:1` |
| 待機Sessionのtitleを変更する（Native CASなし） | `/agent settings title value:名前 confirm-no-cas:true` |
| 接続後に作業フォルダーを許可する | `/agent workspace-add alias:main path:C:\Work\repo confirm-access:true` |
| 許可済みの作業フォルダーの別名を見る | `/agent workspaces` |
| 既存のSessionを見る | `/agent sessions` |
| Sessionを検索する | `/agent sessions query:名前 page:1` |
| 続けるSessionを選ぶ | `/agent bind session:SESSION_ID` |
| 新しいSessionを作成して選ぶ | `/agent new workspace:main` |
| 指示を送る | `/agent prompt text:指示` |
| 選択だけ解除する | `/agent unbind` |

まず `/agent sessions` → `/agent bind` → `/agent prompt` の順に使います。Session IDは一覧の完全なIDを指定してください。新規作成の場合は `/agent new` の後に `/agent prompt` を使います。作業フォルダーが未設定なら、最初に `/agent workspace-add alias:main path:C:\Work\repo confirm-access:true` でPC上の既存フォルダーを許可してください。登録前は作業用Sessionの表示・選択・作成・指示が許可されませんが、接続・ヘルプ等は利用できます。フォルダー登録は許可ユーザー・サーバー・チャンネル限定で、既存の別名は上書きしません。パスはDiscordに送信されるため、秘密の文字列を含めないでください。登録は設定版を更新して保存しますが、既存Session・Run・tokenは変更しません。GUIに未保存の変更がある場合は再取得してから保存し直してください。今後の自動起動は解除されるため、必要ならGUIで再確認します。フォルダー許可はOS sandboxではありません。

**Sessionの選択はチャンネル内で共有されます。** 他の許可ユーザーの操作にも影響するため、送信前に `/agent current` で対象を確認してください。`unbind` は会話や実行中のRunを削除しません。

### 実行状況と結果を確認する

| やりたいこと | コマンド例 |
|---|---|
| 最新のRunの実行・配送状態を見る | `/agent status` |
| 自分がこのチャンネルから送ったRunを見る | `/agent tasks` |
| 完了したRunを絞り込む | `/agent tasks state:succeeded page:1` |
| 最新のRunの途中出力・最終回答を見る | `/agent result` |
| 指定Runの結果を順に読む | `/agent result run:RUN_ID page:2` |
| 接続と対応機能を診断する | `/agent diagnose` |
| 使い方・未対応機能の理由を見る | `/agent help` |

`status` と `result` の `run` を省略すると、自分が同じ操作元から送った最新のRunを参照します。Session全体の過去の会話履歴を表示する機能ではありません。

## 最終回答のDM配信と通知設定

このプラグインから受け付けたRunが完了すると、**既定では指示を送った本人へ最終回答をDMで自動配信**します。長い回答はRun ID・part番号付きの複数メッセージに分割します。Nativeから同じturn/step内で当該Run固有の `rpcId` を持つ user/message append を観測した後、Runに固定したDMまたは元チャンネルへ「作業中」を1回だけ送ります。受付・キュー時点では送信せず、開始証拠不足・混入・同じpoll中の完了時は抑制します。送信結果不明は自動再送しません。途中経過の自動通知は未対応です。

- 1メッセージは見出しを含め2,000 UTF-16単位以内です。改行・コードの本文を保持し、mentions・埋め込み表示を抑制します。
- 自動配信は**100,000 Unicode code points（Unicode文字）かつ128メッセージまで**です。上限を超える場合は「全文配信未完了」と案内します。上限を超えた結果も `/agent result run:RUN_ID page:番号` で順に参照できますが、本文を復元できない場合は取得不能と表示します。
- DM拒否や権限不足でも、公開チャンネルなど別の宛先へ自動転送しません。**Runの実行状態と配送状態は別**です。DMが届かないことだけを理由に指示を再送しないでください。

| やりたいこと | コマンド例 |
|---|---|
| 通知先・未送信・不明な配送を確認する | `/agent notifications show` |
| 今後の通知先を本人DMにする | `/agent notifications set destination:dm` |
| 未完了の配送だけ再試行する | `/agent notifications retry delivery:RUN_ID` |

通知先の変更は**今後受け付けるRunだけ**に適用され、既存Runの宛先は変わりません。許可した元チャンネルへの配信を選ぶ場合は `destination:origin` を使い、表示された公開範囲を確認して `confirm-origin:true` を明示する必要があります。回答がチャンネルの閲覧者に見える点に注意してください。

配送の成否が不明な `unknown` は、自動では再送しません。再試行する場合も、実際の受信内容を確認し、**重複する可能性を了承したときだけ** `confirm-duplicate-risk:true` を指定してください。`part` で対象を指定できますが、送信順序を飛ばして配送することはできません。配送の再試行でDSHへの指示は再実行されません。

旧 `/agent notify run:RUN_ID` は通知再試行の互換入口です。不明配送の確認付き再試行には `/agent notifications retry` を使ってください。配信の詳細と保持の制約は[全文配送の説明](<docs/full-output.md>)を参照してください。

## 未対応の機能と制限

下記の未対応項目は、`/agent help topic:機能名` でも理由を確認できます。カタログ表示・タイトル変更・Run開始通知など実装済みの部分と、正式契約や実機検証が残る機能を分けています。

- モデル選択・推論レベル変更、設定リセット、実際のcontext使用量・上限、Session全体の会話履歴。`/agent current` はNativeが返す直近リクエストmodelと次回設定を区別して表示しますが、現在実行中のmodelやcontext消費とは断定しません。
- DMからの操作、通常メッセージの自動実行、途中経過の自動通知。
- Run指定停止、リモート承認回答、共有Desktopとの原子的FIFO queue、任意ファイル・Artifact送信、会話圧縮。Native側の関連APIの一部は確認されていますが、Runスコープ・耐久性・認可・unknown/no-replayを満たすDiscord機能はまだ提供しません。

`/agent models` はNative model catalogのread-only検索です。`/agent settings title value:<title> confirm-no-cas:true` は選択中の待機Sessionのタイトルを変更しreadbackを確認しますが、Native title CASがなくDesktopとの同時変更を保護できません。model/reasoning選択APIはHost既定も変更するため使いません。`/agent new` は作業フォルダー別名だけを受け付け、title/model/effort指定はできません。Native create自体は実行されてから新Sessionのmodern-page契約をprobeするため、probe失敗時は作成済みSessionが未bindで残る可能性があります。Telegramの追加開発も対象外です。

結果本文の再取得は同じNative履歴の可用性に依存します。Bridge側の本文参照期限は完了から7日ですが、Native履歴の削除や全文の保護保存・保持を保証するものではありません。履歴が失われた場合、別の回答で代用せず取得不能と表示します。

## 困ったとき・安全な使い方

- **PCとDiscordは同じSessionを交互に使ってください。** 同時送信の完全な排他は保証できません。
- **承認・実行停止・添付ファイルの操作はPC側で行います。** プラグインの「停止」はDiscord接続を止めるだけで、DSHの実行は止めません。
- **`unknown`は受付・配信の成否を確定できない状態です。** 自動再送はしません。PCで元のSessionを確認し、データベースを消して再送しないでください。
- **`minimumReleaseAge`で導入が止まる場合**は、DSH側の依存パッケージ待機制限です。npm方式への変更でも解消しません。制限を無効にして進めないでください。
- **設定の保存や権限の検査で止まる場合**は、安全確認に失敗しています。保存領域の権限を無理に緩めないでください。

このプラグインはPCのDSH実行権限を使います。許可する相手は信頼できる人だけにしてください。許可フォルダーの設定はOSのサンドボックスではありません。tokenはWindowsのCurrentUser DPAPIで保護しますが、会話や結果に含まれる秘密をすべて検出できるわけではありません。

詳しい安全上の制約は[セキュリティ方針](<SECURITY.md>)を参照してください。[配布ファイルのSHA256一覧](<MANIFEST.sha256>)は内容の照合用で、安全性を保証する署名ではありません。

## 開発はこちらで行います

**このリポジトリが、今後のソース開発・テスト・配布の正本です。** 配布専用リポジトリから、ソースを含む開発リポジトリへ統合しました。過去の非公開リポジトリのGit履歴やローカル設定は取り込んでいません。

- [開発手順とソース／配布物の関係](<docs/canonical-development.md>)
- [仕様](<specification.md>)、[開発者向け安全ルール](<AGENTS.md>)
- [統合検証記録と未検証事項](<docs/integration-verification.md>)

Node.js 22.23.0以上で `npm ci --ignore-scripts`、`npm test` を実行します。`npm run build` はソースからルートのインストール用ファイルも再生成します。GitHub指定でのインストールにソースビルドは不要です。配布用の明示的なファイル許可リストから、開発ソース・テスト・ローカル設定を除外しています。npmレジストリへの公開は行っていません。
