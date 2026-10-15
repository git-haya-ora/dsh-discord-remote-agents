# Native受付journal内部基盤

対象は[仕様書](<../specification.md>) §22.2／22.3／22.5の独立した部分実装です。**INTERNAL DESIGN**であり、DSHの正式APIやGUI導入、RFC-AのDesktop共通原子的受付、実機AC合格を意味しません。[receipt判定基盤](<native-admission-foundation.md>)と同様、Hostの全Capability falseと管理拒否を維持します。

## 保存と固定する情報

[SQLiteAdmissionJournal](<../packages/discord-plugin/admission-journal.js>)は旧CLIや秘密journalと別の専用rootに`admission-journal.sqlite`と`admission-guard.sqlite`を保存します。新しいschema identity／version 1を持ち、旧CLI DBの自動再利用・移行は行いません。

保存対象はbackend／正確なNative Session、固定Run／clientRequestId、Discord Bot／input ID、digest、不透明な保護payload参照、送信先／actor／Binding／Workspace／receiver generation／leaseのsnapshot、状態・CAS version・receiptです。prompt本文、attachment実体、トークンは保存しません。digestと保護payloadは呼出側が検証して供給するもので、このmoduleは保護ストアを読まず、digestを計算しません。

- inputの重複は`transport + botId + inputId`で判定します。同一内容は元のRunと固定snapshotを返し、競合は拒否します。新しいpayload参照やgenerationで元のRunを差し替えません。
- Session排他とFIFOはAgent aliasではなく`backendIdentity + nativeSessionId`単位です。後続queuedは先頭を追い越せません。Agent単位のBridge内budgetは下記のclaim条件であり、正式共有schedulerではありません。
- 待機上限は10件。dispatching中の先頭も待機slotを予約し、busyで元の順序に戻る際の11件化を防ぎます。acceptedは待機数に含めませんが後続claimを阻止します。unknownは後続claimと新inputを阻止します。
- SQLite transactionとversion CASでenqueue／claim／応答適用を処理します。専用guardによる単一writerはローカルjournalの保護だけであり、Desktopや別receiverのNative受付ロックではありません。

## Agent全体のBridge内budget

`claim(runId, expectedVersion, agentConcurrencyLimit = 1)`は同じSQLite transaction内でRun CAS／Session排他／FIFOを検証し、固定したcanonicalな登録Agent IDごとのdispatching／accepted／unknownを数えます。backendが異なっても同じAgent IDなら同じ枠です。queuedは枠を占有しません。満枠は`ADMISSION_AGENT_CAPACITY`で状態・versionを変えず拒否します。limitは正の有効整数だけを受け付けます。

busy→queuedと正式な受付前拒否→failedは枠を空けますが、acceptedはrunningとみなさず枠を保持し、unknownも時間経過や不受理proofで解放しません。上限を下げても既存Runを取り消さず、新claimだけを止めます。Agent IDのalias解決・真正性、現在の上限値は呼出側の正式設定検証が必要です。

**Run CASはsettings revision CASではありません。** per-callのlimitを古い大きな値のまま渡すと、その古い枠でclaimできるため、このmoduleだけで動的設定変更の安全性や管理者認可を保証しません。将来の正式settings revisionを同一受付transactionで検証する配線が必要です。budgetの集計はRunと同じdecoderを使い、SQLite JSON1とJavaScriptの重複JSONキー解釈の差で別Agentと数えません。

これは単一journal内のBridge枠だけです。Desktopの並列設定を変更せず、Desktop実行や別journal／receiverを含む合算枠の正式共有scheduler、Agent停止／認証／互換性gate、Native共有原子的受付は代替しません。Hostの全Capability falseと管理拒否は維持します。

## 状態と非再送

`queued → dispatching`のcommitがclaimの成功条件です。claimはdispatchingのcommitだけでなく、応答／復旧に必要な追加version incrementも予約してから許可し、上限直前では変更せず拒否してread／再openを維持します。保存state／versionの到達可能性（queuedの初期0／busy後偶数、dispatchingの正の奇数、failedの2以上偶数、accepted／unknownの2以上）も変更前に検証します。これはローカルjournal整合性であり、Nativeの受理／不受理や真正性の証明ではありません。Native呼出しは一切行いません。受付応答はdispatchingからのみ、lookupはunknownからのみ適用します。acceptedはrunningではなく、Native開始を推測しません。

busyは同じFIFO位置のqueued、正式に信頼した拒否応答はfailed、receipt不一致・応答消失などはunknownです。再open時のdispatchingは送信前だった可能性があってもunknownにします。既存receiptを競合lookupで差し替えず、不受理proofだけでunknownを解除しません。Native再送、別IDによるunknown迂回、強制解除はありません。

receiptの構造が正しいことは発行元の認証やNative側durabilityを証明しません。応答／lookupの出所は将来の正式契約で呼出側が保証する必要があります。DB書込が失敗した場合も外部受付の失敗とは断定せず、永続dispatching／unknownを保全して正式lookupの対象にします。

## 呼出側に残る必須条件

enqueue前と**毎回のclaim直前**に、管理／Discord caller認可、Capability、receiver generation／lease、Bindingの継続可否、Agent／Workspace／Session、attachmentと保護payloadを再検証してください。保存したsnapshotはそれらの現在の権限や存在を保証しません。claimがcommitできたことだけを外部実行の許可にしてはいけません。

## 私有パスと検証区分

[Windows秘密基盤](<windows-secrets.md>)と同じ所有者／祖先ACL／reparse拒否方針に従う専用の`admission-journal` helper操作を使用します。秘密journalの許可file集合を広げません。root検証、空file作成後・SQLite open前の再検証、constructor成功後・公開前の再検証と、許可fileのtype／symlink／hardlink数検査を行い、安全拒否時のACL緩和や一般tempへのfallbackはありません。

`memoryForTests()`はSQLiteロジック試験専用で**durable:false**です。私有パス、OS跨プロセス排他、再起動耐久性、DPAPI成功の証拠にはなりません。実file fixtureは本番と同じpath gateを通し、受付fixtureは`ADMISSION_PRIVATE_PATH_UNSAFE`だけをskip／未検証とします。helper／storage unavailableは試験失敗であり、成功やskipに隠しません。独立Outbox追加時は4つ、統合journalの追加後は6つのnative fixtureが専用test環境変数`DSH_DISCORD_TEST_PRIVATE_PARENT`で親を指定でき、未指定なら`tmpdir()`です。独立Outboxとversion境界対策追加時の司令塔の独立実行履歴は、安全な既存workspace親で84成功・0skip、default TEMPでは80成功・4skipでした。最新の統合suite結果は検証記録に分けて記載します。ACLを変更せず本番gateを通った新規dummy fixtureだけの証拠で、実配備rootや電源断durabilityを保証しません。設定した親が不存在／利用不可ならsetupが失敗し得ます。自動fallbackはありません。試験結果は[検証記録](<verification.md>)を参照してください。

## 未実装の要件

この独立DBでのrunning／waiting_approval／cancelling／terminalの正式Native相関、安定event cursor、terminalとOutboxの同一transaction、eventの一意キーは未達です。別schemaの[統合journal](<run-outbox-journal-foundation.md>)が局所terminal＋Outbox原子保存を担いますが、Nativeイベントや自動migrationの契約ではありません。90日tombstone／auditと7日payload保持・削除、保護payload入出力、schema migration、正式RFC-M／A／N、Host／receiver／GUIへの配線は未実装です。このsliceのfailedも通知済terminalや完全なterminal処理を意味しません。非terminalのstate versionが整数上限に達した場合はfail-closedでSessionを止め、上限到達後の回復・移行方針は未実装です。journal単体やmock成功をAC-35／36、正式配備、実Discord往復、24／72時間試験の合格に数えません。
