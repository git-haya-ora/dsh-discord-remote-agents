# Discord / Telegramを利用したDSHプラグイン型AIエージェント操作システム 詳細仕様書

- 文書バージョン: 1.3（Discord操作コマンド・DM操作案・最終出力配信要求を追加）
- 更新日: 2026-10-14
- 作成日: 2026-10-12
- 対象環境: Windows PC、Discord、Telegram、DeepSeek Harness（DSH Desktop / Web GUI）
- 想定利用者: 主にスマートフォンから、自分のWindows PC上のAIエージェントを操作するユーザー
- 文書の位置づけ: 完成版の要求・設計・受け入れ条件と、現MVPの適合性確認。記載した内部インターフェースは本システムの設計案であり、DSHの公開APIとして実在することを示すものではない。

### 今回の制限版（2026-10-14 利用者合意）

現在のDSHで実装を進めるため、利用者は[制限版プロファイル](<docs/limited-profile.md>)に明示同意した。DSH認証済みGUIの単一operator管理、非atomicな事前busy確認、テキストSession操作と通知を優先し、承認回答・Run指定停止・添付／Artifactは無効にする。正式bundle方式と保護ストア、unknown非再送は維持する。この限定実装に限り、以下の完成版RFC-M/A/Nゲートを実装着手の前提としない。元の完成仕様・ACは削除せず、達成したものとも扱わない。

### 2026-10-14 追加要求：コマンド・個人DM・最終出力

第23章に、モデル／推論レベルなど日常操作に必要なコマンド、サーバー不要の本人DM操作案、最終出力の全文自動配信と受入条件を追加した。今回は仕様追加のみで、実装・公開版の機能追加ではない。現行の本人DMは結果通知専用であり、DMからの指示受付は未対応。DM操作は次期設計対象とし、既存のサーバー運用を勝手に変更しない。第2・7・8・15・21章と競合する追加範囲は第23章を優先し、承認／停止等の現行制限、上流契約・認可・unknown非再送は維持する。

2026-10-15の追加開発は[第23章の実装状況](<docs/chapter23-progress.md>)と[検証記録](<docs/verification.md>)で追跡する。本書の「今回は仕様追記のみ」「現在の実装」は2026-10-14の追加時点を記録したもの。追加ブランチのソース実装で正式契約待ち・DM-only・実機ACの未達を完了へ読み替えない。

### 状態と読み方（完成版の要求）

**設計は条件付き完成、実装・P0・実機受け入れは未完了。** 本書は正式Host／Clientプラグインによる実装から配備・復旧までの規範設計である。第20章だけが旧独立MVPの歴史監査であり、規範の例外ではない。第22章の上流必須契約が正式提供・検証されることを実装解禁／配布のゲートとし、API不足を永久TBDや実装済みに読み替えない。

- Discord先行で開発・受け入れする。Telegramの最終要求・既存コードと回帰試験は保持するが、追加実装と実機受け入れは後続段階へ延期する。Discord先行版を全AC達成の完成版と呼ばない。
- BridgeはHostプラグイン内の論理サービス群を指す。別CLI常駐・ASAR／GUI root改変・別Webサーバーは完成版の配置ではない。
- 本書の型、管理操作名、画面名、エラーは **INTERNAL DESIGN**。既存DSH APIの存在を主張しない。欠けるDSH側能力は **REQUIRED FUTURE CONTRACT** と明記する。
- 第17・21章のAC-01〜33は将来必須試験。本仕様v1.2確定時の履歴は61件中59成功・0失敗・2skip（保護パス拒否により当時のDPAPI／SQLite fixture未検証）。以後の局所fixture・基盤試験と最新件数は[検証記録](<docs/verification.md>)を参照する。Mock／基盤／局所process試験を実機AC合格へ換算しない。
- 「APIキー」はDiscord／Telegram Bot token。利用者パスワード・モデルAPIキーではない。秘密は読戻し・平文fallbackなし。
- AG／SE／TA／DI／SA／PLとACの既存ID・要求を維持する。上流が満たせなければ開発／リリースを停止し、要求変更は別途明示合意を要する。

## 1. 目的と基本方針

DiscordからWindows PC上のAIエージェントに指示を送り、PC側と同じセッションを継続しながら、進捗、結果、承認要求、成果物を確認できるようにする。

1. 初期対応エージェントはDSH Desktopとする。
2. DiscordとDSHは**同一のネイティブセッション**を参照する。会話をコピーして作った別セッションは「共有」とみなさない。
3. エージェント固有処理をAdapterに分離し、将来OpenCodeなどを追加できる構成にする。
4. Windows PCからDiscordへの外向き接続を基本とし、インターネット向けの待ち受けポートは不要とする。
5. 認可、承認、重複防止、復旧を最初から設計する。接続断や状態不明を成功・完了として扱わない。
6. 未対応機能は明示する。画面上の文字列推測や会話ログへの直接書き込みで、機能が実現したように見せない。

### 1.1 用語

| 用語 | 意味 |
| --- | --- |
| Agent / エージェント | DSH、OpenCodeなどの実行基盤。同種の複数インスタンスも個別に登録できる |
| Adapter | 基盤固有の操作を共通インターフェースに変換する実装 |
| Bridge | DSH Hostプラグイン内のTransport、Adapter、永続化、実行制御サービス群（独立常駐アプリではない） |
| Native session | エージェント本体が管理する正式なセッション |
| Binding / 対応関係 | Discordの会話単位と、Agent・Native sessionの関連付け |
| Run / タスク | 1回の指示送信から終了までの実行単位。エージェント内部の子タスクと区別する |
| Conversation / 会話単位 | 通常チャンネル、またはその中の特定スレッド |
| Capability | Adapterが実際に提供できる機能の宣言 |
| Approval | エージェント本体が発行した、特定の操作に対する承認要求 |
| Outbox | Discordへ送る通知を、送信前に永続化するキュー |

## 2. 対象範囲と開発段階

### 2.1 対象範囲

- 1台のWindows PCのDSH Host内で動作する正式Hostプラグインと、既存DSH GUIに導入するClientプラグイン。
- 許可されたDiscordサーバー、チャンネル／スレッド、ユーザーからの操作。
- エージェント登録、切り替え、セッション操作、チャット、タスク制御、承認、添付ファイル、復旧。
- DSH DesktopとDiscordで同じ作業を交互に継続する利用。
- 複数のAgent登録に対応する共通設計。初期リリースで提供するAdapterはDSH用のみ。

### 2.2 初期対象外

- 複数PCへの分散実行、クラウド実行、公開Botサービス、課金管理。
- Discordからの任意のシェルコマンド実行機能。
- DiscordからのAdapterコードのアップロード、インストール、任意URLへの接続。
- DSHの承認ポリシーやサンドボックスをDiscord経由で緩和する機能。
- 音声操作、自動画像生成機能そのもの、一般公開チャンネルへの自動投稿。
- 現行制限版ではDM操作、セッション削除、OSプロセスの強制終了は対象外。本人DM操作のみ第23章で次期設計対象へ追加する。グループDM、セッション削除、OSプロセス強制終了は引き続き対象外。

### 2.3 開発段階

| 段階 | 提供内容 | 完了条件 |
| --- | --- | --- |
| P0: 正規契約検証 | 正式bundle導入、管理主体、共有受付／receipt、Native Session、承認・中断・復旧契約 | 第5・22章の証拠と競合試験を満たす。現状未達 |
| P1: Discordコア | Host／Client上の認可、一覧・作成・切替・履歴、指示・状態・通知、永続化 | P0合格を入口とし実Discord＋Desktop結合試験合格。独立CLIは代替不可 |
| P1.5: 管理・移行 | GUI、秘密transaction、lifecycle、Discord receiver、明示MVP移行 | 管理・秘密・世代制御・migrationの障害試験合格。Telegram追加実装を含まない |
| P2-D: Discord先行受け入れ | 複数登録、component、通常チャット、承認、停止、ファイル、復旧・運用 | AC-01〜42のDiscord該当条件（Telegram単独・両サービス条件を除く）、性能・72時間・配備復旧ゲート合格。完成版全体ではない |
| P2: v1完成版 | P2-Dに加えTelegram単独・両サービス・最終要求 | AC-01〜42の全条件を満たす。Telegram実装開始は別途工程承認 |
| P3: 拡張 | OpenCode Adapter、必要に応じた複数PC対応 | 共通Adapter適合試験と対応基盤の結合試験に合格 |

本人DM操作は第23章の次期Discord設計・検証で扱う。P3まで必ず延期する要件ではないが、現行版で提供済みとは扱わない。

本書の「必須」は、特記がなければP2完了時に満たす要件を指す。DSHが必須機能を提供できない場合、スコープ変更の合意なしにP2完了としない。

## 3. 利用シナリオ

### 3.1 新しい作業を始める

1. 許可チャンネルで `/agent list` を実行する。
2. DSHを選び、`/session new workspace:project-a title:不具合調査` を実行する。
3. BridgeがDSHにセッション作成を依頼し、返されたNative session IDを保存する。
4. 作成したセッションを現在の会話単位に対応付ける。
5. `/ask prompt:テスト失敗の原因を調べて` を送信する。
6. Discordに受付・進捗・結果が表示され、DSH側でも同じ履歴が確認できる。

### 3.2 PCで開始した作業を外出先から継続する

1. `/session list` でDSHの既存セッションを取得する。
2. `/session use id:...` または選択メニューでセッションを選ぶ。
3. 必要に応じて `/history limit:10` で最近の会話を確認する。
4. Discordから追加指示を送り、後でDSH Desktopから同じセッションを継続する。

### 3.3 承認要求に対応する

1. DSHから承認要求イベントが届く。
2. 対象タスク、操作概要、作業場所、リスク、期限を示すカードをDiscordに表示する。
3. 権限のあるユーザーが「今回のみ承認」または「拒否」を押す。
4. Bridgeが要求の有効性を再確認し、DSHへ決定を返す。
5. DSH側の確認を受けてカードを更新する。PC側で先に回答済みなら二重承認しない。

### 3.4 ファイルを使って指示する

1. `/ask` の添付オプション、または有効化済みの作業スレッドに画像／ファイルを投稿する。
2. Bridgeが認可、サイズ、形式を検証し、専用領域にダウンロードする。
3. 対応するAdapterを通じて、指示と添付を同じセッションへ渡す。
4. 生成された成果物は一覧から選び、明示的な操作でDiscordに送信する。

## 4. システム構成

```text
DSH Desktop / 既存Web GUI
  └─ Client plugin（設定・診断・管理状態のみ）
       │ 正規通信 + 上流trusted owner/admin grant
DSH Host（Windows標準ユーザー）
  ├─ Host plugin / Bridge
  │   ├─ Transport認可・Discord Gateway/REST（外向きTLS）
  │   ├─ Binding・Run FIFO・Approval・Artifact・Outbox
  │   ├─ SQLite・監査・Host-only CurrentUser DPAPI
  │   ├─ 管理service・receiver世代／lifecycle
  │   └─ Adapter Registry → 検証済みDSH Host契約
  └─ Desktopとplugin共通のNative Session admission / 実行基盤
      （REQUIRED FUTURE CONTRACT：第22章）
Telegram HTTPS long pollingは後続実装。同じHost Engine/DBを共有。
```

### 4.1 採用する実装配置

| 項目 | 決定 | 検証条件 |
| --- | --- | --- |
| Host / Client | 正式bundle、TypeScript strict、対象DSHが支持するNode LTS | manifest、inject、Client slot、effect、配布ライセンスをP0確認 |
| Discord | discord.js、Gateway受信、Bot REST通知 | lockfileで版固定。調査／試験基準は14.27.0、変更時再試験 |
| 永続化 | Host所有SQLite、明示schema migration、一つのEngine | 対象Windows／Nodeで配布・ロック・バックアップ試験 |
| 秘密 | Host-only Windows CurrentUser DPAPIとSID限定ACL | 正規helper経路・私有パス・journal復旧の実機証拠必須。平文fallbackなし |
| 実行 | DSH Hostのlifecycleに従う。別Bridge起動taskを設けない | GUI閉鎖は継続、Host終了は停止。Session 0／サインアウト継続を仮定しない |
| テスト | 単体、Adapter適合、隔離Host＋検証Discord、障害注入 | 本体改変なし、Mockと実機証拠を分離 |

DSH Host内部の正式契約を優先する。同一Hostの操作のためDSH_TOKENを要求しない。独立HTTP接続は将来の別Profileを正式検証した場合のみで、現完成版の不足契約を回避するfallbackではない。

### 4.2 責任分離

- Discord層: コマンド受付、ボタン／メニュー、表示、Discord権限の確認。
- Application層: 認可、Binding、キュー、承認状態、復旧、監査。
- Adapter層: Native session操作、実行、イベント、成果物、接続障害の変換。
- 永続化層: Agent・Binding・Run・Approval・通知・カーソルをトランザクションで保存。
- エージェント本体: 正式な会話履歴、モデル実行、ツール実行、実際の承認・サンドボックスポリシー。

## 5. DSH連携仕様と技術検証

### 5.1 現時点での確認範囲

初版作成時にはDSH実装ソースを通常のディレクトリとして参照できず、具体APIは未検証だった。その後、インストール済みASAR内のDSH `0.2.0-rc.2`の資料と実装を読み取り調査し、Cookie認証、named-argument RPC、session一覧・作成・prompt・projections・pageをMVPへ実装した。これは対象版の内部接続契約の調査であり、安定した公開APIや他バージョンとの互換性を保証しない。

モック試験と未認証実ホストの401拒否は確認済みだが、実トークンによる一覧、PC→Bot→PCの同一セッション往復、承認・中断・ファイルの実機検証は未完了。[接続契約](<docs/dsh-connection.md>)と[検証記録](<docs/verification.md>)を証拠として参照する。P0全体を完了とはしない。DSHプラグイン拡張資料の調査範囲と未検証事項は第21章に示す。

**DSH Web GUIが存在することと、外部Botから利用できる安定したAPIが存在することは別である。** GUIのURLやポート番号を、正式な外部連携契約として固定しない。

### 5.2 接続手段の優先順位

1. 正式Host／Client bundleから、文書化・互換性保証されたHost契約を使う（採用方式）。
2. CLI／外部HTTP／内部APIの調査結果は契約評価の参考に限定する。未公開内部serviceの存在だけで採用しない。
3. 必須Host契約不足は第22章の上流ゲートへ戻す。別build、ASAR改変、独立CLI制限版、private RPCによる迂回は別途承認なしで採用しない。

UIクリック自動化、画面スクレイピング、会話ログ／内部DBへの直接書き込みは標準方式にしない。CLIで別セッションが生成される方式は、セッション共有要件を満たさない。

<a id="p0-verification"></a>

### 5.3 P0で必ず検証する事項

| 検証項目 | 必要な証拠／判定 |
| --- | --- |
| 接続・認証 | 対象DSHバージョン、接続先、プロトコル、認証、ローカル限定化、起動条件 |
| 一覧・作成・履歴 | 正式なNative session ID、一覧ページング、作成・履歴取得の方法 |
| 同一セッション共有 | Discordから送った指示が既存Desktopセッションへ入り、その後Desktopから継続できる結合試験 |
| 実行受付 | 受付確認、Native run IDまたは同等の相関情報、再送時の重複防止可否 |
| Desktopとの同時操作 | Desktop／Discord共通admissionでbusy判定・duplicate claim・Session予約・enqueueを同一線形化点で確定し、durable receiptを返す正式契約と競合試験。単なるmutex・共通service・状態照会→送信は不適合 |
| 中断 | 指定Runだけの停止、子処理への停止伝播、停止確認、停止不可の場合の状態 |
| 承認 | 要求ID、操作情報、期限、承認／拒否、PC側回答との競合処理、未解決要求の再取得 |
| イベント | ストリーム方式、順序、カーソル、再購読・再取得、完了・失敗判定 |
| ファイル・画像 | 正式な添付登録、モデルへの画像受け渡し、成果物一覧・取得、保存領域 |
| 障害・再起動 | 実行状態の照会、履歴照合、接続断・Desktop再起動後の回復 |

- 検証成果には、使用したDSHバージョンと再現手順を残す。
- 未対応機能はCapabilityをfalseにし、Discordに理由を表示する。
- ネイティブ機能が不足する場合、拡張するか、対応範囲を見直すかを明示的に決定する。
- 特に同一セッション共有・安全な実行受付・承認が未解決なら、完成版の開発可否を先に判断する。

## 6. 機能要件

### 6.1 AIエージェント連携

| ID | 必須要件 |
| --- | --- |
| AG-01 | Discordから許可されたAgent・Sessionへ指示を送れる |
| AG-02 | 応答、最終結果、実行エラーをDiscordで確認できる |
| AG-03 | 複数Agentを登録し、会話単位で選択・切り替えできる |
| AG-04 | 新しいAgentインスタンスを登録できる。新基盤への対応はAdapter追加で行う |
| AG-05 | 接続状態、表示名、基盤種別、対応機能、互換性情報を確認できる |
| AG-06 | Capabilityが不足する操作を、送信前にわかる形で拒否する |

Agent選択は会話単位の既定Agentを変更する。既存BindingのAgentを暗黙に変更しない。Bindingがある場合は、明示的なセッション選択／解除を求める。

同じネイティブ実行基盤を別名・別Profileで重複登録して、排他やBindingの一意制約を回避できないようにする。Adapterが確認した基盤識別情報とPC側Profileの正規化を用い、重複は拒否する。独立した基盤と確認できない登録は、新しい独立Agentとして扱わない。

### 6.2 セッション管理

| ID | 必須要件 |
| --- | --- |
| SE-01 | エージェント本体の既存セッションを、検索・ページング付きで一覧表示する |
| SE-02 | 選択した既存セッションで追加指示を実行できる |
| SE-03 | 許可済みWorkspaceを選んで新規セッションを作成できる |
| SE-04 | Discordとエージェント本体が同一Native sessionを参照する |
| SE-05 | Bindingを明示的に切り替え、現在のAgent・Sessionを常に確認できる |
| SE-06 | 会話履歴を、ロール・時刻・添付情報とともにページング表示する |
| SE-07 | Sessionの削除・権限変更・取得失敗を検出し、不正なBindingへの送信を停止する |

### 6.3 タスク管理

| ID | 必須要件 |
| --- | --- |
| TA-01 | 実行中、待機中、承認待ち、中断処理中、完了、失敗、不明を確認できる |
| TA-02 | 実行中タスクを対象ID指定またはボタンで中断できる |
| TA-03 | 完了・エラー・中断結果を、Run受付時に保存した会話単位へ通知する |
| TA-04 | 15分を超えるタスクも、Interaction tokenに依存せず追跡・通知できる |
| TA-05 | エージェント本体からの承認要求に、権限のあるユーザーが承認／拒否できる |
| TA-06 | 実行中の追加指示をキュー投入または拒否する。割り込み指示は別機能として扱い初期対象外 |
| TA-07 | Desktop側で開始したタスクも、Adapterが観測可能なら状態・イベントを共有する |

### 6.4 Discord操作

| ID | 必須要件 |
| --- | --- |
| DI-01 | スラッシュコマンドで全主要機能を操作できる |
| DI-02 | Agent・Session選択、ページ送り、中断、承認をボタン／選択メニューで行える |
| DI-03 | 明示的に有効化した会話単位で、通常メッセージを指示として送れる |
| DI-04 | ファイル・画像を送信でき、成果物ファイル・画像を受信できる |
| DI-05 | モバイル表示で、対象Session、状態、次の操作が短いカードでわかる |

### 6.5 セキュリティ・安定性

| ID | 必須要件 |
| --- | --- |
| SA-01 | 許可ユーザー・サーバー・会話単位だけに操作を許可する |
| SA-02 | 外部公開APIなしで利用でき、秘密情報・任意接続・パス逸脱を防止する |
| SA-03 | Discord／Agentの切断を検知し、再接続・状態再照会を行う |
| SA-04 | 再起動後もAgent設定・Binding・Run・Approval・通知を復元する |
| SA-05 | 不明な実行結果を自動再送せず、二重実行を避ける |
| SA-06 | 操作と拒否理由を秘密情報抜きで監査できる |

## 7. Discordコマンド・UI

### 7.1 共通ルール

- コマンド名は英語、説明・応答は日本語を標準とする。
- IDは表示上短縮してよいが、処理には完全なIDを使う。短縮IDは一意に解決できない場合に拒否する。
- 長い一覧はページングし、メニューの件数上限を超えない。
- 非許可ユーザーへの応答はephemeralとし、Session名・履歴・接続先を漏らさない。
- 管理・履歴・一覧の応答は原則ephemeral。Run進捗・結果は承認済みの専用会話単位へ投稿する。
- 破壊的または公開を伴う操作は確認ステップを設ける。
- ボタンの対象は作成時のRun／Approval／Binding IDで固定し、「現在のセッション」を後から参照し直さない。
- 指示本文は既定20,000文字までとし、各入力UIの制限が小さい場合はそちらを優先する。超過は説明付きで拒否し、黙って切り詰めない。長文は許可形式の添付に案内する。

### 7.2 コマンド一覧

以下は完成版の従来論理コマンドであり、現在すべて登録済みではない。次期Discord操作は第23.2節の `/agent` 系統を正規名とし、本表の同じ機能はalias／移行対象として扱う。二重の独立実装や別のRun受付経路を作らない。引数は論理仕様で、Discordの登録上限に合わせ、サブコマンドやModalに分割してよい。

| コマンド | 主な引数 | 動作 | 権限 |
| --- | --- | --- | --- |
| `/help` | topic | 利用方法、現在の会話単位、対応機能を表示 | viewer以上 |
| `/agent list` | page | 許可された登録Agent一覧 | viewer以上 |
| `/agent use` | id | 会話単位の既定Agentを選択 | operator以上 |
| `/agent info` | id | 状態・Capability・互換性を表示 | viewer以上 |
| `/agent register` | profile, name | PC側で事前定義した接続Profileを登録 | admin |
| `/agent disable` | id | 新規受付停止。実行中Runは確認なしに終了しない | admin |
| `/agent unregister` | id | 未使用Agent登録解除。関連が残る場合は拒否 | admin |
| `/session list` | agent, query, page | Native session一覧。現在選択中を明示 | viewer以上 |
| `/session new` | agent, workspace, title | 新規Native session作成とBinding | operator以上 |
| `/session use` | agent, id | 既存セッションの選択。切り替え先を確認 | operator以上 |
| `/session current` | なし | 現在のBinding・既定Agent・実行状況 | viewer以上 |
| `/session unbind` | なし | 会話単位のBinding解除。Run・Native sessionは削除しない | operator以上 |
| `/history` | limit, cursor | 現在のセッション履歴。既定10件、最大50件 | viewer以上 |
| `/ask` | prompt, attachment | 指示送信。初期は添付1件、通常チャットは複数件対応 | operator以上 |
| `/status` | run | 指定Run、または現在のセッションの状態 | viewer以上 |
| `/tasks` | state, page | 認可範囲内の実行中・待機中・最近のRun | viewer以上 |
| `/stop` | run | Run中断要求。停止確認までは中断処理中と表示 | operator以上 |
| `/queue list` | なし | 会話単位から受け付けた待機指示一覧 | viewer以上 |
| `/queue cancel` | run | 未実行Runを取消。実行済みなら停止操作へ案内 | operator以上 |
| `/approval list` | run | 有効な承認要求一覧 | approver＋対象閲覧権限 |
| `/approval decide` | id, decision | ボタンが使えない場合の承認／拒否 | approver＋対象操作権限 |
| `/chat enable` | なし | この会話単位の通常メッセージ転送を有効化 | operator以上 |
| `/chat disable` | なし | 通常メッセージ転送を停止 | operator以上 |
| `/files list` | run, page | 許可範囲の成果物一覧 | viewer以上 |
| `/files send` | artifact | 確認後、成果物を現在の許可会話単位へ添付 | operator以上 |
| `/bridge health` | なし | 接続、通知滞留、DB、バージョン、復旧状態 | admin |
| `/bridge notifications retry` | delivery | 送信失敗通知を再試行。実行指示は再送しない | admin |

### 7.3 UIカード

- Agentカード: 表示名、接続状態、対応機能、「選択」「詳細」。
- Sessionカード: タイトル、更新日時、Workspaceの別名、状態、「このセッションを使う」。
- Runカード: Run ID、Agent／Session、状態、開始時刻、経過時間、最新の短い進捗、「状態更新」「中断」。
- Approvalカード: 要求ID、関連Run、操作、リスク、期限、「今回のみ承認」「拒否」。
- 終了カード: 完了／失敗／中断、要約、所要時間、成果物一覧への導線。

状態更新は既存カードの編集を優先する。進捗の全イベントを新規メッセージとして投稿しない。色だけに依存せず、状態名と記号を併記する。

### 7.4 通常チャット

- 明示的な有効化とBindingが揃った会話単位だけを対象とする。
- Bot自身、Webhook、他Botのメッセージを無視してループを防ぐ。
- サーバーで通常メッセージ本文を取得する場合はMessage Content Intentの設定と、必要時のDiscord承認を確認する。
- Intentが利用できなくても `/ask` と添付オプションは動作する。
- 各メッセージの投稿者を毎回認可する。チャンネル閲覧権限だけでは実行を許可しない。
- Bot停止中に投稿された指示は原則自動実行しない。履歴取得が可能なら未処理候補として表示し、再送・実行を利用者が確認する。
- 投稿後の編集・削除を、既に送信した指示の変更・取消とみなさない。
- 返信先メッセージから別Sessionを自動選択しない。Binding外への送信は明示操作に限定する。

### 7.5 Discordの制約への対応

- Interactionは受信後3秒以内に初期応答が必要。処理に時間がかかる場合は先にdeferする。内部目標は1秒以内。
- Interaction tokenの有効期間は15分。長時間Runの進捗・完了はBot認証の通常メッセージとして送信し、そのmessage IDを保存する。
- Interaction受信はGateway方式を採用し、公開Interactions Endpointは設けない。Gateway受信でもInteraction応答はHTTP APIを使用する。
- 通常メッセージ本文は2,000文字を上限に分割する。コードブロックは再開・閉鎖し、順序番号を付ける。巨大な出力は要約とテキスト添付に切り替える。
- 添付上限は固定のDiscord全体上限を仮定せず、Interactionの `attachment_size_limit` など、その送信経路で確認できる制限とローカル設定の小さい方を使う。
- レート制限はSDKと応答ヘッダーに従う。429では `Retry-After`／`retry_after` を尊重し、無限即時再送しない。
- Agent出力は `allowed_mentions` を抑制し、`@everyone`、ロール、任意ユーザーへの通知を発生させない。完了通知の利用者メンションだけを明示許可できる。

## 8. セッション共有・対応関係

### 8.1 Bindingのキーと一意性

```text
DiscordConversationKey = (transport=discord, botId, guildId, channelId, threadId | null)
TelegramConversationKey = (transport=telegram, botId, privateChatId)
Binding = ConversationKey → (agentId, nativeSessionId, version)
NativeSessionKey = (verifiedBackendIdentity, nativeSessionId)
```

- 通常チャンネルと個々のスレッドは別の会話単位とする。
- 1会話単位には有効なBindingを最大1件だけ持つ。
- 1つのNativeSessionKeyは、全Transport・Bot・Agent別名を横断して有効Binding最大1件。DiscordとTelegramへの同時Bindingは禁止する。切替には旧Binding解除と明示確認を要し、旧Run／Approval／通知先は不変。Backend identity未証明のProfile追加は拒否する。
- 会話単位での選択は、その会話単位を利用する全員に共有される。ユーザーごとに別の「現在のセッション」を暗黙に持たない。
- 同じチャンネルで並行作業したい場合はスレッドを分ける。ただしスレッド分離を認可の代替にしない。
- Discordから選択しても、Desktopの画面選択を強制変更するとは限らない。「共有」は同一Native sessionへの操作を意味する。

### 8.2 切り替え時の扱い

- 切り替えはBindingのversionを使った比較更新で行い、競合時は再選択を求める。
- Run受付時にAgent、Native session、送信先、Binding versionをスナップショット保存する。
- 切り替え後も、実行中Run・承認・結果通知は元の対象と送信先に紐づく。
- 待機指示も受付時のSessionを維持する。切り替えで新Sessionに移し替えない。
- 実行中／待機中Runがある場合、切り替え確認画面に残るRunを表示し、継続か待機分取消を選ばせる。
- 権限が失われた通知先への投稿は停止する。別チャンネルへ勝手に転送しない。

### 8.3 履歴

- 正式な履歴はAgent側を正とする。Bridgeのキャッシュを独立した会話履歴として扱わない。
- 初期表示はユーザー発言・最終応答中心。ツール出力は折りたたみ／別ページとし、内部推論や非公開フィールドを要求しない。
- Desktop側の追加発言はイベントまたは再取得で反映する。
- セッション名・履歴の検索対象は、登録Agentと許可済みWorkspace／Sessionの範囲に限定する。
- PC側に存在するすべての履歴をDiscordに公開しない。

## 9. Run・実行制御

### 9.1 状態モデル

| 状態 | 意味 |
| --- | --- |
| `queued` | 永続化済み、まだAgentに送信していない |
| `dispatching` | Agentへ送信中。受付成否が未確定 |
| `accepted` | durable receiptでNative受付が確定したが、実行開始は未確認。Session予約を保持する |
| `running` | Native startedイベントまたは正式statusで対象Runの実行開始を確認した |
| `waiting_approval` | 有効な承認要求があり、実行が待機している |
| `cancelling` | 中断要求を送ったが、停止確認前 |
| `completed` | Agentから正常終了が確認された |
| `failed` | Agentから失敗、または受付前の確定的失敗が確認された |
| `cancelled` | 未実行の取消、またはAgentが中断終了を確認した |
| `unknown` | 接続断・再起動などで実行状態を確定できない |

```text
queued → dispatching → accepted → running ⇄ waiting_approval
queued → cancelled
accepted / running / waiting_approval → cancelling → cancelled
accepted / running / waiting_approval / cancelling → completed / failed
accepted → waiting_approval（Nativeの対象Run承認待ちを正式確認した場合のみ）
送信成否・実行状態が不明 → unknown → 再照会で確認できた状態
```

受付receiptだけでrunningにしない。acceptedからのtarget cancelは未開始RunのNative予約／enqueue取消と終了確認を要求し、確認前はcancellingで後続を止める。startedを取り逃しても対象Runの正式terminalがあればacceptedから直接終了確定できる。不明ならacceptedを成功／未実行と推測せずunknownへ移す。中断と完了の競合はAgentの確定結果を採用し、切断状態を別表示する。確定terminalを古いイベントで巻き戻さない。

### 9.2 排他・キュー

- 原則、`(agentId, nativeSessionId)` ごとに同時実行Runは1件。
- Agent全体の同時実行数は設定する。初期既定値は1。
- 実行中の指示は、セッション単位のFIFOキューに入れ、順番と対象Sessionを表示する。
- キュー上限は既定10件／Session。超過時は受付拒否し、保存前に説明する。
- Desktop・全receiverの実行は共通NativeSessionKeyの原子的受付境界を通す。busy判定・予約・enqueueを同じ線形化点で確定する正式契約を必須とし、plugin-only mutexや状態照会→送信を代替にしない（第22.2節）。busyは既存RunへsteerせずFIFO待機に戻す。
- 受付直前にSession状態、認可、Agent有効性、Workspace許可を再確認する。
- Agent停止・認証失敗・互換性不足・状態不明中は新規指示受付を拒否する。既存queuedは保持してpauseし、復旧時に認可・Session・Workspaceを再検証する。停止中の新指示を暗黙に取り込まない。

### 9.3 二重実行防止

1. Discord interaction IDまたはmessage IDを入力の重複排除キーにする。
2. Runレコードと受付キーをトランザクションで作成する。
3. Agent送信前に `dispatching` を保存する。
4. 安定した `clientRequestId` とpayload digestを必須で渡す。同じIDの同時要求を原子的に重複排除し、異なる本文のID再利用を拒否する正式契約をP0で検証する。
5. 受付確認後、Native run IDまたは相関情報を保存する。
6. 受付確認前に切断した場合、状態・履歴・相関キーを照会する。
7. 実行されていないことを確認できない限り、自動再送しない。`unknown` の手動対応も第22.3節の証拠付き照合に限定し、証拠なしの強制成功／未実行解除／新ID再送は認めない。

外部AgentとDiscordをまたぐ完全なexactly-onceは保証しない。重複排除と照会によって通常の重複を防ぎ、曖昧なケースを隠さない。

### 9.4 進捗と長時間実行

- イベントに基づき、最新の操作概要、待機理由、経過時間を表示する。
- Agentが提供しない進捗率、完了予測、トークン数を推測して表示しない。
- 進捗カード編集は既定2秒以上の間隔でまとめ、レート制限時はさらに間引く。
- 60秒以上意味のある出力がない場合も、状態照会が成功していれば「実行中・最終出力から○秒」と表示できる。
- 初期は実行時間の上限を設けない。管理者が上限を設けた場合、満了時は中断要求を送り、即座に中断済みとはしない。
- 通知失敗とAgent実行失敗は別状態で管理する。

<a id="run-cancellation"></a>

### 9.5 中断

- `/stop` は対象Runへの正規の中断要求とする。
- 15秒で停止確認が取れない場合、「停止未確認」と通知し、`cancelling` または `unknown` を維持する。
- 後続Runは停止確認まで開始しない。
- 承認待ちの中断は、未解決Approvalを無効化し、Agent側状態と照合する。
- 子プロセス・子Agentが残る場合はその事実を表示する。
- 共有DSHプロセスやPC全体を終了する方式で中断を代替しない。

<a id="native-approval"></a>

## 10. 承認要求

### 10.1 原則

- 承認はAgent本体から発行された正規の要求だけを扱う。AIの文章に「承認してください」とあるだけでは承認ボタンを生成しない。
- BridgeはAgent本体のポリシーを上書きしない。
- Agentが「承認不要」のポリシーなら、それを状態表示し、Bridge独自のボタンが実行を保護していると誤認させない。
- Agentが承認を許可しない／要求を発行しない設定なら、Discord操作によって制限を回避しない。
- 初期対応は要求ごとの一回限りの承認。常時承認、包括承認、以後すべて承認は提供しない。

### 10.2 表示と認可

- Request ID、Agent・Session・Run、要求発行時刻、期限を表示する。
- 操作の種類、対象パス／接続先の安全な表示、コマンドまたは変更概要、権限拡張の有無を示す。
- 秘密を含む引数はマスクし、詳細が不足する場合はPC側で確認するよう案内する。
- 承認カードはRunに記録された認可済み会話単位へ投稿する。必要に応じて詳細はephemeralで取得する。
- 決定者はapprover権限と当該Agent・Sessionの操作権限を両方持つ必要がある。

### 10.3 状態と競合

```text
pending → deciding → approved / rejected
pending / deciding → resolved_external / expired / invalidated
```

- ボタンには短い不透明なトークンを使い、DB側でRequest・Run・送信先・期限・versionへ解決する。
- 二重クリック・別ユーザーの同時回答・PC側の回答を、比較更新とAgent側確認で制御する。
- `deciding` は決定送信中であり、Agent確認前に「承認済み」としない。
- 送信後に応答が失われた場合、未解決要求を再照会する。無条件にもう一度承認を送らない。
- 古いボタン、期限切れ、Run終了、権限喪失、別チャンネルからの操作は拒否する。
- 再起動後は正規の未解決要求を照会し、一致するカードを復元する。

### 10.4 期限・障害時の動作

- Agent側の期限があればそれを優先し、Bridge側は既定10分の上限を設ける。
- 期限到達で自動承認しない。拒否可能なら拒否を送り、確認できない場合は実行の中断を試みる。
- 拒否／中断を確認できない場合は「期限切れ・Agent側未確認」と通知し、後続指示をブロックする。
- Discord切断中もAgent側の期限・ポリシーに従う。Discordが戻ったら未解決要求を再照会する。

## 11. ファイル・画像送受信

### 11.1 受信

- コマンド添付または有効化済み会話単位の添付だけを受け付ける。
- 認可済みDiscordイベントに含まれる添付URLだけを取得し、任意URLダウンロード機能は設けない。
- HTTPS、Discordの正式な添付配信元、リダイレクト先を検証する。Private IP、localhost、予期しないホストへのアクセスを拒否する。
- 添付配信元の許可リストは公式仕様に合わせて管理し、添付URLを長期参照先として保存しない。
- 専用保存領域へUUID等の内部名で保存し、元ファイル名は表示用メタデータとする。
- Content-Lengthに依存せず、ストリーミング中の実バイト数・タイムアウトで制限する。
- 保存上限は既定20 MiB／ファイル、5ファイル／指示、合計50 MiB／指示。送信経路・Agent側の上限が小さい場合はそちらを優先する。
- 形式は初期設定でUTF-8テキスト、Markdown、CSV、JSON、PDF、PNG、JPEG、WebPを許可する。Agent対応状況を別途確認する。
- 拡張子だけでなくMIME・内容も検証する。画像はデコード可能性とピクセル数上限を検証する。
- 実行形式、ショートカット、スクリプトなどは既定拒否。受信ファイルをBridgeが実行しない。
- アーカイブ展開は初期対象外。許可する場合はzip slip、展開サイズ、ファイル数を別途制限する。
- ウイルス検査の連携は推奨。未導入なら「検査済み」と表示しない。
- 添付保存またはAgent登録に失敗した場合、本文だけを黙って実行しない。失敗を示し、本文のみで進めるか確認する。

### 11.2 Agentへの受け渡し

- Adapterの正規添付機能を使い、Native attachment IDなどを取得する。
- Workspaceにコピーする方式しかない場合は、許可領域内の専用ディレクトリを使い、パスと意図を明示する。
- 画像は対応Agentの画像入力として渡す。画像理解非対応の場合、ファイル保存だけで「画像を理解できた」としない。
- 添付の文章は未信頼データ。添付内の指示がBridgeの認可・設定・秘密ストア操作に影響しないよう分離する。

### 11.3 送信

- Agentが返した正式な成果物、または許可Workspace内の検証済みファイルをArtifactとして扱う。
- `/files send` はArtifact IDを指定する。Discordから任意の絶対パスを入力して送信する機能は設けない。
- 既定ではファイル名・サイズ・種類の一覧だけを通知し、ユーザーの確認後に送信する。
- 実際の送信時にACL、実在、ファイル種別、サイズ、正規化した保存先を再検証する。
- Windowsのjunction、symlink、reparse point、大小文字差、UNC、代替データストリームによる許可領域逸脱を防止する。
- 秘密情報ストア、認証ファイル、設定、ログ、許可外ホームディレクトリを送信対象から除外する。
- サイズ超過は理由を説明する。自動的に公開ストレージへアップロードしない。
- 画像は添付プレビュー、その他は通常添付として送る。秘密や個人情報を含む可能性があることを確認画面に表示する。

### 11.4 保存・削除

- 受信キャッシュは既定7日で削除。ただし実行中Runや未解決要求の参照中ファイルは除外する。
- AgentのWorkspaceに渡したファイルや正式な成果物は、キャッシュ清掃で削除しない。
- 添付保存容量は既定1 GiB。上限到達時は新規添付を拒否し、安全な期限切れキャッシュだけを清掃する。
- 通知再送のための添付ステージングは、送信または失効が確定するまで保持する。

<a id="adapter-contract"></a>

## 12. 共通Adapterインターフェース

以下はBridge内部の設計契約である。DSHやOpenCodeに同名のAPIが存在することを前提にしない。

```ts
interface AgentAdapter {
  readonly type: string;
  capabilities(): AgentCapabilities;
  connect(profile: AgentConnectionProfile): Promise<void>;
  disconnect(): Promise<void>;
  health(): Promise<AgentHealth>;
  listSessions(query: SessionQuery): Promise<Page<SessionSummary>>;
  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  getSession(sessionId: string): Promise<SessionSummary>;
  getHistory(sessionId: string, query: HistoryQuery): Promise<Page<HistoryEntry>>;
  submit(input: SubmitInput): Promise<RunReceipt>;
  getRun(ref: NativeRunRef): Promise<RunSnapshot>;
  cancel(ref: NativeRunRef): Promise<CancelReceipt>;
  listPendingApprovals(sessionId: string): Promise<ApprovalRequest[]>;
  decideApproval(input: ApprovalDecisionInput): Promise<ApprovalReceipt>;
  uploadAttachment(input: UploadAttachmentInput): Promise<NativeAttachment>;
  listArtifacts(ref: NativeRunRef): Promise<ArtifactSummary[]>;
  openArtifact(artifactId: string): Promise<ArtifactStream>;
  subscribe(query: SubscriptionQuery): AsyncIterable<AgentEvent>;
}
```

### 12.1 入出力の共通定義

- `AgentConnectionProfile`: PC側で事前定義したProfile ID、接続方式、接続先、秘密情報参照。Discordから秘密そのものを受け取らない。
- `SubmitInput`: nativeSessionId、clientRequestId、prompt、添付参照、許可済みWorkspace情報。接続先やコマンド文字列を任意実行する用途に使わない。
- `RunReceipt`: 第22.2節のdurable AdmissionReceiptに相当する受付結果、Native Run IDまたは検証済みStableRunRef、request ID／digest、受付時刻／revision。安定相関を提供できなければruns.submitをfalseにし、新規受付しない。
- `RunSnapshot`: 現在状態、最終結果、未解決承認、成果物、更新時刻。
- `ApprovalDecisionInput`: 要求ID、対象Run、decision、要求versionまたは同等の競合検出情報。
- `SubscriptionQuery`: Agent／Session／Runの購読対象と、取得可能なら再開カーソル。
- 全時刻は保存・内部通信でUTCのISO 8601。Discord表示は利用者設定のタイムゾーンとする。
- 全IDは文字列。Discord SnowflakeをJavaScript Numberに変換しない。

<a id="capabilities"></a>

### 12.2 Capability

少なくとも以下を宣言する。

```text
sessions.list / sessions.create / sessions.history
sessions.sharedWithDesktop / runs.submit / runs.status / runs.cancel
runs.atomicAcceptance / runs.idempotentSubmit
approvals.list / approvals.decide
attachments.upload / attachments.imageInput / artifacts.download
events.stream / events.resume / desktopRuns.observe
```

- 未対応メソッドは `UNSUPPORTED_CAPABILITY` を返す。成功の空配列などで隠さない。
- イベント再開非対応でも、状態・履歴照会による復旧方式を宣言できる。
- ツールごとの詳細イベントを提供できない基盤でも、受付・状態・最終結果は共通化する。
- Adapter追加でDiscordコマンド・Binding・認可・状態モデルを作り直さない。
- AdapterはPC側で管理者がインストールする信頼済みコードとする。Discordからコードをロードしない。

### 12.3 正規化イベント

```ts
type AgentEventType =
  | "run.accepted" | "run.started" | "run.output" | "run.progress"
  | "approval.requested" | "approval.resolved"
  | "artifact.created" | "run.completed" | "run.failed" | "run.cancelled"
  | "session.updated" | "connection.changed";
```

イベントの共通Envelopeは、schemaVersion、agentId、eventId、occurredAt、payloadを持ち、対象がある場合はnativeSessionId、取得可能ならnativeRunIdとsequence／cursorを含める。接続状態などAgent全体のイベントにはSession／Run IDを必須としない。

- Adapterがevent IDを提供する場合はそれで重複排除する。
- event IDを生成する場合は、元データから安定して生成できる範囲と重複排除の限界を文書化する。
- sequenceがない場合に、受信順だけで全順序を保証しない。
- 正式なRun終了イベントまたは状態照会結果を終了判定に使う。出力停止だけで完了判定しない。

## 13. 永続化・設定

### 13.1 正とするデータ

- Native sessionと会話履歴: Agent側。
- DiscordとのBinding、認可設定、受付キー、Run追跡、通知状態: Bridge側。
- 承認の最終状態: Agent側。Bridgeは表示・監査用の対応情報を保存する。

### 13.2 主な永続化モデル

| モデル | 主な項目・制約 |
| --- | --- |
| `agents` | id、type、displayName、profileId、enabled、capabilitySnapshot、互換性情報 |
| `bindings` | guildId、channelId、threadId、agentId、nativeSessionId、version、createdBy、chatEnabled。ConversationKeyに有効1件、Agent＋Sessionにも有効1件 |
| `conversation_preferences` | ConversationKey、既定Agent、表示設定。Bindingとは分離 |
| `runs` | id、入力キー、requesterId、Agent／Session、nativeRunRef、状態、対象送信先、bindingVersion、clientRequestId、時刻、errorCode |
| `queued_inputs` | runId、保護payload参照、digest、添付参照、単調FIFO順序、受付権限scope。本文はHost-only DPAPIで保護し、DBには平文を保存しない |
| `approvals` | id、nativeRequestId、runId、送信先、状態、version、期限、決定者、Agent確認時刻 |
| `event_cursors` | agentId、購読範囲、最終処理カーソル／sequence |
| `outbox` | deliveryId、logicalEventKey、送信先、payload参照、状態、試行回数、次回時刻、Discord message ID |
| `artifacts` | id、runId、nativeArtifactId／検証済み参照、名前、MIME、サイズ、ハッシュ、期限 |
| `audit_events` | 時刻、操作者、操作、Agent／Session／Run参照、判定、理由、相関ID。指示全文は原則含めない |

- SQLのNULLの一意制約挙動に依存せず、通常チャンネルのConversationKeyを正規化して重複を防ぐ。
- Run生成・重複キー登録、Binding更新、承認競合処理、終了状態更新＋Outbox投入はトランザクションで行う。
- Agent切断・再起動でNative session IDを書き換えない。

### 13.3 設定例

以下は説明用の非秘密論理設定例でありDSH config APIではない。`credential://`は説明用参照表現で、実DPAPIストアの不透明64桁hex参照へ直接入力できるschemaではない。完成版の固定schema・revision・migrationは第22.5節に従う。

```yaml
schemaVersion: 1
discord:
  applicationId: "<application-id>"
  tokenSecretRef: "credential://discord-remote-agents/bot-token"
  allowedGuildIds: ["<guild-id>"]
  allowedChannelIds: ["<channel-id>"]
  allowThreadsInAllowedChannels: false
security:
  users:
    "<owner-user-id>": [admin, approver]
    "<operator-user-id>": [operator]
  allowedWorkspaceAliases: [project-a]
  defaultDeny: true
agents:
  - id: dsh-main
    type: dsh
    name: DSH Desktop
    profileId: local-dsh-profile
    enabled: true
runtime:
  maxConcurrentRunsPerAgent: 1
  maxQueuedRunsPerSession: 10
  progressUpdateIntervalMs: 2000
  approvalTimeoutSeconds: 600
files:
  maxFileBytes: 20971520
  maxFilesPerRequest: 5
  maxRequestBytes: 52428800
  cacheQuotaBytes: 1073741824
  cacheRetentionDays: 7
```

- `local-dsh-profile` の具体的接続方式はP0で確定する。例示のProfile名は実在するDSH接続設定ではない。
- Agent登録ではこのProfileの別名だけを受け付け、任意endpoint・executable・秘密情報をDiscordから設定しない。
- WorkspaceはPC側で別名と実パスを対応付ける。Discordでは別名のみ選択する。
- 設定変更はスキーマ検証後に適用し、不正な変更で既存設定を破壊しない。
- 起動時に必須設定・認可・秘密情報・DB整合性を検証し、不備がある場合は新規実行を開始しない。

### 13.4 保存期間・バックアップ

- Runメタデータと監査ログは既定90日。正式な履歴保存期間はAgent側の設定に従う。
- 指示本文・一時出力は必要最小限とし、完了後7日を既定のキャッシュ保持期間とする。
- 未送信通知、未解決承認、状態不明Runに必要な情報は、解決前に期限清掃しない。
- バックアップはSQLiteの安全なバックアップ機能などで取得する。稼働中DBの単純コピーを前提にしない。
- バックアップもアクセス制限・暗号化対象とし、秘密ストアは通常バックアップに含めない。
- 古いバックアップ復元後は、Agent状態とDiscord送信記録を再照合してから受付を再開する。

## 14. セキュリティ仕様

### 14.1 認証・認可

認可は次の条件をすべて満たす場合にだけ許可する。

```text
許可Guild
AND 許可Conversation（スレッドの明示許可を含む）
AND 許可User ID
AND 操作に必要な権限
AND 許可Agent / Workspace / Session
```

- ユーザー名・表示名・Discord管理者権限だけでは許可しない。固定User IDを使用する。
- Discord側operatorはviewerを含み、Bot側adminはviewer・operatorと事前許可Profile登録などの非秘密運用操作を含む。Bot側adminはHost設定・秘密・管理grant・許可scope変更権限を持たない。これらは上流trusted owner/adminに限定する。approverは独立追加権限であり、adminでも別途必要。
- Userごとに許可Agent・Workspace・必要に応じたSessionのスコープを設定する。権限ロールだけで全Agentへのアクセスを許可しない。
- viewerは閲覧、operatorは指示・Session切り替え・自身のRun中断、approverは承認判断、Bot側adminは事前許可Agent登録・無効化・未使用解除、通知再試行・許可範囲内の他者Run中断を行える。任意設定変更・接続先追加・資格変更はBotコマンドから提供しない。
- operatorが他者のRunを停止する場合は、明示的な共有操作許可を必要とする。
- コマンドだけでなく、ボタン、メニュー、Modal、通常メッセージ、添付、履歴ページ送りでも認可する。
- 長時間キューの実行直前、承認の回答時、成果物送信直前に再認可する。
- Discordのコマンド権限設定は補助。サーバー側認可を省略しない。

### 14.2 閲覧者への情報漏洩防止

- Bot操作可能ユーザーと、Discordチャンネルを閲覧できるユーザーは別概念である。
- Run結果・承認カードを投稿する前に、専用チャンネル／スレッドの閲覧権限を運用者が確認する。
- 初期はprivateな専用チャンネルを推奨し、公開チャンネルへのBindingを管理ポリシーで拒否する。
- 許可外閲覧者が追加されるなどの権限変更を検知した場合、通知を保留し管理者へ安全な方法で知らせる。
- 完全なACL解析ができない構成では自動的に「安全」と認定せず、管理者の確認が必要な状態を表示する。
- 既にDiscordへ投稿した履歴・添付は、後からUser許可を取り消しても閲覧済みデータを回収できない。

### 14.3 秘密情報・ネットワーク

- Bot token、Agent認証情報、Interaction token、添付の署名付きURLをログやエラーメッセージへ出さない。
- 通常設定には秘密情報の参照だけを保存する。
- 接続先はloopbackまたは検証済みローカルIPCを基本とする。LAN／インターネット公開は初期対象外。
- ローカル接続でも認証を使用し、同一PC上の別ユーザー・別プロセスを無条件に信頼しない。
- HTTP方式ではHost／Origin対策、秘密ヘッダー、意図しない外部転送の禁止を検討する。ブラウザーから不用意に叩けるAPIにしない。
- Discord Developer Portalで公開Interactions Endpointを設定しない。将来Webhook方式へ変更する場合は別設計とし、署名検証・リプレイ対策を必須にする。

### 14.4 エージェント実行のリスク

- AIへの自然言語指示はファイル変更やコマンド実行につながり得る。Discordで認可しただけで安全な内容になるわけではない。
- Agent本体の承認ポリシー、サンドボックス、OS権限、Workspace制限を保護の中心にする。
- BridgeのWorkspace別名制限は送信先・ファイル公開の制限であり、AgentのOSアクセス全体を隔離する保証ではない。
- BridgeとAgentを管理者権限で常駐させない。必要なら専用Windowsユーザーや隔離環境を使用する。
- AI出力に含まれるコマンド、URL、設定変更要求をBridgeが実行しない。
- 信頼済みAdapterも任意コード実行権を持つため、供給元・署名・バージョン・依存関係を管理する。

## 15. 再接続・再起動・エラー処理

### 15.1 Discord切断

- SDKのHeartbeat、再接続、Gateway Resumeを使用し、必要なsession／sequence情報をSDKの方式で維持する。
- 再接続は指数バックオフ＋ジッター。既定の基準は1秒から最大60秒とし、Discord指定待機時間を優先する。
- Agent実行は原則継続し、イベントを永続化して通知Outboxへ入れる。
- 復旧後は最新進捗へ集約し、終了通知と未解決承認を優先する。大量の古い進捗を連投しない。
- Gateway Resumeは通常の接続断回復に利用するが、Bot停止中の全指示を必ず取得できる保証として扱わない。

### 15.2 Agent切断

- Agent状態をoffline／degradedとして表示し、新規送信を停止する。
- 接続が戻ったら、対象Session、実行中Run、未解決承認、成果物を再照会する。
- 再開カーソルがある場合はイベントを再取得する。ない場合は状態と正式な履歴で補完する。
- 接続断直前の送信が実行されたか不明なら `unknown` にし、自動再送しない。
- 認証失敗や互換性不一致は無限リトライしない。管理者の対応を求める。

### 15.3 Bridge再起動

1. 単一インスタンスのロックを取得する。二重起動時は後から起動したBridgeを終了する。
2. 設定・秘密ストア・DBバージョンを検証し、必要なスキーマ移行を安全に実行する。
3. Agent登録、Binding、未終了Run、Approval、Outboxを復元する。
4. DiscordとAgentへ再接続する。
5. `dispatching`、`accepted`、`running`、`waiting_approval`、`cancelling`、`unknown` をAgent側と照合する。receiptだけならaccepted、開始の正式確認があればrunning、照合不能はunknownとし再送しない。
6. 古いボタンを無効化または再検証可能な状態にし、承認カードを復元する。
7. 通知の送信先・権限・送信記録を確認してOutbox処理を再開する。
8. 未送信 `queued` 指示を認可・対象Session・重複の確認後に再開する。受信当時と対象が変わったものは確認を求める。

### 15.4 通知配信の保証と限界

- 終了状態と通知生成を同一トランザクションで確定し、通知の黙った消失を防ぐ。
- 論理イベント単位でOutboxの重複を防ぎ、送信成功時のDiscord message IDを保存する。
- Discord送信成功後、DB保存前にBridgeが停止すると、再試行で重複投稿が生じ得る。
- SDK／APIが対応する送信nonceなどを活用できる場合は検証して使うが、常に完全重複防止できるとは仮定しない。
- 通知にはRun IDを含め、重複の識別を可能にする。通知の重複と実行の重複は別問題として扱う。
- 送信先削除・権限喪失は通知を保留し、別の公開チャンネルやDMへ自動転送しない。
- 401は認証修復待ち、403／404は送信先修復待ちとして停止する。429は指定時間後、通信障害／5xxはバックオフして再試行する。

### 15.5 共通エラーコード

| コード | 意味／対応 |
| --- | --- |
| `UNAUTHORIZED` | User／Guild／Conversation／対象権限不足。詳細を漏らさず拒否 |
| `AGENT_OFFLINE` | Agent未接続。新規送信停止、復旧案内 |
| `UNSUPPORTED_CAPABILITY` | 機能未対応。代替操作または制限を表示 |
| `SESSION_NOT_FOUND` | Session不存在／取得不可。Bindingを無効化し再選択 |
| `SESSION_BUSY` | PC側含む実行競合。キューまたは再試行案内 |
| `QUEUE_FULL` | 待機指示上限。受付拒否 |
| `SUBMISSION_UNCERTAIN` | 受付成否不明。自動再送禁止、状態照会 |
| `APPROVAL_EXPIRED` | 期限切れ。Agent状態確認、必要時中断 |
| `APPROVAL_ALREADY_RESOLVED` | PC側／別利用者で回答済み。カード更新 |
| `FILE_REJECTED` | 形式、サイズ、保存先など不適合。本文のみで実行しない |
| `RATE_LIMITED` | 待機時間を表示し、指定後に再試行 |
| `DELIVERY_BLOCKED` | 通知先・権限不備。Outbox保留 |
| `INCOMPATIBLE_AGENT_VERSION` | 未検証／非互換バージョン。実行停止 |
| `INTERNAL_ERROR` | 相関IDだけをDiscordに表示し、マスク済み詳細をローカル記録 |

## 16. 非機能要件・運用

### 16.1 性能・安定性の目標

以下は実装の受け入れ目標であり、外部サービス障害時の保証ではない。

| 項目 | 目標・測定条件 |
| --- | --- |
| Interaction受付 | 健全な接続時、初期応答p95が1秒以内、3秒以内の応答を必須とする |
| コマンド状態表示 | キャッシュ参照はp95が2秒以内。Agent照会待ちはdeferして表示 |
| 進捗反映 | Agentイベント受信後、通常負荷で5秒以内。レート制限・切断中は除外 |
| 終了通知 | 終了確認後、通常負荷で10秒以内にOutbox送信 |
| 復旧 | Discord／Agent接続が戻り照会可能になってから、通常負荷で60秒以内に追跡再開 |
| 長時間実行 | 24時間Runを含む72時間連続試験でBridge起因の追跡消失がない |
| 初期容量 | 10 Agent登録、10,000 Runメタデータを想定。既定実行並列数は1／Agent |

- 受け入れ試験は、対象Windows・Node・Discord SDK・DSHバージョンを記録して実施する。
- 大量出力はメモリに全量保持せず、集約・上限・ファイル化で制御する。
- DBやディスク不足時は新規受付停止。既存実行を無根拠に失敗・完了扱いしない。

### 16.2 ログ・監視

- ローカルに構造化ログを保存し、日次またはサイズ単位でローテーションする。
- User ID、Agent ID、Session ID、Run ID、相関IDを使って操作を追跡する。
- token、添付URL、指示全文、ファイル内容、秘密引数は既定で記録しない。
- 接続状態、最終Heartbeat、未終了Run、未解決Approval、Outbox件数、最古滞留時間、DB／ディスク状態を監視する。
- ログ出力先にもWindows ACLを適用する。
- Discordへ障害通知できないときのため、Windows側に起動・障害状態を残す。

### 16.3 導入手順の要件

1. Discord ApplicationとBotを作成し、tokenを秘密ストアへ登録する。
2. OAuth2の `bot`、`applications.commands` を使って許可サーバーへ導入する。
3. 必要最小限の権限を付与する。Administratorを要求しない。
4. メッセージ送信、履歴参照、Embed、添付を必要範囲で許可する。スレッドを使う場合は関連権限も確認する。
5. 通常チャットを使う場合のみ必要なIntentとDeveloper Portal設定を有効化する。
6. 許可User ID、Guild ID、Conversation、Workspace別名、Agent接続ProfileをPC側で登録する。
7. DSHとの接続診断と、専用Discordチャンネルの閲覧ACL確認を行う。
8. 検証サーバーで一通りの操作・承認・ファイル・復旧試験を実施する。
9. Host内の明示自動起動設定、バックアップ、tokenローテーション、更新手順を設定する（第22.8節）。

### 16.4 Windows固有の制約

- PCがスリープ・休止・停止、またはインターネット切断中は即時操作できない。
- 本システムにWake-on-LAN機能は含めない。長時間実行時の電源設定は利用者が設定する。
- DSHがログオンセッションを必要とする場合、サインアウト後の動作を保証しない。
- Bridge再起動がAgentプロセスや実行を終了させない構成にする。
- DSH更新後はAdapter互換性診断を行い、必要なら新規実行を停止する。

## 17. テストと受け入れ条件

### 17.1 テスト構成

- 単体: 認可、Binding、状態遷移、重複排除、キュー、承認競合、パス検証、出力分割。
- Adapter適合: 共通契約、Capability、Run相関、終了確認、未対応エラー、復旧。
- 結合: Discord検証サーバー＋実DSH Desktop。同一セッションとPC側の操作を確認。
- 障害: ネットワーク切断、Bridge／DSH再起動、429／401／403／5xx、DB失敗、ディスク不足。
- セキュリティ: 非許可ユーザー、古いボタン、偽造トークン、添付SSRF、パストラバーサル、junction、秘密マスキング。
- モバイル: Android／iOSのDiscordで主要コマンド、メニュー、承認、添付を確認。

### 17.2 必須受け入れ一覧

| ID | 検証内容 | 合格条件 | 対応要件 |
| --- | --- | --- | --- |
| AC-01 | Agent複数登録・切り替え | 2つの検証済みDSH接続Profileを登録し、対象を混同せず選択できる | AG-03〜05 |
| AC-02 | 既存セッション継続 | Desktopで作成したSessionを一覧から選び、Discordで続行できる | SE-01〜02 |
| AC-03 | 新規作成 | Discordから許可Workspace内に作成し、Desktopで同一IDを確認できる | SE-03〜04 |
| AC-04 | 相互共有 | PC→Discord→PCの順で発言し、同一Sessionで全履歴を確認できる | SE-04、AG-01〜02 |
| AC-05 | 切り替え | 複数Sessionを切り替えても指示、キュー、承認、結果が混線しない | SE-05 |
| AC-06 | 履歴 | ロール・順序・ページングを保持し、許可外Sessionを取得できない | SE-06〜07 |
| AC-07 | 進捗・終了 | 実イベントに対応した状態、最終応答、完了／失敗を確認できる | TA-01、TA-03 |
| AC-08 | 長時間実行 | 15分超、24時間のRunでtoken期限後も追跡・完了通知できる | TA-04 |
| AC-09 | 中断 | 対象Runだけを中断し、停止確認前に後続Runを開始しない | TA-02 |
| AC-10 | 承認・拒否 | 正規要求へ両方の判断が反映され、二重回答・期限切れ・非許可回答を拒否する | TA-05 |
| AC-11 | PC側との競合 | PC実行中のDiscord指示が安全に待機／拒否され、PC側承認済み要求を二重決定しない | TA-06〜07 |
| AC-12 | UI | モバイルからスラッシュ、ボタン、選択メニューで主要機能を完結できる | DI-01〜02、DI-05 |
| AC-13 | 通常チャット | 有効化済み範囲と許可Userだけを転送し、Bot投稿・編集による重複を発生させない | DI-03 |
| AC-14 | 添付入力 | テキスト・画像を同一Sessionへ渡し、不適合添付を拒否する。本文のみを黙って実行しない | DI-04 |
| AC-15 | 成果物出力 | 許可Artifactだけを確認後に送信し、許可外パス・秘密ストアを取得できない | DI-04、SA-02 |
| AC-16 | 認可 | 非許可User／Guild／Conversationから、全入力経路の操作を拒否する | SA-01 |
| AC-17 | 切断復旧 | Discord断とAgent断を別々に発生させ、追跡・通知・未解決承認を復旧できる | SA-03 |
| AC-18 | 再起動 | 登録・Binding・未終了Run・Approval・Outboxが復元される | SA-04 |
| AC-19 | 曖昧な受付 | 受付直後の強制停止で `unknown` を表示し、同じ指示を勝手に再実行しない | SA-05 |
| AC-20 | 通知障害 | 429は待機再送、403は保留となり、通知失敗をタスク失敗と混同しない | SA-03〜04 |
| AC-21 | 監査・秘密 | 操作と拒否を追跡でき、token・秘密引数・署名付きURLがログ／Discordに現れない | SA-02、SA-06 |
| AC-22 | Adapter拡張 | Mockの第二基盤を追加して、共通コマンド・Binding・認可の改修なしで適合試験に合格する | AG-04、AG-06 |

AC-22は拡張設計の検証であり、OpenCode実対応の代替ではない。OpenCodeの製品対応はP3で別途受け入れ試験を行う。

<a id="release-gates"></a>

## 18. 外部前提・リリースゲート

| 項目 | 現在の扱い | 確定する段階 |
| --- | --- | --- |
| DSHの正式接続手段・認証 | 正式Host／Client拡張とConnection RPCの静的契約を確認。Cookie／operatorはowner/admin資格として不採用。上流trusted owner/admin bootstrap・caller-bound grantを必須採用。正式提供・実導入は未検証（[判断記録](<docs/p0-decisions.md>)） | P0 |
| Native session共有 | 同一Native Sessionが必須、コピー禁止。DesktopとRPCの共通prompt経路を静的確認したが、実機往復は未検証 | P0 |
| PCとDiscordの原子的な実行受付 | 共通prompt経路だけでは保証不可。現行buildの正規拡張で共有線形化点を確認できず、DSH上流の共通受付primitive＋Native Run receiptを次ゲートにする | P0 |
| DSH承認・拒否・中断API | 必須。機能欠落を独自ボタンで代替しない | P0 |
| Native run ID・冪等キー・イベント再開 | 安定receipt／request照合とRun相関が必須。resumeまたは検証済み状態／履歴fallbackを第22章のゲートで確認 | P0 |
| 画像入力・成果物取得 | Agentごとの上限・形式・実装を確認 | P0〜P2 |
| DSH互換バージョン | 動作検証済み範囲を明示。更新後は再診断 | P0以降継続 |
| 利用規模 | 初期は個人／少人数・1台PC。公開サービス化は別設計 | P2 |
| OpenCode連携 | Adapter構造は用意するが具体APIは本書で断定しない | P3 |

### 18.1 判断基準

- API不足は工程上のリスクであり、ユーザーの要求が不要になったことを意味しない。
- 安全な共有操作を実現できない場合は、拡張開発か要求変更の合意を先に行う。
- 正規の承認連携が未提供の段階では、承認必須の操作を安全に完了できないことを明示する。
- 接続断、状態不明、期限切れ、権限不足は、実行可能と解釈せず停止・保留側に倒す。

### 18.2 採用方針と実現可能性の分離（2026-10-13）

利用者は、必要機能を**正式Host／Clientプラグインで実現する**方針を選択した。本体ASARやGUI rootの直接改変は行わない。正規拡張が不足する場合は要求を自動的に緩めず、根拠を示して再判断を求める。

[設計判断記録](<docs/p0-decisions.md>)に採用方針、根拠、利用可能にする検証条件を記録する。方針の確定は、対象DSHで実現可能と確認したことや実機AC合格を意味しない。特にowner／adminの証明とDesktopを含む原子的受付が未確認の間は、管理Remoteおよび完成版プラグインの新規モデル受付を公開しない。第20章の独立MVP評価は変更せず、原子的受付未対応という既存の制限を維持する。

## 19. 参考資料

Discord側の制約・実装時の確認先。仕様変更があり得るため、実装時に再確認する。

- [Discord: Receiving and Responding to Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding) — Gateway／Webhook受信、3秒の初期応答期限、15分のtoken期限、添付サイズ情報。
- [Discord: Gateway](https://docs.discord.com/developers/events/gateway) — Gateway接続、イベント、Intent、再接続設計の確認先。
- [Discord: Rate Limits](https://docs.discord.com/developers/topics/rate-limits) — レート制限ヘッダー、429、再試行。

DSH・OpenCodeのAPI資料は、P0／P3で対象バージョンと正規の資料を確認して追加する。


## 20. 現在のDiscord／Telegram MVPの適合性確認

### 20.1 結論と判定基準（2026-10-13）

**本MVPは本書の安全原則とコア操作の一部に沿っているが、本書全体への適合、P1完了、P2完成版とは判定できない。** 特にP1に含まれる会話履歴UIと実サービス結合試験が不足する。Telegramは最終要求として維持するが追加実装は延期する。この章は当時の独立MVP評価であり、現在の規範配置を示さない。

以下の「実装済」はソースに対象処理が存在するという意味で、実サービスでの受け入れ合格ではない。「部分」は機能の一部または安全策だけを提供する。「未実装」は現在の利用経路に存在しない。モックを含む自動テスト38件成功は[検証記録](<docs/verification.md>)に記録済みだが、第17章のAC合格件数とは異なる。

### 20.2 要件別の確認

| 要件 | 判定 | 現在の実装と不足 |
| --- | --- | --- |
| AG-01 | 実装済・実機未検証 | 許可Native session IDへテキスト指示を送る。Discord／Telegram共通Engine。[送信処理](<src/engine.ts>) |
| AG-02 | 実装済・実機未検証 | 本人の途中出力・最終結果・失敗を表示し、確定終了だけ通知する。[結果照合](<src/engine.ts>) |
| AG-03 | 未実装 | 1接続先のみ。複数Agent登録・選択なし |
| AG-04 | 部分 | Adapter境界はあるが登録機構・第二基盤適合試験なし |
| AG-05 | 未実装 | 接続Profile、Capability、互換性の管理UIなし |
| AG-06 | 部分 | 未提供コマンドを公開しないが、Capability宣言／共通未対応エラー契約なし |
| SE-01 | 部分 | ページ付き一覧あり。検索・現在選択の一覧表示なし |
| SE-02 | 実装済・実機未検証 | 既存IDを選び、追加指示を送信する |
| SE-03 | 実装済・実機未検証 | PCで定義したWorkspace別名だけで新規作成 |
| SE-04 | 部分 | 同一Native session IDへのRPC。実Desktopとの相互継続試験なし |
| SE-05 | 部分・設計差異 | 明示bind／unbindと受付先固定はあるが、ユーザー別Bindingであり会話共有・version比較更新ではない |
| SE-06 | 未実装 | `/result`はBot実行の出力であり、セッション全履歴のロール・時刻付きページングではない |
| SE-07 | 部分 | 送信／結果開示前に存在・cwdを再確認するが、不正Binding自体の無効化は未実装 |
| TA-01 | 部分 | dispatching／accepted／running／unknown／終了を表示。queued／waiting_approval／cancellingなし |
| TA-02 | 未実装 | Run限定停止契約を確認できず、危険なセッション全体cancelは公開していない |
| TA-03 | 部分・設計差異 | 実行時の本人・操作元を保存。Discordは元チャンネルでなく本人DM、Telegramは元private chat |
| TA-04 | 部分 | Bot tokenによる通常送信で15分制限を回避。15分超／24時間の実機試験なし |
| TA-05 | 未実装 | 正規承認イベント・承認／拒否UIなし。PC側で対応する |
| TA-06 | 部分 | 既知の実行中／inbox／未確定Runを拒否するが、Desktopとの原子的受付は保証できない |
| TA-07 | 部分 | 一覧にDesktop実行中状態は表示。Desktop起点Runの詳細追跡・通知なし |
| DI-01 | 部分 | MVP操作はslashで利用可能。全主要機能の完成版コマンドは未提供 |
| DI-02 | 未実装 | ボタン・選択メニューなし |
| DI-03 | 未実装 | 通常メッセージは指示として転送しない |
| DI-04 | 部分 | 長い結果を生成テキストとして添付。入力画像／ファイル、正式Artifact管理・確認送信なし |
| DI-05 | 部分 | 短い状態テキストはあるが、第7章のカードとモバイル受け入れ試験なし |
| SA-01 | 部分 | 固定ユーザー・Guild／Chat・channel・cwdを検証。viewer等の役割とユーザー別Workspaceスコープなし。[認可](<src/policy.ts>) |
| SA-02 | 部分 | 外向き接続、loopback限定、秘密の既知値マスク、任意ファイル送信なし。ただしtokenは平文環境変数／ローカル環境設定で、秘密ストア未導入 |
| SA-03 | 部分 | SDK再接続、履歴再照会、通知再試行あり。認証・互換性エラーの停止管理と全障害実機試験が不足 |
| SA-04 | 部分 | Binding・Run・通知状態・Telegram受信記録をSQLiteで復元。Agent登録／Approval／Artifactは未提供 |
| SA-05 | 実装済・実機未検証 | 送信前永続化、安定requestId、unknown、履歴照合、不明時の非再送。[永続化](<src/store.ts>) |
| SA-06 | 未実装 | エラーコードとRun履歴はあるが、全操作・拒否を記録する監査イベント／ログローテーションなし |

<a id="legacy-mvp-gap"></a>

### 20.3 機能不足とは区別すべき設計差異

1. **Bindingの意味が異なる。** 現在は `(guildId, channelId, userId)` がキーで、Native sessionの複数Bindingも許す。[キーと保存](<src/store.ts>)。第8章の会話共有Binding、Native sessionに有効1件、version競合検出に適合しない。プライバシー重視のMVP設計だが、完成版への変更か要求変更の合意が必要。
2. **Discord通知先が異なる。** 現在は本人DM。[配信](<src/bot.ts>)。第7・9・15章の受付会話単位への投稿と異なる。Telegram private chat対応は第21章で正式に追加するが、Discord通知／Binding方針を自動的に変更する根拠にはしない。
3. **競合の事前確認は原子的な競合拒否ではない。** 状態照会とprompt間にDesktopが指示すると、同一ターンへの混在やネイティブキュー投入があり得る。混在結果を隠す防御はあるが、第9.2節のDesktopを含む共通原子的受付境界の代替にはならない。
4. **排他範囲が異なる。** SQLiteはsessionごとの未確定Runを一つにするが、Agent全体の既定同時実行数1とFIFOキュー10件は未実装。異なるDBの独立Botプロセス間ではロックを共有できない。
5. **指示上限が異なる。** Engineは6,000文字。Discord入力上限等による縮小は許容するが、全経路に共通の6,000文字制限は第7.1節の既定20,000文字とは異なる。長文添付への代替経路もない。
6. **通知障害分類が不足する。** Discord送信失敗をDM_FAILEDへまとめ、永久拒否と一時障害を区別していない。Engineはバックオフで再試行し、第15.4節の401／403／404保留と修復待ち管理に適合しない。[配信再試行](<src/engine.ts>)。配信message IDの保存もない。
7. **設定・保存・運用の差異。** 平文token、保持期限清掃なし、秘密ストア／安全バックアップ／監査／Capabilityなし。Runと通知状態を同一行で保存する最小outboxはあるが、第13章全モデルを実装したものではない。
8. **独立CLIアプリであり、DSHプラグインではない。** 第21章のGUI設定、プラグイン登録、Host lifecycle統合は当時未実装。後日のHost安全基盤追加も完成版適合を示さない。
9. **Telegram停止中の指示の扱いが異なる。** 現MVPは復帰後に最大24時間保持されたコマンドを処理する。第7.4節の停止中指示を自動実行しない方針をTelegramにも適用する追加要求とは異なり、確認付き復帰が必要。

これらを「MVPだから適合」と扱わず、移行課題として管理する。今回の仕様追記だけではコード上の差異は解消しない。

### 20.4 開発段階・受け入れの判定

- **P0:** ソース／接続契約とモックを調査済み。実認証付き同一セッション共有、原子的受付、承認・中断・ファイル等の検証が未完了。
- **P1:** コアMVPの実装はあるが、正式履歴UIと実DSH＋実Discord／Telegram結合試験が未完了。P1全体の完了判定は不可。
- **P1.5:** 今回要求追加。プラグインとGUIは未実装。
- **P2／P3:** 未完了。OpenCode未対応。
- **AC-01〜22:** 現時点では正式な実サービス受け入れ合格を記録しない。特にAC-01、06、09、10、12〜15、21、22は主要機能／適合機構不足。残りにも実サービス試験や全条件の証拠が不足する。単体試験の成功をAC合格へ読み替えない。

優先順は、DSH拡張契約と安全な受付の確認 → プラグイン／GUI／秘密ストア → 履歴と実機往復 → Binding／通知方針の確定 → 完成版の承認・停止・ファイル・監査・運用である。承認や停止をDSHが提供しない場合は正規拡張か要求変更の判断を先に行う。

## 21. 統合プラグイン管理・GUI・Telegram最終要求

### 21.1 目的と対象

利用者がDSHのPlugin Managerで本機能を導入し、**DSH GUIの「リモート操作」設定画面でDiscord／TelegramのBot tokenを入力して利用開始できる**ことを要求する。導入後の通常操作に手動の環境設定ファイル編集、npmコマンド、別ターミナルの常駐を必要としない。Discordのみ、Telegramのみ、両方を選べる。

GUIの画面名は論理仕様であり、実在するroute、slot、RPC名を確約するものではない。自動token取得、利用者アカウントのログイン代行、DSH／モデルAPIキーの変更は対象外。Bot作成とDiscordへの招待、Telegramでのチャット開始は利用者が各公式サービスで行う。

### 21.2 DSH拡張方式の確認範囲とP0追加検証

対象DSH `0.2.0-rc.2`の同梱拡張資料には、Cordis Host plugin、`dsh.bundle.patch`のmanifest、Client pluginとslot／effect登録が記載されている。

- [Host／bundle調査記録](<docs/p0-management-authorization.md#e5-authorization-serviceの意味--正式bundle>)。
- [正式拡張の調査記録](<docs/plugin-foundation.md>)。

これは読み取り調査の証拠であり、本プラグインの登録・活性化・GUI表示を検証したものではない。対象版で次を確認し、再配布可能な資料と再現手順を接続契約へ記録する。調査用抽出ディレクトリを製品の実行依存にしない。

1. bundleの導入、設定schema、enable／disable／dispose、更新と再起動の契約。
2. GUI設定画面を追加できる正式なslot／navigationとHostへの認証付き通信。
3. Host側のセッション操作、イベント／承認／Run制御serviceと権限境界。外部HTTPを使わず内部serviceを使えるか。
4. DSH提供の秘密ストアとアクセス制御、なければWindows Credential Manager／DPAPIをプラグインから使用できるか。
5. Desktopとの共通原子的受付と安定Run receipt、Host再起動・GUIを閉じた場合の継続条件。
6. 互換DSH版と依存SDKの配布・ライセンス・署名／供給元管理。

未確認のservice名や秘密ストアAPIを想像して実装しない。安定契約がない機能は未対応と診断し、ユーザーへ理由を表示する。

### 21.3 配置と責任分離

```text
DSH GUI
  └─ Client plugin: リモート操作設定／診断／状態表示
         │ 認証・認可・入力検証されたHost通信
DSH Host
  └─ Host plugin
       ├─ 設定・秘密ストア参照・サービス別認可
       ├─ 共通Engine／Binding／Run／Outbox／監査／SQLite
       ├─ Discord transport ── Gateway／REST ── Discord
       ├─ Telegram transport ── HTTPS long polling ── Telegram
       └─ DSH Adapter ── 検証済みHost service／正規ローカル接続
```

- Clientは入力と表示に限定し、Bot接続・秘密読取・モデル実行をしない。
- HostがBot接続、資格情報、実行制御と永続化を所有する。Clientにtokenを埋め込んだbundleを配らない。
- GUIを閉じてもHostが稼働中ならBot処理を維持する。DSH Host終了中の操作はできない。
- 正式Host契約を使い、同一Host操作のためDSH_TOKEN入力を求めない。外部接続は将来別Profileを正式検証した場合だけとし、現完成版の上流不足を迂回するfallbackにしない。
- 両サービスは一つのEngine／DB／ネイティブSession排他を共有する。activation、再設定、HMR後も同じBotの二重receiverを起動しない。
- 独立MVPを暫定併存させる場合は、別プロセスとの競合を診断して同時受付を拒否する。異なるDBで同じDSHを操作して安全とみなさない。

### 21.4 GUI要件

| ID | 必須要求 |
| --- | --- |
| PL-01 | Plugin Manager経由でインストール・有効化でき、DSH GUI内に設定への導線がある |
| PL-02 | Discord／Telegramそれぞれの有効・無効を独立設定でき、片方のみでも動く |
| PL-03 | password型入力でBot tokenを設定できる。保存済みは「設定済み」とだけ表示し、既存値を取得・再表示しない |
| PL-04 | 接続テストを明示実行でき、Bot本人、必要設定、サービス到達性を秘密抜きで表示する |
| PL-05 | 保存／起動／停止／再接続を別操作として提供する。保存だけで新規モデル指示を実行しない |
| PL-06 | 許可ユーザー・Guild／Chat・会話・WorkspaceをGUIで設定し、既定拒否を維持する |
| PL-07 | 秘密をHost側の保護ストアへ保存し、通常設定・SQLite・ログ・ブラウザー保存領域に平文で永続化しない |
| PL-08 | token更新／削除は明示確認し、検証失敗や保存失敗で有効な旧設定を黙って破壊しない |
| PL-09 | 停止／disable／disposeでreceiver・timer・listenerを解放し、DSH本体や既存Runを停止しない |
| PL-10 | 再起動後も設定・Binding・Run・Outboxを復元し、不明な送信を自動再実行しない |
| PL-11 | サービス間の認可・Binding・結果開示を分離し、ネイティブSession排他は共通にする |
| PL-12 | GUIに接続状態、Bot識別、追跡中／不明Run、通知滞留、対応機能、非互換／再起動必要を表示する |
| PL-13 | プラグイン設定の読取・変更・token更新・接続テストをHostで管理権限確認し、リモートBotコマンドから設定できない |
| PL-14 | MVP設定／DBの明示移行とschema version管理を提供し、既存データを黙って共有公開しない |
| PL-15 | 対応DSH版・権限・依存関係・更新／削除時の保持方針を表示し、非互換時は新規受付しない |

#### 入力欄と初回フロー

- 共通: 許可Workspace別名とフォルダー、表示タイムゾーン、診断、開始状態。フォルダー選択はHostが実パス・権限を検証する。
- Discord: Bot token、Application ID、許可Guild ID、channel／thread ID、User IDと役割。tokenだけでは認可が成立しない。必要最小権限での招待方法とslash登録／更新操作を提供する。
- Telegram: BotFather発行のBot token、許可User ID／private Chat ID。`getMe`でBot ID／usernameを取得し、既存Webhookは拒否する。自動削除しない。
- 「接続テスト」はread-onlyの本人確認・接続診断に限定する。slash登録、Telegramコマンドメニュー変更、テスト通知は別の明示操作とする。モデル指示は送らない。
- 保存済みtoken入力欄は空で「設定済み」と表示する。空欄の保存は既存値を維持し、削除には専用操作を使う。
- 接続状態は未設定／停止／接続中／接続済み／再接続待ち／認証修復待ち／競合／非互換を区別する。Botログイン成功とDSH実行可否を別に表示する。
- Botサービスが無効な場合、その資格情報を必須にしない。未知のユーザー／会話からの操作は拒否し、許可設定が空なら開始しない。

<a id="management-security"></a>

### 21.5 秘密とGUI通信の安全性

- GUIからHostへ入力値を一度渡す必要はあるが、Client側でlocalStorage、IndexedDB、URL、分析イベント、console、エラー追跡に保存しない。送信後・画面離脱時に入力値を破棄し、再取得可能な「token表示」APIは提供しない。
- 管理方式は上流DSHのtrusted owner/admin本人bootstrapとcaller-bound grantを必須とする（第22.1節）。Cookie、operator Peer、loopback、同OSユーザー、最初の呼出し、自己申告roleをownerとみなさない。独立plugin bootstrap案は今回不採用であり、別途明示承認なしに実装しない。上流契約が未提供／未検証なら設定読取も含む全管理操作を非公開・fail closedにする。Origin／CSRF対策は管理主体の証明の代替ではない。
- 通常設定にはDiscord／Telegram別の不透明secretRefだけを保存する。採用するHost-only CurrentUser DPAPI＋SID ACLが使えなければ「保護ストア利用不可」。Credential Manager等への方式変更も別途契約検証を要し、平文fallbackはない。
- tokenの形式検証は本人確認の代わりではない。接続テスト結果と設定保存結果を分離する。マスク表示でもtoken末尾や実値を返す必要はない。
- 秘密ストアと設定DBをまたぐ更新は、候補秘密→検証→参照切替→旧秘密破棄の手順とクラッシュ復旧を持つ。単一SQLトランザクションで外部秘密ストアまで原子的と仮定しない。
- token更新時は旧receiverの停止を確認してから新receiverを起動する。無効tokenで旧接続を黙って継続して「更新成功」と表示しない。
- 削除・停止でDSH側のRunをcancelしない。通知の保留と既投稿データが回収できないことを表示する。
- バックアップ／設定exportにtokenを含めない。exportする非秘密設定と実行データの機密性も表示する。

### 21.6 Telegram固有の要求

Telegramは追加実装を延期し、後続P2段階の初期scopeとして、**本人とのprivate chat操作に限り**第2.2節のDM操作除外の例外とする。Discordは現行制限版では本人DMへの通知のみであり、操作とは区別する。Discord本人DM操作の追加案は第23章で別途扱い、Telegram実装開始や現行版の受付有効化を意味しない。

- 受信はBot API long polling、公開Webhookなし。グループ・channel・Business chatは初期対象外。
- 正の数値User IDとChat IDの両方を照合し、名前／usernameで許可しない。IDは保存時に文字列とし、APIの安全な整数範囲を検証する。
- TelegramのConversationKeyは `(transport=telegram, botId, privateChatId)` とし、Discordのキーとは別namespaceにする。Run／通知にはtransport、Bot identity、操作者、受付時Conversationを保存する。
- 完成版Bindingは第8章の全サービス横断一意性を保つ。同じNative SessionのDiscord／Telegram同時Bindingは禁止し、移動は旧Binding解除と新Binding確認を明示操作にする。旧Run・Approval・通知は旧サービス／Bot／送信先へ固定する。
- `/sessions`、`/bind`、`/new`、`/prompt`、`/status`、`/result`、`/notify`、`/unbind`、`/help`をコア操作とする。承認・中断・履歴等は対応Capabilityを実装した段階で提供し、通常テキストの自動転送は有効化制を維持する。
- `/whoami`は認可前でも本人IDのみを返せる。Agent・履歴・許可リストを返さない。
- 更新はBot identity＋update IDで重複排除し、受付成否不明の指示は再送しない。24時間の更新保持期限、無更新後のIDランダム化、古いoffset、クラッシュ境界を考慮する。
- Bot停止中の指示は**既定で自動実行しない**。第7.4節の方針を適用し、復帰時の未処理候補を本人が確認して実行する。現MVPは保持中のコマンドを復帰時に実行することがあるため、移行でこの差異を解消する。
- 409は競合修復待ち、401は認証修復待ち、403は通知先修復待ち、429はretry_afterに従う。受信競合をWebhook削除や他プロセス強制終了で回避しない。
- 4096文字のテキスト上限を考慮し、長い出力は安全なテキスト添付へ切り替える。parse modeなし、リンクプレビュー抑制、可能ならprotect_contentを使用するが、漏えい防止を保証しない。
- Bot chatはE2EのSecret ChatではないことをGUIに表示する。ユーザーが先にチャット開始する必要があることも案内する。
- Discord／Telegram両方を使っても、別サービスで受けたRun本文を自動的に他方へ配信しない。

### 21.7 ライフサイクル・移行・配布

1. プラグイン登録時はschemaと依存serviceを検証する。未設定なら設定画面だけ提供し、外部receiverを開始しない。
2. 非秘密設定の自動起動フラグを明示的に設定できる。既定は停止。起動時には秘密取得、許可設定、DSH互換性、既存Run照合を行う。
3. receiver／timer／listenerはHostのeffect／dispose契約に従って所有し、更新・再設定で重複しない。停止を待たずに新世代を起動しない。
4. GUIのHost接続断で保存・起動成功を推測しない。再照会し、候補設定と適用済み設定を区別する。
5. 一方のBotが障害でも他方を安全に維持し、サービス別に停止／診断する。共通DB破損や排他不足は両方の新規受付を止める。
6. MVPの設定／秘密は本人の明示操作で移行する。移行中は独立Botを停止し、安全なDBバックアップを取る。旧ユーザー別Bindingを共有Bindingへ無断で変換しない。
7. 旧Runは受付当時のownerと通知先を維持する。Bot tokenを別Bot identityへ変更した場合、旧Bot宛の未送信通知を新Botへ自動移送しない。
8. schema移行失敗はロールバックまたは安全停止し、unknown／未送信通知を削除して起動しない。既存出力の公開範囲を拡大しない。
9. disableはデータを保持してreceiverだけ停止する。アンインストール時のデータ保持と秘密削除は別確認とし、使用中の共有DSH履歴を削除しない。
10. DSH本体のASARやGUI rootを直接改変せず、正式なbundle／Client拡張方式で配布する。供給元・依存・互換版をPlugin Managerへ表示する。
11. Client bundleが本GUIへ反映するビルド経路と更新／refresh条件を検証する。HMRが必ず働くと仮定せず、再起動／ページ更新が必要なら案内する。

### 21.8 プラグイン追加受け入れ条件

以下は第17章への追加であり、既存AC-01〜22を置き換えない。

| ID | 検証内容 | 合格条件 |
| --- | --- | --- |
| AC-23 | プラグイン導入 | 検証済みDSHへ正式bundleを導入し、本GUIの設定画面へ遷移できる。本体改変不要 |
| AC-24 | GUI token設定 | Discordのみ／Telegramのみ／両方をGUIだけで設定でき、未使用サービスの秘密を要求しない |
| AC-25 | 秘密保護 | 通常設定・SQLite・Client永続領域・ログ・exportに平文tokenがなく、保存済みtokenをClientへ返さない |
| AC-26 | 管理認可 | 非管理GUI呼出し、CSRF、不正RPC、Bot側からの資格情報変更を拒否する |
| AC-27 | 接続診断 | 実Botの本人確認とDSH診断を行い、未設定／誤token／Webhook／非互換を区別。モデル指示を送らない |
| AC-28 | 単独・同時利用 | 各サービス単独と両方で実DSHの既存セッションを操作し、認可・結果を分離、共通排他を維持 |
| AC-29 | token更新・削除 | 有効値／無効値／通信断／秘密保存失敗／再起動で状態が正しく表示され、二重receiverなし |
| AC-30 | lifecycle | GUI閉鎖中もHost稼働中は動作。disable／dispose／Host終了で資源を解放し、DSH Runを強制終了しない |
| AC-31 | 再起動・データ移行 | MVPデータを明示移行し、owner／通知先を維持。Binding共有化と新Botへの通知移送を勝手に行わない |
| AC-32 | Telegram認可・復帰 | 非許可／group／転送／編集を拒否し、停止中指示を確認なしで自動実行しない。offset・重複・保持期限を検証 |
| AC-33 | 更新・互換・障害分離 | 非互換で新規受付停止。片方の障害でも他方は安全に継続。共通DB障害時は両方停止 |

すべて実施版、環境、再現手順、証拠を記録する。tokenを記録へ含めない。現時点で本章の受け入れ試験は未実施。AC-24／28／32とAC-33の両サービス部分はTelegram後続段階で実施し、Discord先行版で免除・合格扱いしない。

<a id="implementation-contracts"></a>

## 22. 実装契約・工程・実用配備

本章は前章までの要求を具体化する **INTERNAL DESIGN**。DSH不足部分は **REQUIRED FUTURE CONTRACT**（RFCと略記）で、現行APIの架空名を実装へ写さない。上流が別名で提供しても不変条件・契約・試験が一致すればよいが、私有serviceを推測してつながない。

### 22.1 RFC-M：上流管理本人性・授権

採用経路は上流DSHの信頼済みローカル本人確認UIによるowner bootstrap → ownerによるadmin明示委譲 → caller-bound grantのHost検証。独立plugin bootstrap／鍵配布は不採用。一般GUI login、Cookie、共通operator Peer、payloadのSID／role、同OSユーザー、最初の呼出しをownerとみなさない。model/tool/Bot/別pluginが本人確認UIを代理実行できない正規契約を要求する。

上流grantの必須データは `grantId, subjectId, trustedCallerId, hostInstanceId, role, scopes, issuedAt, expiresAt, revocationEpoch`。管理呼出しは `operationId, operation, payloadDigest, expectedRevision, hostInstanceId, expiresAt, singleUseNonce` に結合した上流検証可能な証明を持つ。Client自己申告のcaller／nonceでは不可。Hostは本人性・scope・失効・期限・本文digest・Host一致・nonce一回消費を副作用前に検証し、commit直前にも失効epochとrevisionを比較する。検証後失効した操作はcommitしない。grant保存／proof発行／失効契約がなければ公開しない。

ownerのみbootstrap・委譲／失効可。adminは委譲scope内の設定・秘密・起動・移行、双方は診断可。Bot adminと別資格。strict schemaで未知操作／fieldを拒否、管理JSON最大64 KiB、秘密最大4 KiB、入力／raw例外詳細を反射しない。Originはscheme/host/port完全一致、CSRFは正規nonce／caller結合で検証。null／欠落Originは上流が定義するtrusted non-browser経路以外拒否する。Cookie gateだけではAC-26合格にならない。

信頼境界はWindowsユーザー／管理者、DSH Host、導入した信頼済みHost/Client bundle、同origin実行コード。DPAPIは同OSユーザーの悪意あるプロセス／管理者を分離しない。XSS／同origin悪意pluginの資格利用の完全防御は主張せず、供給元・署名管理と最小grantを併用する。別OSユーザーにはSID別ACL／保管を要求する。

解禁証拠は正式contract・互換Host build・bootstrap本人確認・caller別識別・失効race・Cookieのみ／Bot／in-process invoke／cross-origin／偽role／replayの副作用ゼロ試験。未提供時は `MANAGEMENT_AUTHORIZATION_UNAVAILABLE` とし、設定読取・診断・start/stop・migrationを含め全管理操作非公開。

### 22.2 RFC-A：Desktop共有の原子的受付・receipt

**busy判定・request重複claim・Session予約・Run参照割当・enqueueの確定を一つの線形化点で行い、Desktopも必ず同じ境界を通る。** 同service、画像だけのserializer、plugin mutex、状態照会→promptは不適合。Session同時実行1件、BridgeのAgent枠既定1件。Desktop開始もSession予約を占有する。Desktopの既存Agent並列設定をpluginが勝手に変更せず、合算枠が必要なProfileは正式共有scheduler契約を別途確認する。

契約データ（内部型名であり現行DSH APIではない）：

```ts
type AdmissionRequest = {
  backendIdentity: string; nativeSessionId: string;
  clientRequestId: string; payloadDigest: string;
  expectedSessionRevision: string; mode: "start-if-idle";
  prompt: string; nativeAttachmentRefs: string[];
};
type StableRunRef = {
  backendIdentity: string; nativeSessionId: string;
  nativeRunIdOrEquivalent: string;
};
type AdmissionReceipt = {
  clientRequestId: string; payloadDigest: string; run: StableRunRef;
  acceptedAt: string; admissionRevision: string; durable: true;
};
type AdmissionResult =
  | { kind: "accepted" | "duplicate"; receipt: AdmissionReceipt }
  | { kind: "busy"; activeRun: StableRunRef; accepted: false }
  | { kind: "rejected"; code: string; accepted: false };
type RequestLookup =
  | { kind: "accepted"; receipt: AdmissionReceipt }
  | { kind: "not-accepted"; fencedRevision: string; proof: string }
  | { kind: "unknown"; reason: string };
```

同等Run参照は受付・照会・cancel・Approval・terminal・再起動を通じて一意不変な対象を証明する。Session ID／turn／cursor／`accepted:true`だけでは不可。request scopeはbackend＋Native Session。同ID同digestは同receipt、異digestは `REQUEST_ID_CONFLICT`。重複guardは添付await、inbox claim→durable記録の空白、Host再起動を含む。receipt返却前にclaim／receiptをdurableとし、crash後lookupは同Runまたは明示unknown。Run IDを再割当しない。

busyはaccepted=false、既存Runへのsteer／followup混入なし。Bridge FIFO先頭をqueuedへ戻し順序維持。残った予約は上流epochで照合・回収し、pluginが時間だけで解除しない。Session削除／差替え／revision競合は受付前確定拒否。

入力キーはDiscord `transport+botId+interactionId/messageId`、Telegram `transport+botId+updateId`。Run ID／clientRequestIdは受付transactionで生成固定、digestは正規化本文・添付hash・Sessionを含む。tombstoneは終了後90日以上、期間外の古いイベントはstale拒否。上流lookupも90日以上保持または同等fenced非再受付保証を要求。未終了／unknownキーは解決まで削除しない。

### 22.3 Queue・crash境界・unknown復旧

1. 認可・capability・Session・添付検証後、DB transactionで入力キー／Run／保護payload／送信先snapshotを作りqueuedへ。10件上限は未dispatch待機数（running含まず）、上限判定もtransaction内。
2. 単一writerがFIFO先頭とAgent枠をclaimしdispatchingをdurable保存してからNative admission。同一Host lockとDB CASを使用し複数writerを拒否する。
3. 直前にrequester権限、Bot identity、receiver generation、Binding version、Session存在・Workspace・Agent有効性を再確認。切替でも元Session固定。切替確認で「旧待機分を継続」を選んだ記録があれば旧version continuationを許可し、他の不一致はpause＋再確認。retarget禁止。
4. accepted/duplicateはreceipt保存→accepted追跡。Native startedイベントまたは正式statusで開始を確認してのみrunningとし、receiptだけから開始を推定しない。busyはqueuedへ戻す。確定拒否のみfailed（権限撤回はcancelled）としOutbox同transaction更新。
5. 応答喪失／DB receipt保存失敗／dispatching再起動はunknown。lookupで同receiptなら復元、証明済みnot-acceptedのみ元Runをqueuedへ戻せる。lookupは再送ではない。保持期限切れ／Session消失を未実行と推測しない。
6. unknownは同Session後続ブロック。管理者は照会・証拠確認・通知修復だけを行い、強制成功／未実行解除／自動再送不可。新IDの別指示でも未解決Sessionへ送らない。上流確定結果がなければ安全停止。

DBとNative受付は分散transactionで原子的とは主張しない。queued commit前crash＝未受付、dispatching保存後送信前＝unknown照合、Native受付後DB receipt前＝lookup復元、terminal後Outbox前＝再照会から冪等再生成を試験。起動時queued再開は再検証必須。receiver停止中／boot時の未処理指示は候補保留し確認なしで実行しない。

### 22.4 RFC-N：Native停止・承認・イベント

| 契約 | 必須データ／意味 | race／障害 |
| --- | --- | --- |
| Status | StableRunRef、state、revision、terminalOutcome、updatedAt、requestId | 古いsnapshotでterminal巻戻し不可、対象消失unknown |
| Cancel | StableRunRef、operationId、expectedRunRevision、受付と停止確認 | 完了raceはNative terminal優先。旧Run Aへのcancelを新Run Cへ適用しない |
| Approval | nativeRequestId、StableRunRef、version、summary/risk、issuedAt/expiresAt、state | ID/version CAS、PC回答、期限／権限喪失／Run終了の失効 |
| Decision | nativeRequestId、Run参照、expectedVersion、decisionId、allow-once/reject、Native結果 | response喪失は照会。無条件再送／包括承認不可 |
| Events | schema/eventId、Session/Run相関、sequence/cursor、revision、timestamp | dedupe／gap、terminal優先、checkpointと状態＋Outbox同transaction |

cancelは子処理への停止伝播と停止未確認の意味を示す。15秒未確認はcancelling/unknown、後続停止。Session全体cancel・共有process kill不可。Approval期限はNativeと600秒の小さい方。期限時Native reject、不確認ならtarget cancel、双方不確認は「期限切れ未確認」＋後続ブロック。AI文章からApprovalを生成しない。

resumeはcursor包含／排他・保持期限・gap・snapshot境界を正式検証。非対応でも **receipt→Run同一性・正式state・ロール付きhistory・未解決Approval・Artifactを同revisionまたは照合可能境界で取得する検証済みfallback** を許す。起動／復旧時照合、健全時既定2秒poll、429で指定待機。欠落を完了推定で埋めずevents.resume=falseを表示。証明不能範囲unknown。Desktop起点Runは同参照／認可scopeで観測できる場合のみTA-07対象、未Binding Sessionを勝手に公開しない。

### 22.5 永続schema・payload・Outbox・ファイル

完成版DB `schema_version=1`、設定 `schemaVersion=1`（旧MVPとは別schema識別子）。設定revisionは単調CAS、未知field拒否。後続schema変更はversioned migration、古いbinaryによる新schema読書きは拒否。

第13.2節全モデルに加え、`settings(revision,schemaVersion,nonSecretSettings,enabledTransports,autoStart=false)`、`secret_journal(operationId,baseRevision,candidateRef,oldRef,phase,botIdentity,errorCode)`、`receivers(transport,botId,generation,state,leaseEpoch)`、`input_tombstones(inputKey UNIQUE,clientRequestId,payloadDigest,finalState,retainUntil)`、`component_actions(opaqueId UNIQUE,actorId,ConversationKey,bindingVersion,targetId/version,expiresAt,consumedAt)`、`migration_journal(sourceSchema,sourceFingerprint,targetSchema,phase,backupRef)`を必須とする。秘密journalに本文を保存しない。grant／nonceはRFC-M上流契約、共通Peerで代替不可。

有効BindingはConversationKeyとNativeSessionKeyのpartial UNIQUE、未終了RunはSession毎にdispatching/accepted/running/waiting_approval/cancelling/unknown最大1、queuedは複数FIFO可。clientRequestId／logicalEventKey UNIQUE。NULLに頼らずthread absentを固定文字列へ正規化。ID文字列、時刻UTC、Agent別名を一意性回避に使わない。

DB/cache/payload/logs/backupsはHost専用私有領域で現在SID／必要system管理主体のみACL、祖先／reparse検証必須。試験のためACLを弱めない。queued本文・通知本文／一時出力はHost-only DPAPI保護blob、DBは参照のみ。解決済みpayload7日、Run／audit／tombstone90日、参照中／unknown／未送信は保持。秘密／Native履歴を清掃せず、DB/blob/logs/backupを配布／Gitに含めない。

完了通知は現Bindingへ再targetしない。rebind自体を旧通知の拒否理由にせず、旧Runに固定されたowner scope／Bot identity／元Conversationの現ACLを再認可する。同Botの再起動／token更新後は新generationが固定Bot identityを確認してOutbox leaseをCAS取得し、旧世代sendingを照合してから配信する。旧callbackはfenceし、別Botへ移送しない。

Outboxキーは `(transport,botId,ConversationKey,logicalEventKey)` 固定、pending→sending→sent/retry_wait/blocked/delivery_unknown/dead_letter。terminal＋Outbox同transaction、message ID保存。401/403/404はblocked、429指定待機、通信/5xxは1〜60秒指数backoff＋jitter、10回連続失敗でdead_letter＋GUI診断。送信成功→DB前crashはdelivery_unknownで履歴／nonce照合、不能なら重複可能性表示してadmin通知再試行確認。再試行はNative submitを決して呼ばない。毎送信前ACL/scope再確認、Bot変更／先喪失は保留、他Bot／DM転送不可。

第11章添付上限を維持、画像40,000,000 pixels、download30秒timeoutと実バイト計測。保存／Native登録完了前dispatch不可。ArtifactはNative ID／許可Workspace検証参照・hash・Run scopeを保持、一覧と実送信両方認可。handle取得後に実体／reparse/ACL/size/hashを再確認しpath差替え防止。任意path/ADS/UNC/secretRef入力不可。サービス／Agent上限が小さい場合は低い上限、本文だけを黙って送信不可。

### 22.6 Settings／secret transaction・receiver世代

秘密操作はkeep/replace/delete。空欄keep、delete専用確認。refはストア発行64桁lowercase hexのみ、Clientから任意ref/path指定不可。Hostだけ取得、読戻しAPIなし。形式検査とBot本人確認は別、モデル送信なし。

operationId＋expectedRevisionでsingle-writer journal claim→candidate_saved（保護保存）→candidate_verified（Bot本人／scope）→old_stopped（受付停止、受信／listener/timer終了await）→committed（revision CASで設定/ref/Bot identity切替）→new_ready（新generationが対象Bot identityを照合しlogin/ready確認）→retired（旧secret削除）を進める。spawnだけでnew_ready／成功としない。保存だけの操作ではreceiverを起動せずcommitted/停止で終え、旧secret退役清掃だけを行う。

commit前の検証／保存／CAS失敗・crashは候補を採用せず旧active参照を維持し、候補清掃の成否を記録する。旧receiver停止未確認ならcommit／新世代不可。commit後ready失敗は新refを保持し「保存済み／停止・接続失敗」＋error、旧secretはcleanup_pendingとする。旧active参照への自動rollback／旧接続継続成功表示は不可。再接続は有効管理proofの明示reconnect、または利用者が承認したautoStart設定に従う1〜60秒backoff（401は修復待ち、10回失敗で停止）だけ。new_ready成功後に旧secretを退役し、削除失敗はcleanup_pendingで起動成功と清掃未完を別表示する。commit後crashは適用ref／phaseと実receiverを照合し、候補から勝手に世代を復活させない。deleteはref解除・停止後blob削除、失敗はcleanup_pending。外部storeとSQL一括原子性を主張しない。

receiverは `transport,botId,generation,leaseEpoch,settingsRevision`。generation単調DB値。受信claim／dispatch直前とlocal DB更新をgeneration＋leaseEpoch CASでfenceし、旧callbackの新規claim／local更新を拒否する。ただし送信済みHTTPのremote commitは取消不能で、旧世代in-flight通知はdelivery_unknownへ保留し、送信結果照合完了または明示重複リスク承認まで新世代retryを禁止する。世代fenceを外部API副作用ゼロの保証と表現しない。stopは受付停止・受信終了await・通知保留、Native cancelなし。disposeは受信/timer/listener/subscription終了await後DB close、shared process killなし。停止未確認は競合で安全停止。GUI閉鎖はHost動作継続、Client HMRはreceiver再生成しない。再activation／Host更新は所有lockと旧effect dispose確認後開始。同Bot別MVP／DB併存は運用診断とsupported lease／Native契約で排除、確認不能なら受付不可。Telegram409乗取り禁止。片方のtoken障害は当該のみ、共通DB／受付不備は両方停止。

### 22.7 GUIと内部管理操作

概要→初回設定→権限/Workspace→診断→保存確認→明示起動。管理契約不足時は静的「利用不可」案内のみ、無認可設定読取なし。秘密欄は空＋設定済boolean（末尾も不可）。通信断はoperationId再照会、成功推測／自動再送なし。入力は送信後／離脱時破棄。

全操作はRFC-M必須。以下は内部論理名でURL／実在DSH remote名ではない。

| 操作 | 入出力／効果 |
| --- | --- |
| readSettings/readHealth | scope付きproof→redacted設定、revision、secretPresent、Bot identity、capabilities／ゲート理由 |
| saveSettings | operationId/expectedRevision/strict非秘密設定→新revision。保存だけでreceiver／モデル起動なし |
| replaceSecret/deleteSecret | operationId/revision/service/本文またはdelete確認→phase/secretPresentのみ |
| testConnection | 保存済serviceまたは一時候補→Bot本人／Native診断。候補メモリ限定、モデル／command登録なし |
| start/stop/reconnect | service/revision/operationId→generation、実state。停止完了前成功なし |
| registerCommands/sendTestNotice | Bot/許可先/明示確認→登録／送信結果。診断とは別、Native submitなし |
| getOperation | operationId/scope→pending/committed/failed/unknown、redacted code |
| planMigration/applyMigration | source/backup確認/plan digest/revision→差分／公開範囲／journal |
| retryDelivery/exportSettings | delivery IDまたはexport確認→通知のみ／secretRefなし非秘密設定 |

概要は未設定/停止/接続中/接続済み/再接続待ち/認証修復待ち/競合/非互換、generation、追跡／unknown Run、Approval/Outbox件数と最古滞留、DB/disk、互換版／restart必要を表示。Bot login・Native契約・実行可否は別指標。scope空なら開始拒否。保存／テスト／起動／登録／通知試験を混ぜない。更新確認は旧Bot未送信通知保留・既投稿内容回収不能を表示。

### 22.8 Milestone・配備・rollback・運用runbook

| 段階 | 入口・依存 | 出口ゲート |
| --- | --- | --- |
| M0 契約凍結/P0 | 1.2、上流RFC-M/A/N、正式bundle | 実Host build/wire。RFC-M＋bundleはAC-34、RFC-AはAC-35、RFC-NはAC-39の上流契約部分で個別解禁。未成立RFCに依存する操作のみ解禁不可。全項目合格まではP0全体未達 |
| M1 管理基盤/P1.5前半 | M0のRFC-M/bundle部分合格（RFC-A/N待ちでも管理基盤のみ進行可） | AC-34のClient/Host結合、AC-37、AC-41の秘密/保存/GUI部分、AC-38のschema/移行基盤、正式GUI/DPAPI/lifecycle。Mock開発と公開を分離 |
| M2 Discordコア/P1 | M0受付/Native必要部分＋M1、P0全体合格がP1完了条件 | 一覧/履歴/PC往復、認可/固定先/FIFO/unknown、AC-35の実Transport結合、AC-36、AC-40の基本通知、AC-39のstate/history復旧部分 |
| M3 Discord機能/P2-D機能ゲート | M2＋停止/承認/添付契約 | Discord機能該当AC、AC-39の停止/承認/event全条件、AC-40全条件、AC-41のfiles部分。AC-42の24h Run/72h運転を隔離pilotで検証。実用配備条件のAC-42残分はM4へ持越し |
| M4 実用配備/P2-D完了 | M3＋隔離pilot/backup/rollback | AC-38の実migration/rollback、AC-42の正式配備/更新/refresh/restart/runbook/削除全条件。manifest/署名/互換表と導入明示承認。AC-01〜42のDiscord該当条件全合格でP2-D完了 |
| M5 Telegram/P2後半 | M4＋別途工程承認、既存16回帰保持 | 固有・両サービスAC、AC-34〜42のTelegram/共有Engine条件も再検証し、AC-01〜42全条件合格でP2完了 |
| M6 拡張/P3 | P2＋対象正式契約 | 第二実基盤AC。Mock基盤はAC-22のみ |

配備前：標準Windowsユーザー・対話ログオン／電源条件→実Host buildとbundle hash/署名/依存監査→private専用Discord会話の閲覧ACL→正式Plugin Manager導入。ASAR/GUI root変更、研究抽出物実行、別serverでGUI反映代替不可。正式Client artifactとrefresh/Host restart条件を確認しHMRを無条件に約束しない。

初回：上流本人確認owner bootstrap→GUI scope/Workspace実パス→本人が新rotate tokenをpassword欄へ→Bot診断→save→明示slash登録/最小権限招待（Administrator不可）→Native診断→テスト通知→start→隔離SessionでPC往復/停止/承認/files pilot。tokenをchat/shell引数/logへ出さない。sleep/sign-out中利用不可を案内。

移行：MVP受付停止／receiver終了→未終了Run照合→SQLite安全backup/fingerprint→single-writer plan確認。旧個人Bindingは非公開候補、旧owner/DM/private chat送信先維持。共有化はACL確認後一件ずつ明示選択、衝突拒否。unknown/未送信/tombstone削除なし。旧平文秘密自動import不可、新tokenを本人再入力。新Botへ旧通知移送なし。migration journalで段階確定、失敗は旧DB不変または安全停止、Native履歴直書きなし。

更新：受付pause→queued/unknown/Approval/OutboxとNative相関確認→receiver停止await→整合backup→署名/互換schema検査→正式bundle更新→必要Host restart/GUI refresh→migration→Native/通知照合→診断→明示再開。shared DSHを試験都合で勝手に停止せず、restartが必要な保守は利用者の時間確認を要する。

rollback：受付／receiver停止、更新後DB backup。下位binaryにschema互換保証がなければ旧DB単純上書き禁止。更新後Run/通知/tombstone差分を復旧journalで保持しNative/Discord照合して互換DB再構築する検証済み手順のみ。未検証down-migration拒否、安全停止／forward fix。backup以降の指示を再実行せず、旧secretRef自動復活なし。

日常：healthでHeartbeat/unknown/Approval期限/Outbox滞留/DB容量確認。401はtoken rotate transaction、403/404は固定先ACL修復、429指定待機、5xx bounded retry、dead_letterは本文/固定先確認後通知のみ再試行。Native unknownはlookup/state/history照合、証拠なしは保留。DB破損/disk不足は受付停止・backup復旧、既存Native結果推測なし。漏洩は公式Portal rotate、receiver停止、上流grant失効、redacted監査確認、保護再保存。chat掲載token再利用不可。

停止／削除：disableはデータ保持とreceiver停止。uninstallはデータ保持／削除とsecret削除を別確認、Native Session/履歴/shared process不変更。参照中payload/unknown/未送信の喪失影響を表示し黙ってpurge不可。backup/audit保持期限とACLも確認する。

### 22.9 Capability依存・要求／試験追跡

| 操作群 | 必須契約／capability | 要求とAC |
| --- | --- | --- |
| 管理/導入/秘密 | RFC-M、bundle/Client、保護transaction | PL-01〜10、12〜15／AC-23〜27、29〜31、33 |
| Agent登録/診断 | backend identity、health、互換版 | AG-03〜06／AC-01、22、27、33 |
| Session一覧/作成/履歴 | sessions.list/create/history/sharedWithDesktop、scope | SE-01〜07／AC-02〜06、16 |
| 指示/queue | RFC-A、runs.submit/status/atomicAcceptance/idempotentSubmit、lookup | AG-01〜02、TA-01、03〜04、06〜07、SA-05／AC-04〜08、11、19 |
| 停止 | RFC-N targeted cancel＋terminal | TA-02／AC-09、11 |
| 承認 | RFC-N approvals.list/decide、Run/version/期限 | TA-05／AC-10〜11 |
| component/chat | 対象capability、exact scope/一回token、chat Intent | DI-01〜03、05／AC-12〜13、16 |
| files | attachments.upload/imageInput、artifacts.download、ACL/path実体 | DI-04、SA-02／AC-14〜15、21 |
| 復旧/通知/監査 | lookup、events.resumeまたは証明fallback、Outbox/audit | SA-01〜06／AC-16〜21、25、30〜31、33 |
| Telegram最終 | 共通契約＋private identity/update/offset | PL-02、11、共通要求／AC-24、28、32〜33 |

不足capabilityは理由付き拒否。管理不足＝管理公開不可、共通受付不足＝全新規モデル受付不可、停止/承認/復旧必須契約欠落＝P0/P2 release不可。falseを空成功にしない。全既存IDは上表／既存AC対応欄で保持する。

既存AC-01〜33を保持して次の障害ゲートを追加（すべて未実施の将来必須試験）。

| ID | ゲート／証拠 |
| --- | --- |
| AC-34 | owner bootstrap/caller grant/失効race、operation/digest/revision/Host/nonce転用拒否、Cookie/Bot/tool/偽role副作用ゼロ |
| AC-35 | Desktop/Discord並行、同ID同/異digest、添付await/inbox claim→durable空白、restartのreceipt一件性とbusy混入ゼロ |
| AC-36 | queued/dispatching/Native accepted/DB receipt/terminal-Outbox各crash、acceptedのみで再起動した際の開始非推定と後続阻止、lookup復旧、unknownと再送ゼロ |
| AC-37 | candidate_saved/verified/old_stopped/committed/new_ready/retired各crash、Bot identity＋ready確認、commit後失敗の新ref維持とcleanup_pending、generation/leaseEpochによるlocal fence。旧HTTP in-flightのremote ambiguityと照合／重複リスク承認前retry禁止を別検証 |
| AC-38 | migration単一writer/backup/Binding衝突/owner固定/Bot隔離、非互換rollback拒否、更新後Run非再送 |
| AC-39 | event duplicate/gap/cursor期限/terminal race、resume/fallback相関、Approval/cancelの新Run誤適用ゼロ |
| AC-40 | Outbox 401/403/404/429/5xx、sent→DB crash、poison/10回上限、ACL撤回、Native submit非呼出し |
| AC-41 | SID ACL/保護payload/tombstone期限、reparse/path差替え/ADS/UNC、backup/export/GUI/例外の偽秘密非露出 |
| AC-42 | 正式配備/refresh/restart、更新/forward recovery、disable/uninstall選択、24h/72hとrunbook再現 |

試験記録は実装版・実Host build・bundle hash・OS/Node/SDK・隔離条件・scope・期待結果・redacted証拠・未検証分岐を含む。単体/契約Mock→隔離Host→実Discord pilot→長時間/rollbackの順。現59成功2skipは追加ゲート達成ではなく、私有パス拒否はストア成功に数えない。上流未提供契約は具体依存条件として報告し、実機合格／実用配備済みと主張しない。

## 23. 日常操作コマンド・本人DM操作案・最終出力（2026-10-14追加）

### 23.1 目的・現状・優先度

スマートフォンだけで「作業先を選ぶ → モデルと推論設定を確認／変更する → 指示する → 最終結果を受け取る」を完結できることを目指す。コマンド名だけを登録して実処理のない機能を提供済みと表示しない。

- **現在の実装**：サーバーの許可チャンネルから `/agent sessions/new/bind/unbind/prompt/status/result/notify/help`。完了結果は本人DMへ自動送信するが、テキストは末尾1,200文字のみで、全文配送ではない。本人DMからの操作、モデル／推論変更は未実装。実Discordでの受入検証も未実施。
- **A：次期の優先要求**：現在対象の確認、Workspace一覧、履歴、Run一覧、モデル一覧・選択、推論レベル、設定の読み戻し、全文自動配信、対応機能の診断。上流の正式契約が未確認なら個別に未対応理由を示す。
- **B：次期の設計・実証対象**：サーバーを作らず本人とBotの1対1 DMだけで操作するモード。利用者のサーバー不要という意図を取り込む追加案であり、現行サーバー設定の削除・DM受付の即時有効化はしない。
- **C：正式契約待ち**：Run指定停止、承認、キュー、ファイル、通常チャット。従来要件を維持し、現行制限版の無効化を勝手に解除しない。Telegram追加開発も開始しない。

### 23.2 正規コマンド体系

次期版の正規入口は `/agent` に統一する。`ID`、`provider`、`level` 等は入力引数であり、例に出たモデル／推論レベルが実際に使用可能とは限らない。Aの新規コマンドは未実装要求、Cは契約待ち要求である。

| 優先度 | コマンド | 用途・必須の応答 |
| --- | --- | --- |
| A | `/agent help [topic]` | 実際に使用できる操作、使い方、未対応理由。モデル設定と配信制限も掲載 |
| A | `/agent current` | Agent、Session ID／タイトル、Workspace、モデル、推論、busy、Binding version、通知先をまとめて表示 |
| A | `/agent workspaces` | 許可済みWorkspaceの別名一覧。任意パスの登録はGUIのみ |
| A | `/agent sessions [query] [page]` | 許可Sessionの検索／ページング。選択中・busyを表示 |
| A | `/agent new workspace:<alias> [title] [model] [effort]` | 許可Workspaceで新規Sessionを作成し選択。指定設定を適用できなければ指示を開始しない |
| A | `/agent bind session:<id>` | 既存Sessionへ切替。現在の対象と切替先を確認してBindingを比較更新 |
| A | `/agent unbind` | 選択のみ解除。実行中Run・通知・Native Sessionは削除しない |
| A | `/agent history [limit] [cursor]` | 現Sessionのユーザー発言と回答。既定10件、最大50件。内部推論・秘密フィールドは取得しない |
| A | `/agent prompt text:<instruction>` | 現Sessionへ指示。受付Run、固定対象、実効モデル／推論、通知先を返す |
| A | `/agent status [run]` | 状態、経過時間、承認待ち観測、配信状況。最後の観測時刻も表示 |
| A | `/agent tasks [state] [page]` | 認可範囲内の進行中・最近のRun。別人の履歴を暗黙に表示しない |
| A | `/agent result [run] [page]` | 途中出力または最終回答を順に閲覧。自動通知の有無にかかわらず利用可 |
| A | `/agent models [provider] [query] [page]` | DSHが現在利用可能と確認したprovider／modelと推論対応一覧。APIキーは非表示 |
| A | `/agent model [provider] [id] [effort]` | 引数なしは現設定、指定ありは現Sessionのモデル変更。推論設定も同時指定可 |
| A | `/agent reasoning [level]` | 引数なしは現モデルの実効推論設定、指定ありは現Sessionの変更。候補はモデルごとに取得 |
| A | `/agent context show` | Nativeが公開するコンテキスト使用量・上限・直近Runのtoken使用量／費用を表示。取得不能項目は不明とし、概算と実測を区別 |
| A | `/agent settings show` | モデル／推論の実効値、継承元、通知方針、対応機能を表示。秘密を返さない |
| A | `/agent settings title value:<title>` | 正式なNative更新契約がある場合に現Session名を変更。Bindingや履歴本文は変更しない |
| A | `/agent settings reset target:<model\|reasoning\|both>` | 確認後にSession上書きを解除しDSH既定へ戻す。秘密・承認・sandbox設定は変更しない |
| A | `/agent notifications show` | 現在の配信先・全文配信方針・未送信／不明件数を表示 |
| A | `/agent notifications set destination:<dm\|origin> [progress]` | 今後のRunの通知方針を明示設定。originは許可サーバー会話のみ。既存Runの宛先は変更しない |
| A | `/agent notifications retry delivery:<id> [part]` | 通知だけを対象に明示再試行。不明配送は照合または重複リスク確認を必須とする |
| A | `/agent notify run:<id>` | 既存コマンドとの互換入口。上の通知再試行と同じ認可・配送処理を通す |
| A | `/agent diagnose` | Bot／DSH接続、版、capability、通知滞留、最後の安全なエラーを表示。tokenやローカル秘密は返さない |
| C | `/agent context compact` | Nativeの正式な会話圧縮機能がある場合のみ、idleと対象を確認して実行。要約文の投稿や履歴直書きで代用しない |
| C | `/agent stop run:<id>` | Nativeが特定Runだけを停止できる場合に限定。Session全体cancelで代用しない |
| C | `/agent approval list` / `/agent approval decide id:<id> decision:<approve\|deny>` | Nativeの対象・期限・競合検査を備えた承認。未対応ならPCでの操作へ案内 |
| C | `/agent queue list` / `/agent queue cancel run:<id>` | 正式なキュー／未開始取消が利用できる場合のみ |
| C | `/agent files list` / `/agent files send artifact:<id>` | 認可・パス・内容検査を備えた成果物配信。現行版は無効 |
| C | `/agent chat enable` / `/agent chat disable` | 対象会話で通常メッセージを指示として扱う明示切替。既定off、過去メッセージは実行しない |

Discord登録ではサブコマンドgroupを用い、各階層のoptionsを25件以内、choices／autocompleteも25件以内とする。上表のgroupを展開して25件超の平坦な登録をしない。旧第7.2節の `/session`、`/ask` 等を併設する場合も同じ内部操作・idempotency・認可へ集約する。autocompleteでも利用者を認可し、手入力値は実行時に再検証する。未対応操作はhelpで理由を確認できるようにするが、登録済み・実行可能とは表示しない。

### 23.3 モデル・推論設定の規則

| ID | 必須要件 |
| --- | --- |
| CMD-01 | 設定の正はDSH Native Session。モデルIDだけでなくprovider／backendを識別し、表示名の一致だけで選択しない。Desktopで変更した値も再読込して反映する |
| CMD-02 | 設定のscopeは明示したSessionの以後のRun。DSH全体既定、他Session、既存Run、子Agentのrouting、API credential、承認／sandboxは変更しない |
| CMD-03 | reasoning候補はprovider／modelの正式なメタデータから取得する。low／medium／high／xhigh／max等を全モデルへ固定適用しない。auto／継承／未対応／取得不能を区別し、未対応を架空の既定値へ変換しない |
| CMD-04 | モデルと推論を同時変更する場合は組合せを検証する。前モデルの推論が非互換なら候補の選択か明示的な継承を求め、黙って引下げない。部分成功を全成功にしない |
| CMD-05 | 変更対象の完全Session ID・Binding version・設定revisionを固定して再認可する。busy／待機Run／unknownがあるSessionは変更拒否を既定とし、実行中のモデルを差し替えない |
| CMD-06 | 正式な設定取得・変更・適用確認契約が必要。INTERNAL DESIGNとして `models.list`、`session.settings.read/write` 等の能力を想定するが、既存DSH APIがその名で実在するとは主張しない。ASAR改変、DB直書き、指示文による擬似切替は不可 |
| CMD-07 | 更新成功はNative再読込で実効値を確認した場合のみ。Desktopとの同時変更はCAS等の正式条件更新がなければ競合保証を未対応と表示し、安全な直列操作に限定する。timeoutは適用不明として再照合し、自動再適用しない |
| CMD-08 | Run受付時のモデル／推論を記録する。Nativeの実効値を取得できなければ「要求値」と「確認できた実効値」を分け、要求値だけで適用済みと表示しない。新規Session作成＋設定途中失敗は作成済みIDを示し、モデル指示やSession作成を再送しない |

UIは現在のモデル／推論を常時確認できるようにし、変更後は「対象Session・旧値→新値・適用範囲」を短く返す。別のSessionへ切替後に古いボタンを押しても、新しいSessionに設定を適用しない。

### 23.4 サーバー不要の本人DM操作案

**目標**：本人がアプリを自分へ追加してBotとの1対1 DMで操作でき、専用サーバー・guild ID・許可チャンネルIDの作成を必須にしない。ただし現在のBotからの完了DM送信だけで、DM操作が成立したとは判定しない。

- 次期GUIで「本人DMのみ／サーバーのみ／両方」を明示選択する設計とする。新規個人利用では本人DMのみを推奨候補とするが、既存設定は移行しない。DM機能の有効化は管理GUIで本人User IDとscopeを確認して行い、初回に話しかけた人を管理者にしない。
- 本人DMのみの場合、guild／channel allowlistは不要だが、Bot／Application identity、許可User ID、Workspace、Native Session認可は必須。設定検証はモード別に行い、guild ID欠如を全操作許可と解釈しない。
- DiscordのUser Install、グローバルcommandの `integration_types`、`contexts` の `BOT_DM` を正式に検証する。guild command登録や旧 `dm_permission` だけでDM対応を主張しない。`PRIVATE_CHANNEL`に含まれる他人同士のDM／グループDMや、ユーザー追加アプリの任意サーバー利用は本案の対象外。
- Gateway受信、本人への導入・command表示、slash／component／modalの受信、長時間後のBot認証によるDM送信まで実機確認する。公開HTTP Endpointが必要なら現在の外向き接続方針と競合するため別途合意を要し、未確認のままDM-onlyを配布しない。
- 受信イベントのBot identity、実際のinteraction context、`user.id`、1対1 DMのchannel／recipientを検証する。認可は毎回行い、Discordのinstall owner情報だけでは実行権限を与えない。非許可本人、Bot、Webhook、グループDMは副作用ゼロで拒否する。token・cookie・秘密をDiscordで登録させない。

会話キーはINTERNAL DESIGNとして次のtagged unionを追加し、guildをnullや0で埋めて既存サーバーキーと混同しない。

```text
DiscordGuildConversationKey = (transport=discord, kind=guild, botId, guildId, channelId, threadId | null)
DiscordDmConversationKey = (transport=discord, kind=dm, botId, userId, dmChannelId)
```

DMも有効Bindingは1会話につき1件。同じNative SessionをguildとDMへ同時Bindingして従来の一意制約を回避しない。旧Binding解除→明示切替を行う。既存Run／Approval／Outboxのactor・Bot・元Session・元送信先は不変。サーバー操作の結果DMと、DM操作自体の会話Bindingも別に扱う。

通常DM本文の自動実行は行わず、初期はslashを入口とする。通常メッセージを指示に使う場合も `/agent chat enable` による明示有効化後の新規メッセージだけを対象とし、DMであることを承認・sandbox・busy検査の省略理由にしない。

### 23.5 最終出力の自動配信

| ID | 必須要件 |
| --- | --- |
| OUT-01 | 完了時は利用者の `/agent result` 操作を待たず、Nativeに相関した最終回答を自動送信する。完了だけの短い通知や末尾1,200文字だけでは本要件を満たさない。失敗／中断はその状態と取得済み出力を示す |
| OUT-02 | 次期の個人利用では本人DMを既定候補とする。サーバー元会話への配信は明示許可時のみ。Run受付時に認可済みの宛先を固定し、後の通知設定変更を既存Runへ適用しない。DM不可でも公開チャンネルに自動転送しない |
| OUT-03 | テキストのみの版では全文を順序付きの複数メッセージへ分割する。本文＋Run表示＋part番号を含め各messageを2,000 UTF-16 code units以内とし、surrogate pairや文字列を欠落させない。既定自動配信上限は最終回答100,000 Unicode code pointsかつ128 parts。超過分は黙って捨てず「全文配信未完了・上限・PC確認先」を通知する。これ未満の出力で意図的な末尾だけ配信は不可 |
| OUT-04 | コード・順序・改行を保ち、表示用のコードフェンス補完と元本文を区別する。全partの本文を戻すと元の最終回答と一致することを検査する。toolログ、内部推論、他Runの出力を混入させず、mentions／embedsは抑制する |
| OUT-05 | Native terminal＋固定宛先＋本文digest＋part数／各part状態をdurable Outboxへ確定し、各Discord message IDを保存する。再起動で送信済みpartを再送しない。part Nが不明ならN+1以降を保留し、末尾まで配信済みと表示しない |
| OUT-06 | 429は指定待機に従い順序を維持。権限喪失・DM拒否はblocked、送信成功→保存前crashやtimeoutはdelivery_unknownとして照合する。判定不能時は自動再送せず、重複リスク付きの明示再試行だけを許す。通知再試行でNative promptを呼ばない |
| OUT-07 | `/agent result run:<id> page:<n>` でも同じ最終本文を順に取得できる。DM配信失敗を理由に実行を失敗へ書換えず、実行状態と配送状態を分ける。保存本文を復元できない場合は取得不能と表示し、別Runの最新出力で代用しない |
| OUT-08 | 本文／partの永続保存には既存の保護ストア設計と保持期限を用い、SQLite・ログへ本文や秘密を平文保存しない。Native履歴からの再構成時もRun相関とdigestを検証する。添付・Artifact無効の現行境界を、長文textファイルの送信で勝手に解除しない |

自動配信対象はBridgeが受け付け追跡しているRun。PC側で開始した任意の会話や別利用者の出力まで常時DM転送する機能ではない。Desktop開始Runの追跡を追加する場合は別途scope・同意・Native観測契約を定める。

### 23.6 追加受け入れ条件と実装順

以下はすべて未実施の将来試験であり、既存AC-01〜42や現行回帰成功を合格根拠へ流用しない。

| ID | 受け入れ条件 |
| --- | --- |
| AC-43 | 実登録schemaが階層上限内。help／current／workspaces／history／tasks／diagnoseの内容・認可・ページングが実装状態と一致し、従来コマンドと新aliasで二重受付しない |
| AC-44 | 実DSHでprovider／model一覧を取得し、Desktopで変更したモデル／推論を再表示。非対応level・未認可Session・曖昧ID・秘密情報取得を拒否 |
| AC-45 | モデル＋推論変更、継承解除、新規作成時指定を実機で確認。busy／unknown・Binding変更・Desktop競合・更新timeoutで誤Session変更／無言fallback／自動再適用なし |
| AC-46 | 専用サーバーを作らず本人へのアプリ導入からDM slashで選択→設定→指示→最終結果受信まで成立。Gateway・command context・component／modal・再接続も記録 |
| AC-47 | 非許可ユーザー／他DM／グループDM／偽context／Bot／Webhookの指示・autocomplete・古いボタンを副作用ゼロで拒否。DM／guild同時Bindingを拒否し、既存通知先は移行しない |
| AC-48 | 短文、1,200文字超、コード・日本語・emojiを含む長文、上限境界で全文を自動配信。受信partの本文結合とNative最終回答のdigest一致、順序・mentions抑制・超過明示を確認 |
| AC-49 | 15分超のRunをInteraction tokenなしで完了通知。DM拒否・宛先削除・権限失効時に別送信先へ漏らさず、実行成功と配信失敗を区別 |
| AC-50 | 各part送信前／送信後DB保存前／送信済み確定後のcrash、429、timeout、再起動で順序・保留・非再送・明示retryを確認。Native再実行ゼロ |
| AC-51 | settings reset／notifications変更が対象Session／将来Run以外を変更せず、credential・承認・sandbox・子Agent routingへ影響しない。危険な配送変更は対象と公開範囲の確認を必須化 |
| AC-52 | 新旧guild設定・DM-only設定のモード別検証、保存データの安全な前方移行／拒否・復旧を確認。本文平文流出、旧unknown消失、旧Run宛先変更なし |

実装は、①現状一覧・capability検証とcommand整理、②正式モデル／推論契約の実証、③保護Outbox付き全文配信、④DM-onlyの導入／受信実証と明示有効化、⑤Cの上流待ち機能、の順を基本とする。各段階を別々に実装・mock／実機で検証し、対応しない段階を完了扱いしない。今回はこの仕様追記までで、Bot command再登録・DM受付・モデル設定変更・実配信は行わない。

Discord登録方式の根拠：[公式Application Commands](https://docs.discord.com/developers/interactions/application-commands)（参照した[公式ソース](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/application-commands.mdx)、2026-10-14）。`contexts`／`integration_types`がglobal command用であること、`dm_permission`が非推奨であることは確認したが、このpluginでのUser Install・Gateway・DM動作の成功証拠ではない。
