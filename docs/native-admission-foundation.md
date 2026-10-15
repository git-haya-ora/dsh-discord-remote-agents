# Native受付・復旧の内部安全基盤

## 実装した範囲

[内部モジュール](<../packages/discord-plugin/native-admission.js>)と[型宣言](<../packages/discord-plugin/native-admission.d.ts>)は、[仕様書の受付・二重実行防止](<../specification.md#L368-L414>)と第22章RFC-Aに沿った**純粋な判定関数**である。DSH API、Native受付サービス、実行スケジューラーではない。Host entryや既存CLIには接続しない。

| 関数 | 判定すること | 判定しないこと |
|---|---|---|
| `validateAdmissionReceipt` | request ID・payload digest・backend・Native Sessionの一致、Run参照、正規UTC日時、revision、`durable: true`という構造 | 発行元の真正性、実際の永続化、共通linearization point |
| `decideAdmissionResponse` | 正しいreceipt付きaccepted／duplicateはaccepted、確定busyはqueued、確定rejectedはfailed、不明応答はunknown | running／完了の推測、Native送信、キュー開始 |
| `reconcileAdmissionLookup` | 同じ受付receiptの復元、固定済みRun・受付時刻・revisionとの競合検出 | 不受理証拠の検証、予約解除、再送 |

acceptedとunknownはSessionをブロックし、すべての判定で`replayAllowed: false`を返す。固定済みreceiptと異なるRunやrevisionを照会から受けても、unknownを維持して元のreceiptを保持する。`not-accepted`、`verified: true`、fenceやproofの文字列だけでは解除しない。正式な証拠検証契約がないため、不受理による再キューを提供しない。

context・応答・receipt・Runは一回だけown-data descriptorのsnapshotへ取り、以後は元のobjectを再読しない。accessor、Proxy、symbol、非列挙fieldは実行せず拒否し、IDのUnicode制御文字も拒否する。receiptは検証後に独立した凍結コピーにする。生応答・proof・例外本文は返さず、固定された理由コードだけを返す。不正なローカルcontext／既存receiptは固定エラーで拒否する。

## 呼出し側の必須条件

- 応答・照会の発行元は、**別途検証済みの正式な上流契約**で信頼できる必要がある。構造検証は認証・管理者認可ではない。
- 送信前にdispatchingを永続化する。応答判定はそのdispatching、照会判定はunknownに限る。running・terminalを上書きする汎用reducerとして使わない。
- 判定結果はRun versionのCASとSession予約の整合性を保って永続化する。関数の呼出しだけで予約解除や副作用を行わない。
- busyからのqueuedは確定した未受理への復帰であり、曖昧な送信の再試行ではない。将来のFIFO dispatchは改めてSession・権限・Workspace・receiver世代を確認する。
- 認可、payload digestの生成、durable transaction、FIFO、旧callbackのfence、通知先固定、Outboxはこのモジュールの提供範囲外である。

## 検証と未達ゲート

[回帰試験](<../test/plugin-native-admission.test.ts>)はモックのみ。receipt／identity不一致、受付と開始の区別、busy、応答喪失、固定receipt競合、不受理証拠の拒否、不正入力を検証する。Native durability、Desktop競合、Host再起動や90日保持の証拠ではなく、AC-35／36の合格ではない。

以下は引き続き未完了である。

1. RFC-M：信頼されたowner/bootstrap、caller-bound grant、失効、正式bundleとGUIの実機証拠。
2. RFC-A：Desktop・全receiverが共有する原子的受付、安定receiptの発行／照会、正式なnon-acceptance fence、再起動／保持期限。
3. RFC-N：対象Runのstatus／cancel／Approval、正規イベント相関と復旧。
4. Engine／DB／FIFO／Outboxへの統合、Discord receiver、同一SessionのPC→Discord→PC、24／72時間試験。

Hostの全Capability false・管理操作拒否は変更しない。共有DSHの再起動・停止、ASAR改変、別サーバー、秘密設定、実Botログインやモデル指示は行わない。[開発状況](<development-status.md>)と[検証記録](<verification.md>)に最新結果を記録する。Telegramの追加開発は延期し、既存回帰試験を維持する。
