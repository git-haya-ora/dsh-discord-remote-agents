# Protected payload → Run／Outbox：内部接続基盤

**内部実装・合成fixture検証済み。** [保護text producer](<protected-payloads-foundation.md>)と[同transaction journal](<run-outbox-journal-foundation.md>)を内部adapterで接続する。正式Host activation、Native受付、送信、GUIの解禁・実機ACではない。

## 二種類のdigestを混同しない

- `metadata.payloadDigest`は外部で検証されるNative正規化入力digest。receipt／terminal相関に使う。adapterは計算・真正性検証・RFC-A互換性を提供しない。
- 新しい`ProtectedAdmissionInput.protectedPayloadDigest`はproducerのcanonical prompt envelope fingerprint。元contextとともに同じRun metadataへ永続保存し、restart後のHost-local readに使う。Native digestを既定値として代入しない。
- `TerminalEvent.notificationDigest`／Outboxの`metadata.payloadDigest`は通知envelope fingerprint。通知contextの`promptDigest`は保存済みprompt fingerprintから導出し、Native digestへ置き換えない。kind・元scope・本文をcanonical検証する。

## 順序と固定scope

[内部adapter](<../packages/discord-plugin/protected-run-outbox.js>)はtext-only。すべての入力を最初のawait前にown-data snapshotとして検証し、getter／Proxyを実行しない。添付等の未知fieldは拒否する。

1. 受付scopeからprompt context、または元Run／receipt／terminalから通知contextを導出する。呼出側が通知を別Binding・Bot・会話・DMへ移せない。
2. producerで保護blobを作成。返却descriptorを独立canonical descriptionと比較し、同じexpected kind／context／fingerprintでHost-local readし、返却envelopeと元本文を検証する。
3. この検証が成功してからjournalを呼ぶ。protection／read検証失敗ではRunを作らず、terminal／Outboxも更新しない。
4. journalのCAS／相関／重複条件をtransaction内で再検証する。terminal／event／Outboxは同じSQL transactionで保存する。exact replayは保存済みref／snapshot／pairを返し、再生成されたrefで置き換えない。

blobとSQLは**分散atomic transactionではない**。SQL拒否・重複・crashで暗号化orphanが残り得る。adapterにdelete／unclaim／rollback Native／timer releaseはない。参照-aware清掃・保持・quotaは未提供。

## Host-local readは実行許可ではない

- `readPrompt(runId, expectedVersion)`は既に`dispatching`のRunに限る。元ref／context／両digestを固定し、await後も同じstate／versionを確認してから本文を返す。queued／accepted／unknown／terminalをbody availabilityだけで再実行しない。
- `readDelivery(deliveryId, expectedVersion, fence)`は既に`sending`かつrowと現在leaseが一致する通知に限る。元terminalと固定scopeを使い、await後にrow／version／現在leaseを再確認する。pending／retry_wait／blocked／delivery_unknown／dead_letter／sentを解除しない。
- adapter自身はclaim、Native submit、HTTP send、lease取得、権限／Bot／Session検証を行わない。元owner・現在ACL・正式settings／receiver lease・Native契約は外部の必須条件。局所tuple一致は認証・remote commitのfenceではない。
- commit-time認可／settings revision CASのhookや上流検証providerはまだない。保護await前の許可だけで受付commit時の権限を証明せず、これをpublic ingress／Host activationへそのまま配線しない。実Engineでの失効・Binding／世代再検証と正式受付の線形化境界が別途必要。

## 意図的な内部format非互換

unified-only metadataの必須field変更に伴い、私有DB identityを`discord-run-outbox-protected-journal`（内部version 1）へ変更する。完成仕様の全DB schema v1を実装したという意味ではない。旧`discord-run-outbox-journal`を自動open／変換／fingerprint補完せず、mutating PRAGMA／DML前に拒否する。旧identity guardが新identityを拒否することもisolated childのsource-adapted診断で確認するが、配備済み旧binaryの実機rollbackを試した証拠ではない。新しい専用profile／rootが必要で、既存データを消して作り直す手順ではない。migration／backup／rollback設計は別途必要。

独立受付／通知journal・shared AdmissionInput・token／payload helperとpinは変更しない。新exportが存在してもHostから配線せず、全Capability false／管理拒否を維持する。

## 証拠と残要件

pure dependency fixturesは保護失敗前のSQL不変・descriptor／context置換・async version／lease競合・replayの元ref保持を確認するだけで、実DPAPIやNative真正性の証明ではない。別途fresh synthetic CurrentUser DPAPI＋私有SQLiteで作成／検証／commit／再open・異なる二digest・ciphertext-only（JSON escapeに依存しないASCII markerも不在）・旧profile／欠落・不正fingerprintの両DB bytes不変拒否を確認した。実outbox INSERT triggerでterminal transactionをrollbackし、accepted Run／DB不変と暗号化orphan1個を確認する。正常な旧format fixtureでのbyte-refusalとsource-adapted guard診断であって、旧binary実機migration／hot journalや電源断の網羅証拠ではない。

司令塔の独立strict build／全回帰はdefault TEMPで111件中102成功・0失敗・9初期私有path skip、明示した安全workspace親で111件中111成功・0失敗・0skip。初期の真正unsafe-path以外をskipにせず、明示したfixture親は失敗を可視化する。fresh fixture残留0、pack dry-run26 source artifacts、audit脆弱性0。最終監査・委任境界は[検証記録](<verification.md>)へ記載する。

正式RFC-M／A／N、connected GUI／receiver／sender、shared feed／履歴／Approval／cancel、添付／Artifact、blob清掃／保持・migration、正式配備root／power loss／10,000 Run性能・実Discord／モデル・24／72時間ACは引き続き未達。
