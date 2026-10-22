# Discord制限版 — 導入・実機確認・復旧

はじめて使う場合は[かんたん導入・使い方](<quickstart.md>)から進めてください。本書は環境要件・詳細な導入・実機確認・復旧用です。

対象は[合意した制限版](<limited-profile.md>)です。**導入手順の存在は導入済みの証拠ではありません。** 実施状況は[検証記録](<verification.md>)に分離して記録します。Telegram機能追加は含みません。

## 1. 事前条件と禁止事項

- Windowsの同じ利用者アカウントでDSHを動かす。今回の契約調査対象はDSH `0.2.0-rc.2`。別versionへの自動互換宣言はしない。
- Node `>=22.23.0` が必要。SQLiteはNode内蔵を使う。コード・資料・模擬テストは安定Run receiptや原子的受付の代わりにならない。
- DSH認証GUIを利用する相手は全員、同じplugin管理権限を持つ。operatorを共有する環境に独立owner/admin分離はない。
- 同一SessionをPCとDiscordで同時に操作しない。承認回答・停止・添付・ArtifactはPCのDSHで行う。workspace allowlistは実行サンドボックスではない。
- チャットへ貼ったBot tokenは使わず、Discord Developer Portalで**新規rotateしたtoken**を手元だけで扱う。会話・コマンド引数・設定ファイル・スクリーンショットへ貼らない。
- 本体ASAR改変、非公式API、既存Cookie／秘密の探索、別server起動、共有DSH停止は不要。必要な再起動は利用者が安全な時点で明示して行う。

## 2. bundleの用意と正式導入

1. 開発者はrootで `npm ci --ignore-scripts`、`npm test`、`npm run pack:plugin` を実行する。生成物を `node tools/verify-bundle.mjs dsh-discord-remote-agents-0.2.0-restricted.4.tgz` で点検し、`Get-FileHash -Algorithm SHA256 .\dsh-discord-remote-agents-0.2.0-restricted.4.tgz` で配布物を特定する。manifest、内包runtime、DPAPI helper、依存と秘密混入を確認する。依存は `discord.js` の固定versionを正式package managerが解決する（依存まで内包した完全offline tarballではない）。研究抽出を同梱・参照しない。
2. 現在利用中の認証済みDSH GUI（既存loopbackホストのURL）のサイドバー **Plugins** を開く。Settingsの読取り専用Plugin一覧ではない。
3. 公開GitHubからの正式インストール操作に `github:git-haya-ora/dsh-discord-remote-agents` を指定する。[開発・配布repo](https://github.com/git-haya-ora/dsh-discord-remote-agents)にはcanonical sourceと直下のビルド済みpluginを統合している。今後の開発も同じrepoで行い、旧private repoは使わない。ローカルtarball導入の以前の案内は利用者の導入経路として撤回する。package名は `dsh-discord-remote-agents`。npmレジストリは未公開で、両manifestの `private: true` と `publishConfig` 不在をbuild/scanが強制する。GitHub導入とpackは維持するが、レジストリ公開は別途許可が必要。旧 `@local/dsh-discord-remote-agents` は先にreceiverを停止して無効化し、二重稼働させない。npmへの変更でも既存依存のminimumReleaseAgeは回避しない。対象profile全Sessionに影響することを確認する。認証回避やブラウザーへのtoken埋込みはしない。
4. インストール結果のsaved selectionだけでなく、Host activation、Client synchronization、エラーを確認する。HMR非対応profile、package差替え等で `restart-required` なら、処理が安全な時点まで利用者が待って通常手順で再起動する。アシスタントが共有processをkillしない。
5. 同じGUI URLをrefreshし、bundleの設定欄を開く。現Plugin Managerの設定slot内に表示されることを確認する。別dev serverやソース変更だけでは、このGUIが更新された証拠にならない。

> この会話に正式 `plugin_manager` 操作／認証ブラウザー手段が公開されていない場合は、上記操作を利用者が行う。インストール・表示未確認を合格扱いしない。依存build scriptが要求された場合は、その内容と権限を確認して別途判断し、一括・無条件に承認しない。

## 3. 初回設定

1. 状態が未接続であることと、`single-operator-text-v1` の制限説明を読む。
2. Guild ID、Application ID、許可User ID、許可Channel ID、workspace aliasと絶対パスを入力する。DMからモデル指示は受け付けない。threadを使う場合は実際のthread IDを許可し、親channelの許可が自動継承されると想定しない。
3. 新tokenを**GUIのpassword入力だけ**へ入力する。保存時にBot identityも確認するので、詳細設定の接続テストは任意。テストは設定保存・receiver開始と別操作で、token欄は送信時に消去される。tokenは書込み専用で、既存tokenをGUIへ読み戻さない。
4. 保存する。保存は接続中のreceiverを停止し、将来のautostart承認を解除する（Native実行は停止しない）。token欄を空にして保存する場合は既存値の維持であり削除ではない。削除は専用操作で確認して行い、receiverも停止する。revision競合時は再読込して内容を見直し、blind retryしない。
5. slash command登録は明示確認後に行う。Developer Portalで同じBotのGuild導入・適切なscopeと権限を設定する。Guilds中心の明示slash操作を使い、Message Content intentを前提にしない。
6. 旧CLI／別Receiverが停止済みで、PC実行中にはDiscordから送信しないことを確認して、**開始**を明示操作する。開始・再接続の確認は操作ごとに必要。保存成功は接続成功ではない。Bot名・状態・安全なエラー表示を確認する。autostartは初期false。保存時の同意だけでは有効化されず、そのrevisionで確認付き手動開始が成功して初めて将来のHost再起動を許可する。設定保存・停止・token削除でその許可を解除する。

## 4. データと秘密

- 既定rootは `%LOCALAPPDATA%\DSHDiscordRemoteAgents\single-operator-text-v1`。非秘密の `dataRoot` overrideを使う場合も、絶対パスとprivate ACL/reparse検査に通る必要がある。
- tokenは `secrets` 配下のCurrentUser DPAPI保護blob。`metadata` 配下の専用SQLiteは非秘密設定、Binding、Run相関、digest、protected-output intent/manifest、通知状態を保持する。prompt本文は保存せず、終端Runのredacted回答と配送partは別namespaceの`protected-output`配下にランダムopaque refでDPAPI保護保存し、SQLiteへ平文保存しない。読み出しでは同じRun／Session／actor／Binding／destination／deployment scopeを照合する。全partの確定sent receipt後7日で記録済みrefだけを削除し、unknown／未送信／blockedは保持する。metadata/tombstoneの90日pruningは未実装。容量上限128 MiBにはSQLite/sidecar、payload、reservationを算入し、超過・不整合はfail closed。孤立payloadを自動清掃しない。
- unsafe ACL・junction/reparse・想定外schemaはblockedとし、平文fallbackや自動権限修復を行わない。block理由を確認し、既存データを保全して対応する。
- 旧CLIの平文SQLite、個人Binding、secretやfoundation実験DBは自動importしない。bundleのBindingは会話（Guild＋Channel/thread）共有。送信済みRunのSession・操作者・通知先は後続Binding変更で変わらない。

## 5. 実機受入チェック（未実施なら未実施と記録）

- GUI: 初回／保存／再表示、空token維持、削除確認、開始／停止／再接続、エラーと多重押下、revision競合。
- 表示: 既存DSHの明暗theme、キーボード操作、focus、ラベル、狭い幅を実画面で確認。ソースfixtureは代替にならない。
- Discord: rotate済みtokenによる実ログイン、登録したslash command、許可User/Guild/Channel成功と未許可拒否、DM・Bot由来入力拒否。
- Native: PCで既存Sessionを作り、Discordで一覧／選択／テキスト送信／結果／通知を確認し、PCに戻って**同一Native Session ID**を照合する。新規workspace aliasも別途確認。テストはPCとの交互利用で行う。
- 安全: busy拒否、同じinteraction IDの再観測、別本文の同一ID拒否、応答不明で`unknown`・自動prompt再送なし、Binding変更後も元Run固定、権限失効後の開示拒否、通知失敗がモデル再実行にならないこと。
- 復旧: まず合成fixture、次に利用者が許可した保守時間に実Host再起動を確認。運用DSHを故意に落とす試験は勝手に行わない。

## 6. 保全・更新・復旧

1. pluginの**停止**はreceiverだけを止め、すでにNativeへ渡ったRunは止めない。不明Runを消して再送できるようにはしない。PCで元Sessionを確認する。
2. 更新前は新規送信を止め、active/unknown/pending通知を確認する。生きたSQLiteの単一ファイルコピーを整合backupだと思わない。利用者の保守時間にpluginを安全にunloadし、DB・関連journal・設定・DPAPI blobを一体で保全する。backupも秘密扱い、Git追跡しない。
3. DPAPIはWindows利用者／マシンの保護に依存する。別PC・別accountへのblobコピーで復旧可能とは保証しない。必要時は新tokenを安全なGUIから再設定する。
4. 復旧は元データを残してから行う。`unknown`／dispatchingをaccepted前に戻したりSQLiteを手修正して再送したりしない。historyから一致するrpcId／turnを確認できなければブロックを維持する。
5. 通知とモデル指示は別。通知結果が`unknown`なら自動・手動とも再送せず、`/agent result`またはPCの同一Sessionで確認する。確定した配信拒否への明示再試行でも、モデル指示を再実行してはならない。
6. rollback／削除でDSH Session history、開始済みRun、protected dataを勝手に削除しない。package replacementがrestartを必要とする場合、通常の保守手順で利用者が行う。

完成版RFC-M/A/N、24h／72h耐久、全ACをこの制限版のmock結果で閉じない。
