# 第23章：追加要件の実装範囲と受け入れゲート

対象：[仕様書 第23章](<../specification.md#23-日常操作コマンド本人dm操作案最終出力2026-10-14追加>)。2026-10-15の開発ブランチにおける要件整理。ソース・fixtureの成功と実機受け入れは区別する。

## 範囲と優先順

1. A：一覧・現在対象・Run一覧・診断、read-only model catalog、明示no-CAS同意付きtitle rename、実Native start相関後の「作業中」通知を実装。filtered historyはfield-filtered契約がなく未登録。
2. A：全文を順序付きpartへ分割する通知。Native相関・固定先・digest・各part状態・不明配送非再送を維持する。終端本文/partのDPAPI保護保存、readback、intent/quota、確定receipt後7日retentionとexact-ref cleanupを部分実装。90日metadata pruning、全process-kill/cross-process quota proof、official Native receipt、live acceptanceは未完了。
3. A：model/reasoning mutationはHost既定も変更するNative APIのため無効。title renameはNative CASがなくDesktopとの競合を防げないため、明示同意・事前/事後Binding確認・readbackが必要でもfull AC-44/45保証ではない。context token/timingは真のcontext使用量として表示しない。
4. B：DM-onlyは明示導入・受信の設計／実証対象。既存guild設定を自動移行せず、実Discord実証なしにDM受付を有効化しない。
5. C：targeted stop・external approval・共有FIFO queue・添付/Artifact・通常chatは未対応。Native Compactは明示確認付きcommand、対象Agent/Session再確認、idle/queue guard、durable unknown/no-replayを実装したが、synthetic fixtureの成功を実Native／Discord受け入れとは扱わない。Telegram追加開発はしない。

## 追加ACの扱い

| 条件 | 本ブランチで検証するソース／fixture | 未完了の実機ゲート |
| --- | --- | --- |
| AC-43 | 登録schemaの階層上限、helpの実装整合、認可、検索／ページング | 実Discord登録・表示・実Host接続 |
| AC-44・45 | read-only catalog/current projection、no-CAS title consent + Binding checks + readback、unsafe model mutation拒否 | Session-only settings CAS/readback、title CASまたはDesktop競合の閉鎖、real Host/Discord validation |
| AC-46・47 | DM操作が既定拒否、既存guild運用を維持 | User Install・global BOT_DM・Gateway・component／modal、1対1 recipient検証、DM／guild同一Session一意性 |
| AC-48 | 長文・日本語・emoji・コード・上限・順序・本文再構成 | 実Discord受信partとNative最終本文のdigest照合 |
| AC-49 | Bot認証通知経路、固定先、actual-start相関、blockedと実行状態の分離、shutdown時lookup/send timeout fence | 15分超の実Run、実DM拒否・宛先削除・権限失効、Discord delivery/readback |
| AC-50 | partごとのdurable状態、送信後保存前crash、429・timeout、通知のみretry | 実Host／Discordの再起動・障害・照合 |
| AC-51 | 将来Runだけに通知方針適用、origin／重複リスクの明示確認 | 正式Native設定resetは未対応 |
| AC-52 | 既存unknown・Run送信先・本文非平文の維持 | DM-only設定・正式前方移行／復旧は未実装 |

### 全文配送の実装境界

OUT-01〜07のsource実装は[全文配送](<full-output.md>)、日常コマンドの登録・未対応理由は[コマンド資料](<new-commands.md>)に記録する。OUT-08はBridge専用DPAPI protected output profile、durable intent／quota、terminal Run+manifestのatomic publish、readback／scope検証、全part確定receipt後7日retention／exact-ref cleanupまで部分実装した。unknown／未送信／blocked／prepared outputは保持し、orphanは自動削除しない。90日metadata pruning、完全な電源断/process-killと複数Store quota検証、official Native receiptとlive受入は未完了であり、OUT-08全体を完了扱いにしない。正式なmodel/settings/context契約、DM操作、Profile Cは引き続き無効。

表中の検証対象は合格宣言ではない。実施した試験数、失敗・skip、配布artifact検査は[検証記録](<verification.md>)に追記する。実機未検証のACをmock成功で達成済みにしない。

## レビューと公開

- 変更の担当範囲を合意し、共有Git操作は一人の統合担当に直列化します。公開前に独立レビュー、統合試験、秘密・禁止ファイル検査を行います。
- この公開リポジトリを開発の正本とし、review branchから通常のcommit/pushで公開します。private Git履歴は取り込みません。手順は[canonical development](<canonical-development.md>)を参照してください。
- token・秘密・実設定・DB・ログ・ローカルartifactをstageしません。実Bot command登録、実DSH設定変更、共有DSHの停止、ASAR変更は自動実施しません。
