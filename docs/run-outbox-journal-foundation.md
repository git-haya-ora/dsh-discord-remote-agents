# Run終了状態＋Outbox同transaction：内部統合基盤

対象は[仕様§15.4](<../specification.md#L756-L764>)、[Queue／復旧](<../specification.md#L1181-L1190>)、[Nativeイベント](<../specification.md#L1192-L1204>)、[永続化とOutbox](<../specification.md#L1206-L1218>)。局所同transaction基盤は合成fixtureで実装・検証済み。[保護producer接続](<protected-run-outbox-foundation.md>)も局所合成fixtureで検証済みであり、意図的な内部profile非互換・残条件は同文書へ記録する。正式Native／Discord連携の実機合格ではない。

## 解消する局所的な構造問題

既存の[受付journal](<admission-journal-foundation.md>)と[通知journal](<outbox-journal-foundation.md>)は別SQLite DBであり、両者の呼出しをまとめても終了状態＋通知生成の原子性は成立しない。新しい統合journalでは、一つのSQLite接続と一つのtransactionにRun・terminal event記録・固定先Outboxを収める。別DBのATTACH、二段階のcommit、既存DBへの自動移行で代替しない。

- 受付時に元Bot、会話、操作者、Binding version、Workspace、Native Session、clientRequestIdと指示digestを固定する。
- acceptedはNative receiptの保存であり、runningを推定しない。正式terminalが確認できれば、startedを取り逃したacceptedから直接終了を記録できる。
- 対象receiptと一致する信頼されたterminal観測だけを入力とする。unknownにreceiptがなければ、Session／Agent枠を勝手に解除しない。
- Runのterminal更新・event重複記録・pending通知作成を一つのtransactionで確定する。途中失敗はすべてrollback、commit後は三者を一緒に復元する。
- 通知先・owner・Bot・Binding／Workspaceは元Runから導出する。呼出側が新しいBindingやDMを渡してretargetできるAPIにしない。
- terminal通知のlogical keyは元Runから一意に導出する。同じNative内容と通知digestの再観測は同じRun／通知を返し、変更された結果や別対象のeventは拒否する。保護blob再生成による参照の変化だけはeventの変化とみなさない。
- terminalを古いイベントで巻き戻さない。event IDの一意scopeを明記し、異なるSessionの同名IDを無条件に同一eventと扱わない。

## 内部APIと識別子

[統合journal実装](<../packages/discord-plugin/run-outbox-journal.js>)は受付側の`enqueue`／`claim`／`applyResponse`／`reconcileLookup`と、`commitTerminal(runId, expectedVersion, event)`、通知側の`advanceLease`／`claimDelivery`／`applyDeliveryResult`を一つの所有DB上で提供する。`get`／`listSession`／`getDelivery`は私有データの取得であり、公開管理RPCではない。

統合専用`ProtectedAdmissionInput`では、Native receipt相関の`payloadDigest`と、再起動後の保護prompt検証用`protectedPayloadDigest`を別fieldとして永続化する。独立受付journalの`AdmissionInput`は変更しない。旧profileへ暗黙に内部fingerprintを補完しない。

terminal snapshotは`backendIdentity`、`nativeSessionId`、`clientRequestId`、`payloadDigest`、`nativeRunIdOrEquivalent`、`eventId`、`revision`、`checkpoint`、`occurredAt`、`state`、`notificationRef`、`notificationDigest`の12 field。revision／checkpointはopaqueなevent-local記録であり、shared feed cursorの更新やresume契約ではない。`notificationDigest`とOutboxの`payloadDigest`は通知の内部envelope fingerprintであってNative受付digestではない。

- event重複のscopeは`(backendIdentity, nativeSessionId, eventId)`。全Native fieldと通知digestが同じならstale expectedVersionでも既存pairを返す。ランダムに再生成された`notificationRef`だけは重複比較から除外し、保存済みsnapshot／参照／通知IDとversionを置き換えない。別digest・Native内容変更・別Runへの流用は拒否する。新しく作られた未使用blobの退役はproducerが返された元refを確認して管理する未完了の外部責任であり、journalは勝手に削除しない。
- 通知logical keyは元local Run IDから`terminal:${runId}`として導出する。Native event相関を先に検証するため、任意caller keyで重複回避できない。
- `Run.terminal=null`の`failed`は受付前の確定拒否であり、Native terminal failedと区別する。この受付前通知の同時生成は今回のscope外。

## 安全境界

これは**INTERNAL DESIGNのHost-onlyデータ処理基盤**であり、上流DSHに新しいAPIが実在するという主張ではない。構造が正しいevent、receipt、revision、cursor、payload参照は真正性の証明ではない。

呼出側は正式契約によってNative targetの同一性、確定terminal、event／revision／checkpointの意味、保護payloadの由来を検証する必要がある。opaque revisionを文字列順や数字変換で勝手に順序付けしない。Cookie、共通Peer、自己申告role、認可booleanではこの境界を満たさない。

terminal記録と送信許可は別である。元操作者の権限が撤回されても、確定結果を未完了に戻さず、私有DBに元scopeを保持して通知を保留する。実送信前は元owner scope・現在の会話ACL・固定Bot identity・正式なsettings／receiver leaseを再認可する。

本文・token・Native出力をSQLiteへ平文保存しない。通知はHost保護payloadの参照とdigestのみ。journal自身はpayloadを読み出さず、HTTP／モデル／Native submitを呼ばない。通知再試行でNative実行を再送しない。

## 復旧・整合性で検証する点

- private root／allowlist、single writer、schema識別、foreign DB拒否を既存基盤と同じ厳格さで維持する。ACLやlogging方針を緩めない。
- dispatchingの中断はunknown、sendingの中断はdelivery_unknown。受付・通知の不明状態を時間経過や新IDで解除しない。通知のblocked／delivery_unknown／dead_letterをrepair・unblock・重複risk同意で解除するAPIはこのsliceに存在せず、履歴／nonce照合・管理修復は未完了のまま保留する。
- terminal／event／Outboxの相互一致、孤立row、不可能state／version、counter上限と同名counter重複を起動時に検証する。v1通知のstate／failure／versionは実際に到達可能な組合せに限定する。破損を「修復済み」や送信成功と推測しない。joinはMapで行うが、公開read／write毎の全件検証は残り、10,000 Runの応答時間を実測済みとはしない。
- Run CASと通知counter／versionの失敗はpair全体をrollbackする。claim前に応答／復旧用versionを予約する。
- product transaction途中のstatement失敗、commit前後の子process終了、再open、event重複、receipt／scope不一致、writer競合を隔離fixtureで確認する。合成SQLだけの試験はproduct経路のcrash試験と区別する。
- native fixtureは既存workspace等の検証可能な親にfresh rootを作り、私有path gateを必ず通す。unsafe-path拒否以外のstorage／helper失敗をskipで隠さない。最終freeze後の司令塔の独立strict build／全回帰は92成功・0失敗・0skip（安全workspace親）、86成功・0失敗・6skip（default TEMP）。統合suiteは8件。元refを保つ実process replay、commit前後のproduct経路、counter／不可能stateのbytes不変拒否を含むが、power-loss・正式Native／Discord・本番配備の証拠ではない。

## この増分でも未完了のもの

- 正式RFC-M管理資格、RFC-AのDesktop共通受付／durable receipt、RFC-NのNativeイベント・停止・承認。
- GUI／receiver／正式senderへの配線、実Discord送信、実モデルとPC↔Discord↔PC往復。確定pre-send通信失敗のretry型は未実装。5xxの内部呼出しは省略時jitter=0のため、senderは実retryでjitterを供給し、429のfractional seconds→integer ms・bucket／global制限とSDK内部retryを制御する必要がある。これらの局所試験は実HTTP試行数の制御証拠ではない。
- running／Approval／cancelの完全lifecycle、受付前の確定拒否と通知の一括保存、cursor gap／履歴照合。
- 旧MVP／独立foundation DBの明示migration、保護payloadの生成・保持／清掃、90日tombstone／監査、正式配備rootと24／72時間試験。

既存独立journalのexportとDBは維持し、暗黙に統合済みとは扱わない。統合journalの局所原子性が検証されても、DBとNative受付やDiscordのremote commitまで分散transactionとして原子的になるわけではない。全Capability falseと管理拒否の解禁は、引き続き[正式ゲート](<development-status.md#L33-L40>)の証拠を必要とする。
