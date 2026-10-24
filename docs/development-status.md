# 現在の開発状況

この公開リポジトリがソース・テスト・資料・ビルド済みbundleの正本です。開発手順は[canonical development](<canonical-development.md>)、最新の検証証拠は[integration verification](<integration-verification.md>)を参照してください。旧private checkoutでの開発や、非公開Git履歴の取り込みは行いません。

## 実装範囲

- 正式Host/Client bundle、既存Plugin Manager内の設定UI、write-only token入力、revision付き保存と明示的な接続操作。
- 制限版のDiscord slash操作、許可scope、会話共有Binding、既存Native Session選択・テキスト実行・状態・結果参照。RunのSession・操作者・通知先を固定し、不明な受付や通知を自動再送しません。確認済みの同一turn/step/requestId付きNative user append後にだけ「作業中」を固定先へ通知します。
- `/agent models` のread-only catalogと、明示的な no-CAS 承認・再認可・readbackを伴う選択中Sessionのタイトル変更。`/agent current` は直近の要求modelと次回設定を区別し、実行中modelとは断定しません。model/reasoning mutationは共有Host既定への書込みがあるため無効です。
- 各partの状態・receipt・digest、Binding/Run CAS、将来Runだけに適用する通知設定。自動全文通知の上限と手動参照の違いは[全文配送](<full-output.md>)を参照。
- `/agent compact confirm:true` と `/agent context compact confirm:true` は、確認済みNative commandで選択中の許可Agentを圧縮します。idle/queue/対象を再確認し、結果不明はdurable `unknown`として自動再送しません。未解決の結果は完全一致するSessionだけを新規prompt・bind先・title変更からfail closedにし、このBridgeに解除操作はありません。Engine/Host/adapter-contractのsynthetic testsは実Native／Discord受け入れを証明しません。
- `/agent context show` は許可済み選択Sessionのexact live lookupから、`contextPressure`/`contextBreakdown`の最大6個のoptional safe-integer scalarとfold cursor `asOfSeq`だけを表示します。別aggregateはatomicでもfreshness付きでもなく、0・cursor進行はsampleの存在/currentnessを証明しません。実際のoccupancy/percent/costや欠落値は推測せず、optional projectionの不在は通常Host/Compact動作を止めません。
- Windows CurrentUser DPAPIによる秘密保護、private-path検査、metadata専用SQLiteに加え、終端Runのredacted本文／partをBridge専用DPAPI profileへdurable保存するOUT-08部分実装。prepared intent、random opaque refs、容量quota、readback＋固定scope確認、Run/manifestのatomic SQL publish、送達確定後7日のexact-ref cleanupを実装。unknown/未送信は保持し、SQLiteに本文を平文保存しません。
- 既存Telegramコードと回帰試験を維持しますが、追加開発・実機互換の保証は行いません。

## 未完了のゲート

制限版は完成仕様の合格ではありません。[仕様書](<../specification.md>)、[制限](<limited-profile.md>)、[第23章](<chapter23-progress.md>)と突き合わせて進めます。

- Desktopとconnectorの共有原子的受付、安定したNative receipt、重複claimと予約の共通線形化点。plugin mutexや状態照会だけでは代替しません。
- trusted owner/bootstrapとcaller-bound認可、独立owner/admin、失効とOrigin/CSRFの正式契約。単一認証operatorやCookieを独立権限分離とは扱いません。
- 正式なfiltered history、Session-only model/reasoning selectionとsettings reset、正確でfresh/request-correlatedなcontext使用量・直近Run token/cost、DM-only、targeted Run停止、外部承認/event、共有Desktopと一体のFIFO queue、添付・Artifact・通常chat、設定C、およびNative Compact/context projectionの実機受け入れ。限定projectionの表示やsynthetic testsをDiscord bridgeのlive acceptanceとは扱わず、未対応操作をUIで完了済みに見せません。
- hydrated status／result readは、最後のNative Session authorization await後にもdeployment／Binding version／intent／TTL／manifestを再検証し、期限をまたいだ返却を拒否する回帰を追加しました（synthetic race fixtureのみ）。
- OUT08の未完了分：90日metadata/tombstone pruning、全process-kill／電源断／複数Store・cross-process quota競合の完全検証、official Native durable receipt/provenance、live Host/Discord受入。孤立・未認識blobは容量に算入し、自動削除しません。
- 正式Plugin Manager導入・同じGUIでの表示、新tokenによるDiscordログイン・コマンド登録、PC↔Discordの同一Session往復、配備root・復旧・長時間運転。mock、synthetic SQLite/DPAPI、pack/import成功では閉じません。

実機確認は[導入・復旧手順](<restricted-installation.md>)に従い、tokenをローカルだけで扱います。npmレジストリ公開、live登録、配備、共有DSH再起動は自動で行いません。
