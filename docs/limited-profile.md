# Discord制限版 — 合意した実装プロファイル

2026-10-14、利用者は以下の制限で、現在のDSH上の正式Host／Client bundle実装を進めることに合意した。これは[完成仕様](<../specification.md>)のP0合格やP2完成を意味しない。完成仕様は将来目標として保持し、この文書を今回の限定実装の優先規範とする。

## 明示的に変更した保証

| 項目 | 制限版で合意した扱い |
|---|---|
| 管理主体 | DSH認証済みGUIを使える単一利用者を管理operatorとして扱う。独立owner/admin本人確認、委譲、caller-bound grant、個別失効の保証はない。DSH operatorを共有する相手も同じ管理権限を持つ。 |
| Native受付 | 正式HostのSessionサービスを使う。送信前のbusy／未処理inbox確認は行うが、確認から送信までのDesktop競合を防ぐ原子的受付や永続Native receiptは保証しない。 |
| 利用方法 | PCとDiscordから同じSessionを**交互に**使う。同時送信は非対応。結果の混在を検出したときは配信せずPC確認へ誘導する。 |
| 優先機能 | テキストの既存Session一覧・選択・継続、新規作成、送信、状態／結果、Discord通知、既存DSH内の設定GUI。 |
| 非対応 | Native Run指定停止、承認回答、添付入力、Artifact操作は無効。PCの正式GUIで実施する。Telegram追加開発も延期する。 |
| 導入／認証 | 正式bundle方式を維持する。Plugin Managerへの実導入と新Bot tokenの安全なローカル入力は利用者操作が必要な場合がある。 |

これ以外の安全要件を黙って緩和しない。特に認証回避、別server、本体ASAR変更、共有DSHの停止、Cookie／既存秘密の探索、研究抽出への実行時依存は行わない。

## 維持する安全境界

- HostのみがBot token、Bot接続、Native操作、永続化を所有する。GUIのtoken入力は書込み専用で、読戻し・URL・ログ・一般設定・ブラウザー永続化へ出さない。
- tokenはWindows CurrentUser DPAPIで保護し、保存／更新とreceiver開始を分離する。平文fallbackを作らない。本文・結果を永続化する場合も保護し、旧CLIの平文出力DBを新bundleへ暗黙移行しない。
- 許可ユーザー、Guild、会話ID、作業フォルダーを検証する。フォルダー許可はSession選択の境界であり、OS／DSH実行権限のサンドボックスではない。
- 新bundleのBindingは会話単位で共有し、既存CLIの個人Bindingは自動コピーしない。送信を受け付けたSession、操作者、操作元、通知先は固定する。
- 送信前に意図を永続化し、同一入力IDの再観測を識別する。同一IDで別内容は拒否する。不明な送信は`unknown`としてSessionをブロックし、Native promptを自動再送しない。
- `accepted`は受付応答であって実行完了・安定Native Run receiptではない。対応する`rpcId`／turnと終了イベントを照合し、idleだけで成功と判断しない。
- 設定変更・停止・disposeはこのpluginのreceiver資源だけを解放する。開始済みのDSH処理を停止したり、未確定記録を消したりしない。
- 通知はモデル指示と区別する。第23章の追加ブランチでは各partの送信前fence・message IDを記録し、送信不明は後続を保留して自動再送しない。判定不能な配送の明示再試行には重複リスクの確認が必要で、モデル指示を再送しない。既存unknownを消したり、再送可能へ自動移行したりしない。Discord側との分散exactly-onceは保証しない。

第23章の開発版 `0.2.0-restricted.4` は各partの状態・receipt・digest、Binding／Run revision CAS、将来Runだけの通知設定を追加する。[全文配送](<full-output.md>)の自動capは100,000 code points／128 parts、手動resultは独立page参照でありtext添付を送らない。SQLiteに本文を置かず再起動後は検証済みNative履歴に依存する。保護payloadへの全文保存・清掃（OUT-08全体）は未統合。historyも不要なprivate fieldを取得しない正式filter契約がないため未登録。正式モデル／設定契約、DM操作、C機能は未対応のままで、この公開repoで開発を継続するが、full-spec完成やnpm registry公開とは扱わない。

## 検証と完成の区別

次の証拠を分離して記録する。

1. strict build、mock／回帰、ローカルDPAPI／SQLite fixture。
2. 配布artifactの内容と秘密検査、研究runtime依存なし。
3. 正式Plugin Manager導入、既存DSH URLでのrefresh後の設定表示・保存・開始／停止。
4. ローカルで新tokenを設定後、実Discordログイン・許可／拒否・同一SessionのPC→Discord→PC・通知。
5. 実Host再起動／通信不明時の復旧と非再送。必要な再起動は利用者が安全な時点で実施する。

1・2だけの成功を3〜5の合格としない。管理者分離・Desktop共有atomic admission・安定Run／承認／停止のRFC-M/A/N要件は完成版では引き続き未達。制限版の導入可能なソース／bundleを提供しても、実機未検証なら運用可・全仕様完了と表示しない。
