# 第23章：追加要件の実装範囲と受け入れゲート

対象：[仕様書 第23章](<../specification.md#23-日常操作コマンド本人dm操作案最終出力2026-10-14追加>)。2026-10-15の開発ブランチにおける要件整理。ソース・fixtureの成功と実機受け入れは区別する。

## 範囲と優先順

1. A：正式に確認できたSessionサービスによる一覧・現在対象・Run一覧・診断（履歴はfield-filtered契約待ちで未登録）とコマンド整理。
2. A：全文を順序付きpartへ分割する通知。Native相関・固定先・digest・各part状態・不明配送非再送を維持する。
3. A：モデル／推論の一覧・取得・条件更新・再読込契約が未確認の場合は未対応理由を示す。指示文、DB編集、ASAR変更で代用しない。
4. B：DM-onlyは明示導入・受信の設計／実証対象。既存guild設定を自動移行せず、実Discord実証なしにDM受付を有効化しない。
5. C：停止・承認・キュー・添付／Artifact・通常チャット・Native圧縮は未対応のまま。Telegram追加開発はしない。

## 追加ACの扱い

| 条件 | 本ブランチで検証するソース／fixture | 未完了の実機ゲート |
| --- | --- | --- |
| AC-43 | 登録schemaの階層上限、helpの実装整合、認可、検索／ページング | 実Discord登録・表示・実Host接続 |
| AC-44・45 | モデル／推論操作を偽装せず未対応を説明 | 正式catalog／settings read・write・readback・revision契約とDesktop競合 |
| AC-46・47 | DM操作が既定拒否、既存guild運用を維持 | User Install・global BOT_DM・Gateway・component／modal、1対1 recipient検証、DM／guild同一Session一意性 |
| AC-48 | 長文・日本語・emoji・コード・上限・順序・本文再構成 | 実Discord受信partとNative最終本文のdigest照合 |
| AC-49 | Bot認証通知経路、固定先、blockedと実行状態の分離 | 15分超の実Run、実DM拒否・宛先削除・権限失効 |
| AC-50 | partごとのdurable状態、送信後保存前crash、429・timeout、通知のみretry | 実Host／Discordの再起動・障害・照合 |
| AC-51 | 将来Runだけに通知方針適用、origin／重複リスクの明示確認 | 正式Native設定resetは未対応 |
| AC-52 | 既存unknown・Run送信先・本文非平文の維持 | DM-only設定・正式前方移行／復旧は未実装 |

### 全文配送の実装境界

OUT-01〜07のsource実装は[全文配送](<full-output.md>)、日常コマンドの登録・未対応理由は[コマンド資料](<new-commands.md>)に記録する。OUT-08はSQLite本文非平文、同一RunのNative履歴とdigest照合、本文参照7日期限まで。DPAPI保護payloadへの全文durable保存・参照-aware清掃は未統合であり、OUT-08全体を完了扱いにしない。history喪失時はmetadata-only statusを維持し、本文を取得不能とする。正式なmodel/settings/context契約、DM操作、Profile Cは引き続き無効。

表中の検証対象は合格宣言ではない。実施した試験数、失敗・skip、配布artifact検査は[検証記録](<verification.md>)に追記する。実機未検証のACをmock成功で達成済みにしない。

## レビューと公開

- 変更の担当範囲を合意し、共有Git操作は一人の統合担当に直列化します。公開前に独立レビュー、統合試験、秘密・禁止ファイル検査を行います。
- この公開リポジトリを開発の正本とし、review branchから通常のcommit/pushで公開します。private Git履歴は取り込みません。手順は[canonical development](<canonical-development.md>)を参照してください。
- token・秘密・実設定・DB・ログ・ローカルartifactをstageしません。実Bot command登録、実DSH設定変更、共有DSHの停止、ASAR変更は自動実施しません。
