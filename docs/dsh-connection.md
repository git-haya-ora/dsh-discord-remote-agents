# Legacy CLI connection notes — not plugin onboarding

This preserved legacy implementation guide is not the supported plugin setup path. Use [restricted installation](<restricted-installation.md>). No legacy token/CLI procedure is required for GitHub plugin installation.

> **互換性の再検証が必要（2026-10-13）**：以下は既存CLI Adapterの実装・過去調査を記録したものです。今回のインストール済みASAR調査ではRPC envelopeとの差異が指摘されています。モック試験の成功や版番号の一致だけで現行DSHとの互換性を保証しません。[P0判断記録](<p0-decisions.md>)に根拠と再検証ゲートを記録し、CLIの実サービス対応も確認するまで未検証として扱います。

## 対象

このlegacy guideが対象としていた版はDSH `0.2.0-rc.2`、セッションログ形式は`4`です。Windowsの既存Web GUIホストに接続します。以下の `PORT` は利用者の既存ホストの実際のポートに置き換えるplaceholderで、動作確認済みの接続先を示しません。Desktopを別途起動したり、既存GUIを別サーバーに置き換えたりしません。

DSHの同梱パッケージ`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-agent-loop`のREADMEと生成されたホスト定義／実装を確認しました。ネットワーク契約だけを独立した[Adapter](<../src/dsh.ts>)へ実装し、DSH本体のコードは変更していません。DSHの内部パッケージを実行時依存としてコピーすることもありません。

これはインストール版が公開している認証付きRemote APIの利用であり、将来互換性が保証された独立SDKだと主張するものではありません。バージョン差や応答形式の不一致はエラーにし、推測した別APIへフォールバックしません。

## 認証

1. 有効な起動トークンを`DSH_TOKEN`に設定する。
2. `GET /?token=<URLエンコードしたトークン>`を送る。リダイレクトは自動追従しない。
3. 正常時の`303`と`Set-Cookie`から`dsh-auth-...`認証Cookieを取得する。
4. 後続APIでそのCookieを送る。Cookieはメモリー内だけに保持する。
5. `401`／`403`ではCookieを破棄する。後続要求は同じ設定トークンで認証し直す。現在のトークンが変わった場合は設定更新とBot再起動が必要。

単にBearerヘッダーを付ける方式ではありません。一般ユーザーのブラウザーCookieを抽出しません。トークンをDSH_URLやSQLiteへ埋め込みません。

URLは`http://127.0.0.1:port`、`http://localhost:port`、`http://[::1]:port`のルートだけ許可します。URLのユーザー情報、パス、クエリ、フラグメント、非ループバックアドレス、HTTPSは拒否します。ローカルホスト自身とOSは信頼境界です。

## 呼出し形

```http
POST /api/session/<method>
Content-Type: application/json
Cookie: dsh-auth-...=...
Origin: http://127.0.0.1:PORT
```

```json
{"kind":"invoke","args":{"request":{"...":"method-specific arguments"}}}
```

成功は`{"ok":true,"value":...}`、失敗は`{"ok":false,"error":{"code":"...","message":"...","details":{}}}`。生のmessageやdetailsはDiscordへ転送しません。

| method | 要求と用途 |
|---|---|
| `list` | `{}`。`items`からsessionId、cwd、running、projections.values.titleなどを読む |
| `create` | `{cwd, sessionId}`。Botで先に一意IDを生成し、戻りIDが一致することを確認 |
| `projections` | `{sessionId}`。`{asOfSeq, values}`。存在しない場合null |
| `page` | `{address:{kind:"session",sessionId},throughSeq,maxMessages,beforeSeq?}`。`records`と`hasMore` |
| `prompt` | `{requestId,sessionId,mode:"queue",content:[{type:"text",text}]}`。受理時`{accepted:true}` |

`clientTimeZone`は任意ですが、この実装では指定しません。タイムゾーンや日付を含む指示はユーザー自身が明示してください。

## 履歴から実行を確定する

送信前に`projections.asOfSeq`を保存し、SQLiteに`dispatching`の実行を記録してからpromptを一度だけ送信します。

DSHの記録順序は、通常`turn/start` → `step/start` → `user/message` → `assistant/message`／ツール処理 → `step/end` → `turn/end`です。

- `user/message`のdataは直接メッセージであり、`data.source.rpcId`が送信requestIdに対応します。
- `assistant/message`は`data.turn`と`data.message`を持ちます。
- `turn/end`は`data.turn`と`data.reason.kind`を持ちます。
- `completed`だけを成功とします。`aborted`は中断、その他は失敗。agentがidleになっただけでは成功にしません。
- `surfaceOp === "append"`の指示とモデル出力だけを対象にし、置換／圧縮された歴史的な出力を新しい回答として配信しません。
- ターン開始と対象指示が別の取得タイミングに分かれても、ターン候補と読取カーソルを永続化します。
- 同じターンの別の直接user指示を検知した場合、結果を破棄してPCでの確認を案内します。これはGUIとの原子的なロックではありません。

履歴は固定した`throughSeq`まで、後方ページを`beforeSeq`で遡って取得します。前回カーソルより後のイベントを連続したseqとして検証し、年代順に処理します。ページ欠落、カーソル後退、不正な応答では部分的なカーソル更新をせず、成功にも変換しません。

## 二重実行と所有権

DSH自身はrequestIdの既存履歴／inboxとの照合を行います。ただし「存在するすべての状態でexactly-onceを永続保証する」とは仮定せず、Bot側でも以下を守ります。

- Discord interaction IDを実行ID、`discord:<interaction ID>`をDSH requestIdにする。
- SQLiteの実行ID主キーとセッション別の未確定実行の一意制約で排他する。
- 通信エラー時はunknownにして自動再送しない。
- 再起動時のdispatchingもunknownへ変換し、読取りだけで照合する。
- writer所有権エラーを回避しない。同じホストが正式に取得できない既存セッションは操作できない。

現在のAPIのcancelはセッション全体に対する要求で、Botの一つのrequestIdだけを確実に止める契約ではありません。そのため、このMVPではDiscordからcancelを呼びません。承認APIの自動操作もありません。

## 検証上の限界

実DSHホストへの未認証要求が401になることは確認しています。有効なDSH_TOKENが未設定のため、実ホストのCookie発行・認証後の一覧・prompt・モデル出力は未確認です。モックHTTPテストは上記契約と安全処理を検証しますが、実DSHでの成功の代替にはなりません。

[起動と実機確認の手順](<../README.md>)／[検証記録](<verification.md>)。
