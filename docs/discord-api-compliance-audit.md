# Discord API準拠監査報告

> 監査時点の記録。後続の修正により実装行番号や挙動は変化し得る。実Discord・実DSHの受け入れは未実施。

**移行上の注意：** 検証済みprotected metadata DBもversion 2に移行する。直前のversion 1のみを受け付ける旧バイナリは移行済みDBを開けない。未移行のversion 1 DBにはこの保護がまだなく、version 2を受け付けてprofileを無視する別の旧バイナリまで防ぐ保証はない。旧バイナリを並行使用せず、pragmaの値を戻してダウングレードしないこと。また、共通Storeの非metadata DBはTelegram専用でもversion 2になるため、version 1のみ対応する旧バイナリでは開けなくなる。

## 総合結論

Discord API仕様との不一致として、直接REST呼び出しでDiscord指定形式の `User-Agent` を設定していないことを確認した。また、429応答の待機時間が本文だけにある条件では、公式が指示する待機時間より早く再試行する可能性がある。Interactionの3秒期限超過や実際の二重応答は、コード上のリスクはあるものの、実際の発生は確認していない。

現在の「正常に動作しない」症状の根本原因は特定できない。Discord側の実ログイン・コマンド登録・操作および実DSHとの往復を実施していないためである。Discord仕様違反が症状を引き起こしたとは断定できない。

| 結論 | 判定 |
|---|---|
| 明確な仕様不一致 | 直接RESTでDiscord指定形式の `User-Agent` を設定していない |
| 条件付きの仕様準拠リスク | 429待機時間がヘッダーにない場合、JSON本文の待機時間を利用できない経路がある |
| Interaction応答 | Deferを先に行う設計だが、3秒・15分の実機保証は未検証 |
| Button／承認／中断 | 現行receiverには接続されておらず、未対応。稼働中のボタン不具合とは評価しない |
| 実DSH連携 | 制限版の実装は存在するが、正式な実機受け入れは未完了 |
| 重点テスト | 既存ビルド済みコードに対するオフラインテスト57件成功。実Discord・実DSHの証拠ではない |

## 対象とバージョン

- 直接RESTはDiscord API v10を指定。v10は利用可能：[API Versioning](https://docs.discord.com/developers/reference.md#api-versioning)。
- [package.json](<../package.json>) は `discord.js 14.27.0`、Node.js `>=22.23.0`。監査時のNode.jsは `22.23.3`。
- ロックファイル上の主な依存は `@discordjs/rest 2.6.3`、`@discordjs/ws 1.2.3`、`discord-api-types 0.38.56`。インストール済みDSHホストが同一依存を解決している証明ではない。
- 主対象は現在の制限版HostとDiscord receiver。旧CLIの登録・DSH接続コードは別経路として扱う。
- 監査ではDiscord公式のInteraction、Application Commands、Components、Gateway、Permissions、Rate Limits、OAuth2、Message、API Referenceを閲覧した。

## Discord API使用箇所

| 対象 | 現在の実装 | 判定 |
|---|---|---|
| Bot本人・Application確認 | [host-runtime.js](<../packages/discord-plugin/host-runtime.js>) が直接HTTPSで `GET /users/@me`、`GET /applications/@me` | Bot認証は妥当。User-Agentに不一致 |
| Guildコマンド登録 | 同Hostが明示操作で `POST /applications/{application}/guilds/{guild}/commands` | 同名コマンド単位のupsert。大量上書きではない |
| 旧CLI登録 | [register.ts](<../src/register.ts>) がdiscord.js RESTで同GuildエンドポイントにPOST | 現行Hostとは別経路。SDK既定の再試行に注意 |
| Gateway接続 | [bot.ts](<../src/bot.ts>) がdiscord.js Clientでログイン。SDK内部で `/gateway/bot` とWebSocketを使用 | Identify／Heartbeat／ResumeはSDK委譲。実接続未検証 |
| Interaction受信 | `InteractionCreate` から、Bot以外の `/agent` chat-inputのみ処理 | 意図した対象に限定 |
| 初回応答 | `deferReply`／`reply`。SDKが `POST /interactions/{id}/{token}/callback` を使用 | Deferの順序は適切。期限の実測なし |
| 応答編集 | `editReply`。SDKが `PATCH /webhooks/{application}/{token}/messages/@original` を使用 | 用途は妥当。15分超の復旧未検証 |
| 宛先確認・通知 | SDKのユーザー／チャンネルfetch、DM作成および `POST /channels/{id}/messages` | 固定先、nonce、結果不明の保護あり。実権限未検証 |
| Components | [独立したguard](<discord-components.md>) のみ | Discord受信・UI・Native承認／中断には未接続 |
| HTTP Interaction受信 | 使用していない | HTTP署名検証は現行経路には適用されない |

## 確認された不一致・優先対応

### P1: 直接RESTのUser-Agent

- 実装： [host-runtime.js](<../packages/discord-plugin/host-runtime.js>) の `discordRequest` は `Content-Type` とBot認証を設定するが、`User-Agent` を明示しない。通常のNode.js fetch既定値はDiscord指定形式ではない。
- 公式：HTTP APIクライアントには有効な `DiscordBot (URL, version)` のUser-Agentが必要で、不正なものはCloudflareにブロックされ得る：[API Reference — User Agent](https://docs.discord.com/developers/reference.md#user-agent)。
- 影響：Bot本人・Application確認やコマンド登録がブロックされ得る。今回の症状で実際にブロックされた証拠はない。
- 推奨：製品URLとバージョンを含むDiscord指定形式を直接RESTに設定し、全経路のヘッダーをモック検証する。

### P1: 429待機時間が本文にのみ存在する場合

- 実装：discord.js RESTは `Retry-After` ヘッダーから `RateLimitError.retryAfter` を生成する。[bot.ts](<../src/bot.ts>) はその値を使い、[engine.ts](<../src/engine.ts>) は0を有効値として最短1ms後を再試行可能とする。別途tick周期も影響する。
- 公式：429では `Retry-After` ヘッダーまたはJSON `retry_after` を基準に待機する：[Rate Limits](https://docs.discord.com/developers/topics/rate-limits.md#exceeding-a-rate-limit)。
- 条件と影響：待機値が本文にはあるがヘッダーにはないと、指定時間を反映せず早期再試行する可能性がある。実Discordからその応答を受けた事実は未確認。
- 推奨：信頼できる待機時間を取得できない場合は自動再試行せず安全側に停止する。ヘッダーなし・小数秒・global/shared等を合成429で試験する。

### P1: Interaction応答期限と曖昧なACK

- 実装：認可後にephemeral deferし、その後DSH処理を行う。順序は適切。
- 公式：初回応答は3秒以内、Interaction tokenは15分有効：[Receiving and Responding](https://docs.discord.com/developers/interactions/receiving-and-responding.md)。
- リスク：スケジューリング、ネットワーク、429待機で初回応答が遅れる可能性がある。`retries: 0` はネットワーク／5xx再試行を抑制するが、Interaction／webhookルートの429待機・再試行は止めない。
- discord.jsはdeferのREST成功後に `deferred = true` を設定する。DiscordがACKを受理後に応答が失われると、アプリが未応答と判断して `reply` を試み、Discordに拒否される可能性がある。実際の二重応答やNative再実行は未確認。Native処理はdefer成功後に開始される。
- 15分超では `editReply` が期限切れになり得る。状態・結果コマンドや別通知はあるが、長時間実機復旧は未検証。
- 推奨：ACK結果不明を通常の未応答と区別し、遅延、429、応答喪失、期限切れ、停止時の故障注入を追加する。実際の期限違反が発生したと断定しない。

### P2: タイムアウトは通信のキャンセルではない

通知処理の `Promise.race` は待機を終了するが、開始済みSDK操作を必ず取り消すものではない。DMの `user.send` は内部でDMチャンネル作成を伴う場合があり、停止・タイムアウト後に処理が進む可能性がある。送信前のdurableな `unknown` フェンスと自動再送禁止は重要な保護である。遅延送信の実際の発生は未観測。SDKのキャンセル可能範囲、停止後の遅延完了・認可変更を故障注入で検証する。

## 公式仕様との比較

| 対象 | 実装と公式要求 | 判定 |
|---|---|---|
| API・認証 | v10、`Authorization: Bot …` | 準拠 |
| 直接REST User-Agent | Discord指定形式を明示しない | 不一致 |
| Slash schema | rootは20項目。各option配列は公式上限25以内 | 静的には準拠。登録実機未検証 |
| 登録 | 同一Application／Guildへ単一POST | 準拠。同名登録は相互に上書きし得る |
| 実行コンテキスト | Guild登録とユーザー／Guild／Channelの照合 | 設計上妥当。実権限未検証 |
| `dm_permission` | `false`。Discordでは非推奨 | 非推奨使用。Guild登録もGuild限定なので直ちに違反とはしない |
| 初回応答 | 認可後にdefer、公式期限は3秒 | 要確認。実測なし |
| 長時間Interaction | defer後に処理・編集、別の結果／通知経路あり。tokenは15分 | 要確認。15分超の実動作未検証 |
| 429 | SDKとEngineで状態管理 | 本文だけの待機値で条件付き不一致の可能性 |
| bucket | SDKと直接fetchは別系統 | global状態を共有する証拠なし |
| メッセージ長 | 2000以下に分割・検査 | 静的には準拠。Unicode実送信未検証 |
| Mention | `allowedMentions: { parse: [] }` | 推奨に準拠 |
| nonce | 24文字と `enforceNonce` | 上限25文字内。直近数分の重複確認であり永続exactly-onceではない |
| Gateway Intent | `Guilds` のみ。通常メッセージ受信なし | 静的には妥当 |
| HTTP Interaction署名 | Gateway受信のためHTTP受信なし | 対象外 |

参考：[Application Commands](https://docs.discord.com/developers/interactions/application-commands.md)、[Message Resource](https://docs.discord.com/developers/resources/message.md)、[Gateway](https://docs.discord.com/developers/events/gateway.md)、[Permissions](https://docs.discord.com/developers/topics/permissions.md)。

## Gateway・権限・セキュリティ

Heartbeat、ACK、sequence、Identify、Resume、再接続はdiscord.js／`@discordjs/ws` に委譲。SDK内部の実装はあるが、実ネットワーク切断・無効セッション・イベント欠落からの回復は実証していない。Discordはイベントの欠落・重複を明記している：[Consistency](https://docs.discord.com/developers/reference.md#consistency)。SDK Resumeは業務イベントの完全配送保証ではない。

[policy.ts](<../src/policy.ts>) はユーザー、Guild、Channelを照合し、Discord側のコマンド表示権限だけに依存しない。Guild通知にはチャンネル閲覧・送信権限、スレッドにはスレッド送信権限が必要。DM拒否や権限不足は実機未確認。origin通知はチャンネル閲覧者に見えるため明示確認が必要。

HostはBot／Applicationの一致を確認しWindowsの保護ストアを使用するが、同一OSユーザー・管理者やプロセスメモリーの侵害まで防ぐ証明ではない。Bot招待とBot tokenを使用し、通常ユーザーアカウントは自動操作しない：[OAuth2](https://docs.discord.com/developers/topics/oauth2.md#bot-users)。

## Components・承認・中断

現行receiverはButton、Select Menu、Modalを処理しない。[bot.ts](<../src/bot.ts>) はchat-input以外を除外し、[commands.ts](<../src/commands.ts>) は承認・targeted stopを未対応とする。これは完成仕様の未達項目だが、承認・停止を無効とする制限版の範囲では、稼働中の不正な承認処理ではない。

[ComponentActionGuard](<../packages/discord-plugin/discord-components.js>) は短い不透明ID、期限、ユーザー・Binding・対象versionの照合、同一IDの同時消費防止を実装する。IDはDiscordの100文字制限内。ただし稼働中の承認ボタンではなく、Native操作の原子的保護も提供しない。異なるgrantの同一対象競合を含め、将来の統合では変更直前の認可・対象状態再検証と対象単位のNative CAS等が必要：[Component Reference](https://docs.discord.com/developers/components/reference.md)。

## 根本原因候補

| 候補 | 証拠と評価 |
|---|---|
| 直接RESTのUser-Agent | 仕様不一致は確認。実際にブロックされたログがなく、今回の原因か不明 |
| Token／Application／Guild不一致 | Hostは本人・Application一致を検証し不一致で停止。実設定未確認 |
| コマンド未登録／権限不足 | 登録は明示操作。Guild参加、コマンド・チャンネル権限は実機未検証 |
| Interaction期限・429 | 実装上リスクがあるが、期限超過や429発生の証拠なし |
| DSH Native Session／受付状態 | Engineは認可、Binding、Session、queue等を確認してから送信。条件不成立はDiscord以外の停止原因になり得る |
| Native契約・実機受け入れ不足 | [開発状況](<development-status.md>) に共有原子的受付、Native契約、実Discord／DSH往復等の未完了ゲートがある。重要な調査領域だが実障害の証明ではない |
| 未実装機能 | 承認、targeted stop、DM-onlyなどは意図的に未対応 |

FoundationHostの全capabilityがfalseという記述だけで製品receiverが存在しないと判断しない。制限版DiscordHostの起動処理は別に存在するが、実機受け入れは未完了。

## 検証と追加検証

監査では既存 `dist` にある接続通知、出力通知、作業開始通知、独立component guardのテストを直接実行し57件成功、失敗・スキップ0件。合成429／503、通知先再認可、不明時の再送防止、同一grantの並行消費、停止中の遅延完了を確認した。429試験は `/channels` の合成POSTであり、Interaction／webhookではない。

再ビルドはしておらず、既存のビルド済みコードに対する結果である。現在の未コミット変更を含む全ソースを再ビルドした証拠ではない。過去の全回帰結果は[検証記録](<integration-verification.md>)にあるが、この監査での実行結果ではない。

1. User-Agent、429のヘッダー／本文、単位変換、不明待機時間をオフライン検証。
2. ACK遅延・成功後の応答喪失・429・15分超・再接続・同一Interaction再配送を故障注入。
3. 許可された実機環境でBot本人確認、明示的Guild登録、権限不足、ephemeral応答、長時間Runと結果取得を段階的に確認。Tokenはローカル保護ストアのみで扱う。
4. 同一SessionのPC→Discord→PC、Desktopとの競合、再起動・不明受付を確認。未確定promptは再送しない。
5. Components実装後、古いボタン、異なるgrantの競合、権限失効、Native CAS、再起動後無効化を別途受け入れる。

実機確認までは「Discord仕様違反が今回の不具合の原因」とも「Discord連携は正常」とも結論づけられない。

## 後続修正と残る制約

監査時点の上記記録とは別に、直接RESTのUser-Agentを追加し、待機値が0・不正・不明な429を自動再送しないようにした。曖昧な初回ACKや応答編集の失敗では、二重ACK／編集を行わない。DMチャンネル作成とメッセージ送信を分離し、作成後にも停止と認可を再確認する。送信開始後の結果不明は引き続き自動再送しない。旧Discord経路も送信前に `unknown` を永続化する。旧版の送信待ちデータは、実際には未送信であっても過去の送信結果不明と区別できないため、初回移行時に保留する。version 1のみを受け付ける直前の旧版による再送を防ぐため、通常モードと検証済み制限版プロファイルのDBバージョンを2に上げる。この旧版は移行済みDBを開けなくなる。Telegram専用の通常モードDBにも同じ下位互換性の制約が適用される。既存制限版DBは正しいマーカーとテーブルを検証してから移行する。新規DBは排他的に作成し、既存ファイルは専用プロファイルの検証に回す。DBパスの付け替えを防ぐには親ディレクトリが信頼できるACLで保護されている必要がある。新規作成後、Hostがマーカーを書き込む前に中断すると、次回は未確認DBとして拒否され、手動復旧が必要になる。

Interactionの3秒・15分を実環境で保証したわけではない。SDK内のInteraction／webhookへの429待機や、実行中のNative処理が遅延した際の安全なシャットダウンには追加検証・設計が必要。停止は処理の完了を待つため時間上限は保証されない。待機だけをタイムアウトしてStoreを閉じると、残ったNative処理が後から副作用や保存を行い得るため安全ではない。接続通知のNativeメタデータ取得も、通知側のタイムアウト後にStoreへアクセスし得るため、停止時には元の処理が終わるまで待つ。Native側が応答しない場合は停止・再接続も待ち続ける可能性がある。`Promise.race` は既に開始された通信を取り消さず、送信開始後の遅延完了は依然起こり得る。DiscordとDSHの実機受け入れ、Nativeの原子的な受付、承認／中断等の未対応機能も引き続き未完了。
