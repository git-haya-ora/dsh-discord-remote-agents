# Discord通知Outboxの内部基盤

対象は[仕様書](<../specification.md>) §15.4／22.5／22.6の独立した部分実装です。**INTERNAL DESIGN**であり、正式sender、GUI導入、実Discord配信やAC-40合格を意味しません。Hostの全Capability falseと管理拒否を維持します。

## 保存境界と固定通知先

[専用SQLite journal](<../packages/discord-plugin/outbox-journal.js>)と[型](<../packages/discord-plugin/outbox-journal.d.ts>)は旧CLI・秘密journal・受付journalとは別の私有root／schemaを使います。通知本文・token・Native出力は保存せず、不透明な保護payload参照とdigest、固定Run／owner／Binding／Workspace、Botと元のGuild／channel／thread、logicalEventKeyを保存します。payloadの保護・digest照合・読み込みは呼出側の未実装責務です。

重複キーは`(transport, botId, ConversationKey, logicalEventKey)`です。threadなしは一意性キー内で明示的に正規化し、SQL NULLの重複許容を使いません。同一キーの一致入力は同じdeliveryを返し、scope・payload等が異なる入力は競合拒否します。現在のBindingや新Botへ通知先を変更するAPI、別channel／DMへのfallbackはありません。logicalEventKeyは正式イベント相関から呼出側が供給する安定値であり、このmoduleがNativeイベント式を創作しません。

**別DBのため、terminal状態とOutbox投入の同一transactionは未実装です。** 現在の受付journalへの通知配線は行わず、終了確認→このDBへの保存の間の消失窓を解消したとは扱いません。将来の統合Run storeと同一transaction、または正式に検証した復元契約が必要です。SQLite commitはDiscordやNativeと分散原子transactionではありません。

## Claim・callbackと世代fence

pending／期限到来したretry_waitだけをrow version CASでsendingへcommitします。成功してもHTTP送信は行いません。Botごとの現在generation／leaseEpoch／settingsRevisionを期待値と照合し、世代更新では古いsendingを同じtransactionでdelivery_unknownへ保留します。旧callbackの更新はrow versionと現fenceの両方で拒否します。

leaseはローカルの所有・競合制御であって、Bot本人確認・管理者資格・設定認可ではありません。呼出側はcanonicalなBot identityと現在の正式設定revisionを検証し、claim前および**外部送信の直前**に元Runのowner scopeと固定Conversationの現ACLを再確認する必要があります。rebind自体で旧通知を拒否せず、元のscope／Bot／送信先で判断します。古い大きなrevision等を自己申告すれば安全になるという契約ではありません。

ローカルfenceは既に送信されたHTTPのremote commitを取り消せません。再open時のsendingもdelivery_unknownへ移し、送信前に停止したか成功後DB保存前に停止したかを推測しません。送信停止・所有者disposeのawait、正式receiver leaseとの接続は未実装です。

## 結果分類と非再送

| 信頼した結果 | このsliceの保存判断 |
|---|---|
| 成功と固定先のDiscord message ID | sent、message IDを固定 |
| 401 | blocked、認証修復待ち |
| 403／404 | blocked、元通知先の修復待ち |
| 429と有効な指定待機時間 | retry_wait、指定時間を尊重（60秒へ短縮しない） |
| 正式なAPI契約で送信不受理が確定した5xx | retry_wait、1〜60秒の指数backoff＋jitter |
| retry可能な連続失敗が10回 | dead_letter、以後claim不可 |
| 応答欠落・timeout・一般の通信障害・曖昧5xx・不正結果／待機時間 | delivery_unknown、推測再試行なし |

nextAtは判断時に一度保存し、再起動でjitterを引き直しません。429も連続失敗数に含めます。時刻／counter／versionの範囲逸脱は安全拒否し、DB成功や配信成功とみなしません。

[Discord公式rate-limit資料](<https://github.com/discord/discord-api-docs/blob/main/developers/topics/rate-limits.mdx>)は`retry_after`を小数秒と定義しています。このjournalの内部値は正規化した整数msであり、正式senderは秒→msの切上げ、ヘッダーとの整合、bucket／global rate limitを別途扱う必要があります。HTTP値を直接msと解釈するparserは実装していません。

インストール済みREST依存（2.6.3）の静的確認では、既定`retries: 3`でretry可能なnetwork例外と5xxを内部再実行します。将来のsenderはSDK内の隠れた再試行・429待機を含めてattempt／lease／重複リスクを検証し、Outbox側だけで10回上限や非再送を保証したと扱ってはいけません。依存の設定変更やlive送信は行っていません。

構造が正しい結果はDiscordの真正性や不受理証拠ではありません。呼出側が正式SDK／HTTP契約と応答相関を検証して初めて「確定不受理5xx」として分類できます。仕様の通信障害再試行のうち、**送信前に確実に不受理だった通信失敗**の証明・分類・backoff配線は未実装です。曖昧なtimeoutをretry可能なnetwork resultへ勝手に変換しません。

unknown／blocked／dead_letterを解除するAPIはこのsliceでは提供しません。履歴／nonce照合、重複可能性表示と管理者の通知のみ再試行確認には正式認可と検証済み照合契約が必要です。新generationによるunknown解除はありません。ただし、異なるlogicalEventKey／Conversation／Botを自己申告すれば別の重複キーとなるため、このDBだけでは同じ実イベントの新キー迂回を証明・防止できません。呼出側は認証済み元Run／イベントと固定通知先の対応を保全し、曖昧通知を新キーで作り直してはいけません。Native submitを呼ぶコードはありません。

## 保護rootと検証区分

[Windows秘密基盤](<windows-secrets.md>)と同じSID／祖先ACL／reparse／logging方針を専用Outbox rootに適用し、秘密・受付rootの許可file集合は広げません。schema・永続metadata・counter、state／reason／failureの関係、過去fenceと現在leaseの整合を変更前に検証し、異物・不正versionを自動移行しません。claimはsendingのcommitだけでなく、結果／復旧の追加version incrementも予約してから許可します。上限直前は変更せず拒否し、read／再openを維持します。writer guardはローカルjournal専用で、別MVPや他storeのreceiver排他を代替しません。

`memoryForTests()`はdurable:falseのSQLite判断試験です。実file fixtureは`DSH_DISCORD_TEST_PRIVATE_PARENT`または通常TEMPのfresh rootに本番gateを適用し、`OUTBOX_PRIVATE_PATH_UNSAFE`だけをskip／未検証として報告します。helper／pin／storage unavailableは試験失敗とし、skipへ隠しません。ACL／logging方針を変更しないため、memory成功をnative durabilityや正式配備rootの許可とみなしません。最新の実行結果は[検証記録](<verification.md>)に記載します。

## 残る要件

この独立DBではterminal＋Outbox同transactionは未達で、別schemaの[統合journal](<run-outbox-journal-foundation.md>)がその局所内部処理を担います。既存DBの自動統合・移行ではありません。正式event相関・nonce／履歴照合、管理者修復／重複リスク承認、保護payload、通知進捗集約／優先度・保持期限・移行、GUI診断、正式RFC-M／A／N、receiver／SDKの認証・世代・ACL・送信配線、実Discordの障害注入と24／72時間試験は未完了です。この内部基盤を既存CLIの通知保証やAC合格へ読み替えません。
