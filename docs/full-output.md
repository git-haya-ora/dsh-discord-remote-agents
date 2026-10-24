# 制限版の全文最終回答配送

対象はBridgeが受付けたDiscord Runです。本人DMを既定とし、添付・Artifact・通常DM操作は引き続き無効です。実Discordの受入試験は未実施です。

## 本文と分割

- [エンジン](<../src/engine.ts>)は`rpcId → turn`を照合した最後のassistant messageのtext blocksを最終本文として採用します。tool invocationを含むmessage、tool logs、reasoning、過去の中間assistant messageを連結しません。Nativeに正式な「final」属性があるとの主張ではなく、現在確認済みイベント契約によるターン終了時の最後の回答です。
- 原文UTF-8 SHA-256と、既知秘密をマスクした配信本文SHA-256は別です。秘密のマスクが発生した場合、配信の結合本文が原文digestと一致するとは主張しません。失敗・中断では状態説明と取得済みの最後の回答を表示します。
- [分割処理](<../src/output.ts>)はUnicode code point境界を保ち、改行・コードをtrim／正規化しません。各messageはRun ID・part番号・表示補完を含み2,000 UTF-16 units以内です。本文sliceと表示用フェンス補完は別フィールドで、slice結合を元本文と照合します。長過ぎるフェンスmarkerは補完しませんが原文は保持します。不正な孤立surrogateは黙って置換せず配送不可にします。
- 自動配送は100,000 code pointsかつ128 partsまで。超過は最終partに「全文配信未完了・上限・PCの同一Session確認」を明示し、元のdigestを維持します。手動`/agent result run:<id> page:<n>`は自動配送capとは独立に同じ保存／復元本文を順に読めます。長文textファイルは作成・送信しません。
- mentionsを空集合、embedsをSuppressEmbedsとして送信します。旧Telegram／旧CLI添付経路は変更しません。

## Durableな配送状態

[Store](<../src/store.ts>)の一つのRun JSON保存でNative terminal、受付時に固定した宛先、digest、part数・各part状態を確定します。SQLiteはFULL synchronous、排他接続を使用し、Run revisionによる同期CASで古いreadの上書きを拒否します。

各partは`pending → sending → sent`。ネットワーク呼出しの前に` sending`と不明配送fenceを保存します。Discord message IDを保存した`sent`は再送しません。再起動で残った`sending`は`unknown`となり、後続partを保留します。成功応答後・ID保存前のcrashも同様です。IDを取得できない応答はsentと扱いません。

429は明示された待機時間を永続保存して待ち、順序を維持します。timeout／曖昧エラーは`unknown`で自動再送しません。DM拒否・権限喪失は`blocked`で、公開channelなどへ転送しません。現在のSDK内部rate-limit処理も有効ですが、実429・SDK内再試行挙動のライブ試験は未実施です。

明示retryは最初の未確定partだけを対象にし、unknownには重複リスク確認が必須です。履歴・nonceによる自動Discord照合は未実装なので、未知配送が確定したとは表示しません。retryでNative promptは呼びません。旧unknownでpart計画がない履歴は自動移行／再送しません。Native実行成功と配送失敗は別状態です。

## 通知設定と認可

`notifications set`は将来のRunだけに適用します。originは認可済み元サーバー会話への公開配送を明示確認した場合のみ。既存Runの宛先は変えず、DM操作を有効化しません。途中通知は未対応なので`progress:true`を拒否します。

受付・結果参照・retry・配信preflightと各part直前で元actor／conversationとNative Session／cwdを検証します。Session Bindingは会話間で一意、Binding versionで比較更新します。create中に選択が変わった場合は作成済みIDを示し、選択を上書きしたり作成を再送したりしません。

## 本文保護・保持の境界（OUT-08部分実装）

restricted-storage profileではprompt／assistant本文／part本文をSQLiteに平文保存しません。終端Runのredacted本文は、Bridge専用の`bridge-output` profileとランダムな256-bit opaque refを使い、SQLiteに準備intentを永続化してからWindows CurrentUser DPAPI payloadとして保存します。final本文chunkと配送partを個別にreadbackし、固定Native Session・Run／request・prompt digest・start/turn/sequence・actor／binding／pinned destination／deployment identityと各digestを再検証した後に、Run terminal stateとmanifestを同じSQLite transactionで公開します。取得時も同じscope／deploymentを再確認し、DPAPI read前後で期限・Run／manifestを検証します。さらに本文を返す直前、最後のNative Session authorization await後に現在のdeployment／Binding version／intent／期限／manifestを同期的に再照合し、期限をまたいだstatus／result readは`BODY_EXPIRED`で拒否します。Native履歴は公開済み本文の復元に必要ありません。正式なNative durable receipt/provenanceが得られたとは主張しません。

本文は最大200,000 Unicode code pointsまで15,000-codepoint chunkで保持し、truncateしません。128 MiB quotaはSQLite本体・journal/WAL/SHM sidecar、実在する暗号化payload（孤立・未認識fileを含む）および未確定reservationを数え、超過や不整合では新規admission／公開をfail closedします。全partのdefinitive sent receipt後にのみ解決時刻を記録し、その7日後にmanifestに固定されたrefだけを削除します。`unknown`、未送信、blocked、曖昧なdeliveryとprepared intentは期限削除せず保持します。metadata/tombstoneの90日pruningは未実装で、unknown/orphan fileの自動削除もしません。

この部分実装のfixtureは再起動時の同一payload復元、prepared partial write、receipt不明の保持、expiry／exact-ref cleanup、quota fenceとSQLite plaintext absenceを検証しますが、実電源断／process-kill全境界、複数Store・cross-process quota競合、90日metadata pruning、実Host/DiscordでのNative receiptとlive受入は未検証です。protected outputに不整合があればNative履歴や別回答で代用しません。現行runtimeの詳細と検証数は[開発状況](<development-status.md>)および[検証記録](<verification.md>)を参照してください。

## 検証

[全文配送試験](<../test/full-output.test.ts>)はUnicode・code fences・cap、順序、各partの再起動、送信成功後保存前crash、429待機、timeout、DM拒否、認可撤回、digest不一致、秘密非平文、Binding／Run CAS、prompt非再送をsynthetic adapterと一時SQLiteで検証します。実Discord／実モデル往復や電源断の証明ではありません。総合結果は[検証記録](<verification.md>)を参照してください。
