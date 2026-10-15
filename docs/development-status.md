# 現在の開発状況

この公開リポジトリがソース・テスト・資料・ビルド済みbundleの正本です。開発手順は[canonical development](<canonical-development.md>)、最新の検証証拠は[integration verification](<integration-verification.md>)を参照してください。旧private checkoutでの開発や、非公開Git履歴の取り込みは行いません。

## 実装範囲

- 正式Host/Client bundle、既存Plugin Manager内の設定UI、write-only token入力、revision付き保存と明示的な接続操作。
- 制限版のDiscord slash操作、許可scope、会話共有Binding、既存Native Session選択・テキスト実行・状態・結果参照。RunのSession・操作者・通知先を固定し、不明な受付や通知を自動再送しません。
- 各partの状態・receipt・digest、Binding/Run CAS、将来Runだけに適用する通知設定。自動全文通知の上限と手動参照の違いは[全文配送](<full-output.md>)を参照。
- Windows CurrentUser DPAPIによる秘密保護、private-path検査、metadata専用SQLite。結果本文はSQLiteに保存せず、権限と相関を再確認して同じNative historyから復元します。
- 既存Telegramコードと回帰試験を維持しますが、追加開発・実機互換の保証は行いません。

## 未完了のゲート

制限版は完成仕様の合格ではありません。[仕様書](<../specification.md>)、[制限](<limited-profile.md>)、[第23章](<chapter23-progress.md>)と突き合わせて進めます。

- Desktopとconnectorの共有原子的受付、安定したNative receipt、重複claimと予約の共通線形化点。plugin mutexや状態照会だけでは代替しません。
- trusted owner/bootstrapとcaller-bound認可、独立owner/admin、失効とOrigin/CSRFの正式契約。単一認証operatorやCookieを独立権限分離とは扱いません。
- targeted Run停止、承認・イベント、添付・Artifact、正式history/model/settings/context契約、DM-only、設定C。未対応機能をUIで実行可能に見せません。
- OUT08全文保護保存・保持期限・参照-aware清掃、quota、孤立blobとSQLの分散crash対応。Native history依存を完全保持とは呼びません。
- 正式Plugin Manager導入・同じGUIでの表示、新tokenによるDiscordログイン・コマンド登録、PC↔Discordの同一Session往復、配備root・復旧・長時間運転。mock、synthetic SQLite/DPAPI、pack/import成功では閉じません。

実機確認は[導入・復旧手順](<restricted-installation.md>)に従い、tokenをローカルだけで扱います。npmレジストリ公開、live登録、配備、共有DSH再起動は自動で行いません。
