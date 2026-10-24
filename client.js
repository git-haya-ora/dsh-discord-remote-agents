// DSH Client settings surface. Host calls stay on the authenticated Connection RPC;
// secrets are write-only inputs and never enter browser storage or package config.
window.__ModuleLoader__.load({
  id: 'dsh-discord-remote-agents',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PACKAGE = 'dsh-discord-remote-agents';
    const NAMESPACE = 'discordRemoteAgents.settings';
    const CHANNEL = '/api';
    const ENDPOINT = 'discord-remote-agents.manage';
    const STATUS_TIMEOUT_MS = 15000;
    const MUTATION_TIMEOUT_MS = 45000;
    const STATES = new Set(['unconfigured', 'stopped', 'connecting', 'connected', 'blocked', 'disposed']);
    const CSS = `
.dra-root{box-sizing:border-box;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);font:inherit;line-height:1.5}
.dra-root *{box-sizing:border-box}
.dra-stack{display:flex;flex-direction:column;gap:16px;min-width:0}
.dra-heading{margin:0;color:var(--dsw-alias-label-primary);font-size:18px;font-weight:550;line-height:1.35}
.dra-copy{margin:5px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55}
.dra-notice{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.dra-notice strong{display:block;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:550}
.dra-notice p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.dra-section{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px;min-width:0}
.dra-section:first-child{border-top:0;padding-top:0}
.dra-section-title{margin:0 0 4px;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:550;line-height:1.45}
.dra-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px 16px;margin-top:12px}
.dra-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dra-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.dra-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}
.dra-control{width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.45;padding:9px 11px}
.dra-control:hover{border-color:var(--dsw-alias-border-l4)}
.dra-control:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dra-control:disabled{opacity:.62;cursor:not-allowed}
textarea.dra-control{min-height:88px;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere}
.dra-token{font-family:var(--ds-font-family-code,monospace)}
.dra-checkbox{display:flex;align-items:flex-start;gap:9px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;cursor:pointer}
.dra-checkbox input{flex:none;width:16px;height:16px;margin:1px 0 0;accent-color:var(--dsw-alias-state-business-primary)}
.dra-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.dra-button{min-height:36px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:550;line-height:1.35;padding:7px 12px;cursor:pointer}
.dra-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4)}
.dra-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dra-button:disabled{opacity:.55;cursor:not-allowed}
.dra-button[data-kind=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dra-button[data-kind=danger]{color:var(--dsw-alias-state-error-primary)}
.dra-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:10px}
.dra-state{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:550}
.dra-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dra-state[data-state=connected] .dra-dot{background:var(--dsw-alias-state-success-primary)}
.dra-state[data-state=connecting] .dra-dot{background:var(--dsw-alias-state-warn-primary)}
.dra-state[data-state=blocked] .dra-dot,.dra-state[data-state=disposed] .dra-dot{background:var(--dsw-alias-state-error-primary)}
.dra-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dra-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:12px}
.dra-stat{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);padding:9px 11px;min-width:0}
.dra-stat dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.dra-stat dd{margin:3px 0 0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:550;font-variant-numeric:tabular-nums}
.dra-capabilities{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:7px 14px;margin:10px 0 0;padding:0;list-style:none}
.dra-capability{display:flex;align-items:baseline;justify-content:space-between;gap:10px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dra-capability strong{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:550;text-align:right}
.dra-capability[data-supported=true] strong{color:var(--dsw-alias-state-success-primary)}
.dra-capability[data-supported=false] strong{color:var(--dsw-alias-state-warn-primary)}
.dra-message{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;padding:9px 11px;overflow-wrap:anywhere}
.dra-message[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.dra-message[data-kind=success]{color:var(--dsw-alias-state-success-primary)}
.dra-inline-code{font-family:var(--ds-font-family-code,monospace);overflow-wrap:anywhere}
@media(max-width:520px){.dra-notice{padding:12px}.dra-grid{grid-template-columns:1fr}.dra-actions{align-items:stretch}.dra-button{min-height:40px}.dra-actions .dra-button{flex:1 1 140px}}
`;
    const dictionaries = {
      en: {
        statusLoading: "Loading Host status. You can keep editing while you wait.",
        retryStatus: "Retry status",
        statusTimeout: "Host status timed out. Your input is kept; retry status to enable saving.",
        saveBlocked: "Saving requires current Host status. Retry status below; your input will be kept.",
        confirmAfterSave: "Settings saved. Check the confirmation for each action again before registering or connecting.",
        confirmCommandsNeeded: "Check the command registration confirmation above.",
        confirmStartNeeded: "Check the receiver confirmation above.",
        tokenNeeded: "Save a bot token before registering or connecting.",
        stateBlocked: "Starting is unavailable in the current receiver state. Review status and diagnostics.",
        draftHelp: "Unsaved input is kept in memory while you navigate this GUI. Reloading or closing the GUI clears it, including the token. Nothing is stored in browser storage.",
        waitingOperation: "An operation is in progress. Please wait.",
        unknownBlocked: "The previous result is unknown. Refresh Host status before making further changes.",
        connectionNoticeWarning: 'Connection-notice delivery could not be confirmed. Check the receiver state above separately. The notice is not retried automatically.', connectionNoticeTitle: 'Connection notifications', connectionNoticeHelp: 'Optional, off by default. Sent once after a receiver start succeeds. Includes selected Session/project names and observed model metadata, never folder paths. Failure does not reconnect or retry.', connectionNoticeDm: 'Send to every allowed user by DM', connectionNoticeChannels: 'Publish to every allowed channel (visible to its members)',
        stepSave: "1 Save settings",
        stepCommands: "2 Add commands to Discord",
        stepStart: "3 Start connection",
        advanced: "Advanced settings and diagnostics",
        alias: "Workspace name",
        folder: "Absolute folder path",
        addWorkspace: "Add folder",
        removeWorkspace: "Remove folder",
        workspaceHelp: "Optional: leave empty to connect first. After connecting, use /agent workspace-add in Discord to allow an existing folder, then select a Session. Folder access is not an OS sandbox. Command paths are sent to Discord; never include secrets.",
        idHelp: "Discord → User Settings → Advanced → Developer Mode. Right-click the server, user or channel → Copy ID.",
        appHelp: "Discord Developer Portal → your application → General Information → Application ID.",
        requiredId: "Enter a numeric Discord ID.",
        requiredList: "Enter at least one numeric ID, one per line.",
        requiredWorkspace: "Enter a unique name and an absolute folder path for each row.",
        requiredToken: "Enter a new bot token before saving for the first time.",
        unsaved: "Save these changes first, or discard them before registering or connecting. The entered token will not be sent by those actions.",
        discard: "Discard unsaved changes",
        optionalTest: "Optional: saving also checks the token. Testing is not required; a supplied token is cleared immediately after submission.",
        commandsNote: "Registration status is not stored by the Host. Register after saving when setting up or updating commands.",
        useHelp: "In an allowed Discord channel: /agent sessions → /agent bind session:<ID from list> → /agent prompt text:<your instruction> → /agent result. Replace placeholders; handle approvals on this PC.",
        title: 'Discord remote agents', intro: 'Configure the local Discord text bridge. Saving settings stops this receiver; it does not start it.',
        singleOperator: 'Single-operator access', singleOperatorBody: 'This page trusts the current authenticated DSH GUI session. It does not add separate owner/admin identities or per-user roles. Keep this signed-in DSH session private.',
        scope: 'Limited operating scope', scopeBody: 'Text notifications only. Desktop and Discord submission is not atomic; do not submit while a desktop run is active. Unknown outcomes are never resent automatically. Approvals, cancellation, attachments and artifacts stay on this PC.',
        statusTitle: 'Receiver status', refresh: 'Refresh status', refreshing: 'Refreshing…', state: 'State', state_unconfigured: 'Unconfigured', state_stopped: 'Stopped', state_connecting: 'Connecting', state_connected: 'Connected', state_blocked: 'Blocked', state_disposed: 'Disposed', tokenState: 'Bot token', tokenSet: 'Stored on Host', tokenMissing: 'Not configured', bot: 'Discord bot', notReported: 'Not reported',
        settingsTitle: 'Discord settings', settingsHelp: 'These non-secret settings are sent to the Host when you save. The token is a separate write-only input.', guildId: 'Guild ID', applicationId: 'Application ID', allowedUsers: 'Allowed user IDs', allowedChannels: 'Allowed channel IDs', onePerLine: 'One ID per line.', workspaces: 'Workspace aliases and absolute paths', workspacesHint: 'One alias=absolute-path pair per line. Example: main=C:\\Work\\repo', autoStart: 'Start the receiver when the Host starts', autoStartHelp: 'Automatic start is off by default. It arms future Host boots only after a successful, explicitly confirmed Start at the saved revision. Save, Stop, and token deletion disarm it.', confirmAutoStart: 'I explicitly agree to start the receiver automatically on future Host restarts.', autoStartConsentRequired: 'Confirm automatic start before saving this setting.',
        tokenTitle: 'Bot token — write only', tokenHelp: 'Leave blank to keep the stored token. A non-empty value is sent only to the Host; it is never read back or stored by this page.', tokenPlaceholder: 'Enter a new token only to replace the stored one', testToken: 'Test token', testing: 'Testing…', testHint: 'Tests the supplied token, or the stored token when this field is blank.',
        save: 'Save settings', saving: 'Saving…', start: 'Start receiver', stop: 'Stop receiver', reconnect: 'Reconnect', receiverControls: 'Receiver controls', startHelp: 'Starting is separate from saving settings.', exclusiveControlHelp: 'Do not run the legacy CLI or another receiver at the same time, and never send while a PC run is active.', confirmExclusive: 'I confirm the legacy CLI/other receiver is stopped and I will not send while a PC run is active.',
        commandsTitle: 'Discord commands', commandsHelp: 'Registering commands changes the Discord application. Confirm explicitly before continuing.', confirmCommands: 'I confirm registering or updating the Discord application commands.', registerCommands: 'Register commands', registering: 'Registering…',
        deleteTitle: 'Remove stored token', deleteHelp: 'This stops this receiver and permanently removes the Host-stored token. Native DSH runs are not stopped.', confirmDelete: 'I understand that the stored token will be deleted.', deleteSecret: 'Delete stored token', deleting: 'Deleting…',
        diagnostics: 'Diagnostics', activeRuns: 'Active runs', unknownRuns: 'Unknown runs', pendingNotifications: 'Pending notifications', lastError: 'Last safe error code',
        capabilities: 'Capability limits', textCapability: 'Text operation', atomicCapability: 'Atomic with desktop submission', approvalCapability: 'Approvals from Discord', cancelCapability: 'Run cancellation from Discord', attachmentsCapability: 'Attachments', artifactsCapability: 'Artifact downloads', supported: 'Reported available', unavailable: 'Not available', unknown: 'Unknown',
        noStatus: 'Host status is unavailable. Refresh before making changes.', loadFailed: 'Could not load Host status. No settings were changed.', connectionUnavailable: 'The authenticated DSH connection is unavailable.', operationFailed: 'The Host rejected the operation.', resultUnknown: 'The result could not be confirmed. The operation was not retried; refresh status before acting again.', invalidWorkspaces: 'Enter each workspace as alias=absolute-path on its own line.', testSuccess: 'Discord token test succeeded for ', testFailed: 'Discord token test failed.', saved: 'Settings saved.', started: 'Receiver started.', stopped: 'Receiver stopped.', reconnected: 'Reconnect requested.', commandsRegistered: 'Command registration completed.', secretDeleted: 'Stored token deleted.', unexpected: 'The Host returned an unexpected response.', busy: 'An operation is already in progress.',
      },
      zh: {
        statusLoading: "正在读取 Host 状态。等待期间可以继续编辑。",
        retryStatus: "重试 Host 状态",
        statusTimeout: "读取 Host 状态超时。输入已保留；请重试状态以恢复保存。",
        saveBlocked: "保存需要最新的 Host 状态。请在下方重试，输入将保留。",
        confirmAfterSave: "设置已保存。请重新勾选注册命令或连接操作的确认。",
        confirmCommandsNeeded: "请勾选上方注册命令的确认。",
        confirmStartNeeded: "请勾选上方连接操作的确认。",
        tokenNeeded: "请先保存 Bot token，再注册命令或连接。",
        stateBlocked: "当前接收器状态无法启动，请检查状态与诊断。",
        draftHelp: "在此 GUI 内切换页面时，未保存的输入仅保留在内存中。重新加载或关闭 GUI 会清除输入和 token。不写入浏览器存储。",
        waitingOperation: "操作进行中，请稍候。",
        unknownBlocked: "上次操作结果未知。请先刷新 Host 状态，再进行更改。",
        connectionNoticeWarning: '无法确认连接通知是否送达。请另外查看上方接收器状态。不会自动重发通知。', connectionNoticeTitle: '连接通知', connectionNoticeHelp: '可选，默认关闭。每次接收器成功启动后发送一次，包含已选 Session/项目名称与观测模型信息，不含文件夹路径。发送失败不会重连或重试。', connectionNoticeDm: '向每个允许用户发送私信', connectionNoticeChannels: '公开发送至每个允许频道（频道成员可见）',
        stepSave: "1 保存设置",
        stepCommands: "2 向 Discord 添加命令",
        stepStart: "3 启动连接",
        advanced: "高级设置与诊断",
        alias: "工作区名称",
        folder: "文件夹绝对路径",
        addWorkspace: "添加文件夹",
        removeWorkspace: "移除文件夹",
        workspaceHelp: "可选，可以留空后先连接。在 Discord 用 /agent workspace-add 许可本机已有文件夹，再选择 Session。文件夹许可不是 OS 沙箱。命令路径会发送给 Discord，请勿包含秘密。",
        idHelp: "Discord → 用户设置 → 高级 → 开发者模式。右键服务器、用户或频道 → 复制 ID。",
        appHelp: "Discord Developer Portal → 你的应用 → General Information → Application ID。",
        requiredId: "请输入数字 Discord ID。",
        requiredList: "请输入至少一个数字 ID，每行一个。",
        requiredWorkspace: "每行填写唯一名称和文件夹绝对路径。",
        requiredToken: "首次保存前请输入新的 bot token。",
        unsaved: "请先保存更改，或放弃更改后再注册或连接。这些操作不会发送输入中的 token。",
        discard: "放弃未保存的更改",
        optionalTest: "可选：保存时也会验证 token，无需先测试。提交后输入的 token 会立即清空。",
        commandsNote: "Host 不保存命令注册状态。初次设置或更新命令时，请保存后注册。",
        useHelp: "在允许的 Discord 频道：/agent sessions → /agent bind session:<列表中的ID> → /agent prompt text:<你的指示> → /agent result。请替换占位内容；审批在本机处理。",
        title: 'Discord 远程代理', intro: '配置本机 Discord 文本桥接。保存设置会停止此接收器，不会启动它。',
        singleOperator: '单操作员访问', singleOperatorBody: '本页面信任当前已认证的 DSH GUI 会话。不会另外建立 owner/admin 身份或按用户区分角色。请勿与他人共享已登录的 DSH 会话。',
        scope: '有限操作范围', scopeBody: '仅支持文本通知。Desktop 与 Discord 提交不具备原子性；Desktop 运行期间不要提交。结果未知时不会自动重发。审批、取消、附件和成果物仍需在本机操作。',
        statusTitle: '接收器状态', refresh: '刷新状态', refreshing: '正在刷新…', state: '状态', state_unconfigured: '未配置', state_stopped: '已停止', state_connecting: '连接中', state_connected: '已连接', state_blocked: '受阻', state_disposed: '已停用', tokenState: 'Bot token', tokenSet: '已保存在 Host', tokenMissing: '未配置', bot: 'Discord 机器人', notReported: '未提供',
        settingsTitle: 'Discord 设置', settingsHelp: '保存时这些非秘密设置会发送到 Host。Token 使用单独的只写输入框。', guildId: 'Guild ID', applicationId: 'Application ID', allowedUsers: '允许的用户 ID', allowedChannels: '允许的频道 ID', onePerLine: '每行一个 ID。', workspaces: '工作区别名与绝对路径', workspacesHint: '每行一组 alias=绝对路径。例如：main=C:\\Work\\repo', autoStart: 'Host 启动时启动接收器', autoStartHelp: '自动启动默认关闭。只有在当前已保存版本明确确认并成功启动后，才会启用未来 Host 启动时的自动启动。保存、停止或删除 token 都会解除启用。', confirmAutoStart: '我明确同意在未来 Host 重启时自动启动接收器。', autoStartConsentRequired: '保存此设置前，请确认自动启动。',
        tokenTitle: 'Bot token — 仅写入', tokenHelp: '留空表示保留已保存的 token。非空值只发送到 Host；本页面不会读回或保存它。', tokenPlaceholder: '仅在替换已保存 token 时输入新值', testToken: '测试 token', testing: '正在测试…', testHint: '测试当前输入的 token；留空时测试已保存的 token。',
        save: '保存设置', saving: '正在保存…', start: '启动接收器', stop: '停止接收器', reconnect: '重新连接', receiverControls: '接收器控制', startHelp: '启动操作与保存设置分开。', exclusiveControlHelp: '请勿同时运行旧 CLI 或其他接收器；PC 运行期间也不要发送。', confirmExclusive: '我确认旧 CLI/其他接收器已停止，并且不会在 PC 运行期间发送。',
        commandsTitle: 'Discord 命令', commandsHelp: '注册命令会更改 Discord 应用。继续前请明确确认。', confirmCommands: '我确认注册或更新 Discord 应用命令。', registerCommands: '注册命令', registering: '正在注册…',
        deleteTitle: '删除已保存的 token', deleteHelp: '这会停止此接收器并永久删除 Host 保存的 token，不会停止 Native DSH 任务。', confirmDelete: '我了解已保存的 token 将被删除。', deleteSecret: '删除已保存的 token', deleting: '正在删除…',
        diagnostics: '诊断信息', activeRuns: '运行中的任务', unknownRuns: '结果未知的任务', pendingNotifications: '待发送通知', lastError: '最近的安全错误代码',
        capabilities: '能力限制', textCapability: '文本操作', atomicCapability: '与 Desktop 提交原子一致', approvalCapability: '通过 Discord 审批', cancelCapability: '通过 Discord 取消运行', attachmentsCapability: '附件', artifactsCapability: '下载成果物', supported: '报告为可用', unavailable: '不可用', unknown: '未知',
        noStatus: '无法获取 Host 状态。请先刷新，再进行更改。', loadFailed: '无法读取 Host 状态。未更改任何设置。', connectionUnavailable: '已认证的 DSH 连接不可用。', operationFailed: 'Host 拒绝了此操作。', resultUnknown: '无法确认操作结果。没有重试；再次操作前请刷新状态。', invalidWorkspaces: '请按每行 alias=绝对路径 的格式填写工作区。', testSuccess: 'Discord token 测试成功：', testFailed: 'Discord token 测试失败。', saved: '设置已保存。', started: '接收器已启动。', stopped: '接收器已停止。', reconnected: '已请求重新连接。', commandsRegistered: '命令注册已完成。', secretDeleted: '已删除保存的 token。', unexpected: 'Host 返回了非预期结果。', busy: '已有操作正在进行。',
      },
      ja: {
        statusLoading: "Host状態を取得中です。待っている間も設定を入力できます。",
        retryStatus: "Host状態を再取得",
        statusTimeout: "Host状態の取得がタイムアウトしました。入力は保持しています。再取得すると保存を再開できます。",
        saveBlocked: "保存には最新のHost状態が必要です。下の「Host状態を再取得」を押してください。入力は保持します。",
        confirmAfterSave: "設定を保存しました。コマンド登録・接続の確認チェックをそれぞれ入れ直してください。",
        confirmCommandsNeeded: "上のコマンド登録・更新の確認にチェックしてください。",
        confirmStartNeeded: "上の接続操作の確認にチェックしてください。",
        tokenNeeded: "先にBot tokenを入力して設定を保存してください。",
        stateBlocked: "現在のReceiver状態では開始できません。状態と診断を確認してください。",
        draftHelp: "未保存の入力は、このGUI内の画面移動ではメモリーに保持します。GUIの再読み込み・終了でTokenを含め消去します。ブラウザーのストレージには保存しません。",
        waitingOperation: "別の操作が進行中です。完了をお待ちください。",
        unknownBlocked: "直前の操作結果が不明です。Host状態を再取得してから操作してください。",
        connectionNoticeWarning: '接続通知の送達を確認できません。接続そのものの成否は上の状態をご確認ください。通知の自動再送はしません。', connectionNoticeTitle: '接続できたことをDiscordへ通知', connectionNoticeHelp: '任意・初期状態はオフです。Receiverの接続成功ごとに1回送ります。選択済みのプロジェクト・Session名と観測したモデルを含み、フォルダーのパスは送りません。両方を選ぶと両方へ送信します。通知失敗では再接続・自動再送しません。', connectionNoticeDm: '使う人全員へ本人DMで通知する', connectionNoticeChannels: '使うチャンネル全てへ公開する（そのチャンネルの参加者にも見えます）',
        stepSave: "1 設定を保存",
        stepCommands: "2 Discordにコマンドを追加",
        stepStart: "3 接続を開始",
        advanced: "詳細設定・診断",
        alias: "作業フォルダーの名前",
        folder: "フォルダーの絶対パス",
        addWorkspace: "フォルダーを追加",
        removeWorkspace: "フォルダーを除く",
        workspaceHelp: "任意です。空欄のまま接続できます。接続後にDiscordの /agent workspace-add で既存フォルダーを許可し、Sessionを選んでください。フォルダー許可はOS sandboxではありません。コマンドのパスはDiscordへ送られるため、秘密の文字列は含めないでください。",
        idHelp: "Discord → ユーザー設定 → 詳細設定 → 開発者モードをオン。サーバー・ユーザー・チャンネルを右クリック → IDをコピー。",
        appHelp: "Discord Developer Portal → 対象アプリ → General Information → Application IDをコピー。",
        requiredId: "数字のDiscord IDを入力してください。",
        requiredList: "コピーした17～20桁のIDを1行ずつ、重複なく1～100件入力してください。",
        requiredWorkspace: "名前は英数字・_・-の1～40文字で重複なく指定し、既存フォルダーの絶対パスを入力してください（最大32件）。",
        requiredToken: "初回保存前に新しいBot tokenを入力してください。",
        unsaved: "先に設定を保存するか、変更を破棄してから登録・接続してください。これらの操作は入力中のTokenを送信しません。",
        discard: "未保存の変更を破棄",
        optionalTest: "任意です。保存時にもTokenを確認するので、事前テストは不要です。入力したTokenは送信直後に消去されます。",
        commandsNote: "Hostにはコマンド登録状態の保存がありません。初回設定・コマンド更新時は設定保存後に登録してください。",
        useHelp: "フォルダー未設定なら許可チャンネルで /agent workspace-add alias:main path:<PCの絶対パス> confirm-access:true → /agent new workspace:main → /agent prompt text:<指示>。既存Sessionは /agent sessions → /agent bind session:<ID>。結果は /agent result。<>は実際の値に置換。承認はこのPCで対応します。",
        title: 'DiscordからDSHを使う', intro: '設定を保存し、コマンドを追加してから接続します。保存だけでは接続しません。',
        singleOperator: 'このDSHを使える人が管理できます', singleOperatorBody: 'ユーザー別の管理権限は分かれていません。ログイン済みのDSHを他人と共有しないでください。',
        scope: 'PCとDiscordは交互に使ってください', scopeBody: '同じSessionへの同時送信は防げません。PCで実行中はDiscordから送信しないでください。結果不明の指示は再送せずPCで確認します。承認・実行停止・添付・成果物はPCのDSHで扱います。',
        statusTitle: 'Receiver状態', refresh: '状態を更新', refreshing: '更新中…', state: '状態', state_unconfigured: '未設定', state_stopped: '停止', state_connecting: '接続中', state_connected: '接続済み', state_blocked: 'ブロック', state_disposed: '破棄済み', tokenState: 'Bot token', tokenSet: 'Hostに保存済み', tokenMissing: '未設定', bot: 'Discord bot', notReported: '未報告',
        settingsTitle: 'Discord設定', settingsHelp: '使うサーバー・人・チャンネルを指定します。作業フォルダーは任意で、接続後にDiscordから追加できます。初回は下のBot tokenも入力して保存してください。', guildId: 'サーバーID', applicationId: 'Application ID', allowedUsers: '使う人のユーザーID（まず自分だけ）', allowedChannels: '使うチャンネルのID', onePerLine: 'IDをコピーして1行に1つ入力してください。', workspaces: '作業フォルダー（任意）', workspacesHint: 'alias=絶対パスを1行ずつ入力。例: main=C:\\Work\\repo', autoStart: 'Host起動時にReceiverを起動', autoStartHelp: '自動起動は初期状態でオフです。保存済みの現在の版で明示的に確認した開始が成功した後だけ、今後のHost起動に有効になります。保存・停止・Token削除で解除されます。', confirmAutoStart: '今後のHost再起動時にReceiverを自動起動することに明示的に同意します。', autoStartConsentRequired: '保存前に自動起動を明示的に確認してください。',
        tokenTitle: 'Bot token — 書き込み専用', tokenHelp: '空欄なら保存済みTokenを維持します。入力値はHostにのみ送信され、この画面では読み戻し・保存しません。', tokenPlaceholder: '保存済みTokenを置き換える場合のみ入力', testToken: 'Tokenをテスト', testing: 'テスト中…', testHint: '入力値をテストします。空欄の場合は保存済みTokenをテストします。',
        save: '設定を保存', saving: '保存中…', start: '接続を開始', stop: 'Discord接続を停止', reconnect: '再接続', receiverControls: '接続操作', startHelp: '接続だけを操作します。PCで開始済みの実行は停止しません。', exclusiveControlHelp: '旧CLIや別のReceiverを同時に起動せず、PC実行中は送信しないでください。', confirmExclusive: '旧CLI/別receiverを停止済みで、PC実行中は送信しないことを確認します。',
        commandsTitle: 'Discordコマンド', commandsHelp: 'コマンド登録はDiscordアプリを変更します。続行前に明示的に確認してください。', confirmCommands: 'Discordアプリのコマンドを登録・更新することを確認します。', registerCommands: 'コマンドを登録', registering: '登録中…',
        deleteTitle: '保存済みTokenを削除', deleteHelp: 'このReceiverを停止し、Hostに保存されたTokenを完全に削除します。Native DSHの実行は停止しません。', confirmDelete: '保存済みTokenが削除されることを理解しました。', deleteSecret: '保存済みTokenを削除', deleting: '削除中…',
        diagnostics: '診断', activeRuns: '実行中のRun', unknownRuns: '結果不明のRun', pendingNotifications: '保留中の通知', lastError: '直近の安全なエラーコード',
        capabilities: '機能の制限', textCapability: 'テキスト操作', atomicCapability: 'Desktop送信とのatomic性', approvalCapability: 'Discordからの承認', cancelCapability: 'DiscordからのRunキャンセル', attachmentsCapability: '添付ファイル', artifactsCapability: '成果物ダウンロード', supported: '利用可能と報告', unavailable: '利用不可', unknown: '不明',
        noStatus: 'Host状態を取得できません。変更前に更新してください。', loadFailed: 'Host状態を取得できませんでした。設定は変更されていません。', connectionUnavailable: '認証済みDSH接続を利用できません。', operationFailed: 'Hostが操作を拒否しました。', resultUnknown: '操作結果を確認できません。再送していません。再操作前に状態を更新してください。', invalidWorkspaces: '各行を alias=絶対パス の形式で入力してください。', testSuccess: 'Discord Tokenのテストに成功しました: ', testFailed: 'Discord Tokenのテストに失敗しました。', saved: '設定を保存しました。', started: 'Receiverを開始しました。', stopped: 'Receiverを停止しました。', reconnected: '再接続を要求しました。', commandsRegistered: 'コマンド登録が完了しました。', secretDeleted: '保存済みTokenを削除しました。', unexpected: 'Hostから予期しない応答がありました。', busy: '別の操作が進行中です。',
      },
    };

    function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function text(value) { return typeof value === 'string' ? value : ''; }
    function safeCode(value) {
      return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value) ? value : '';
    }
    function isStatus(value) {
      return isRecord(value) && value.profile === 'single-operator-text-v1'
        && typeof value.tokenConfigured === 'boolean' && STATES.has(value.state)
        && Number.isSafeInteger(value.revision) && value.revision >= 0
        && (value.settings === null || isRecord(value.settings) && typeof value.settings.autoStart === 'boolean');
    }
    function normalizeStatus(value) {
      if (!isStatus(value)) return null;
      const state = STATES.has(value.state) ? value.state : 'unknown';
      const caps = isRecord(value.capabilities) ? value.capabilities : {};
      const count = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null;
      return {
        profile: value.profile,
        revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : null,
        state,
        tokenConfigured: value.tokenConfigured,
        botId: text(value.botId),
        botName: text(value.botName),
        settings: isRecord(value.settings) ? value.settings : null,
        capabilities: {
          text: typeof caps.text === 'boolean' ? caps.text : null,
          atomicAcceptance: typeof caps.atomicAcceptance === 'boolean' ? caps.atomicAcceptance : null,
          approval: typeof caps.approval === 'boolean' ? caps.approval : null,
          cancel: typeof caps.cancel === 'boolean' ? caps.cancel : null,
          attachments: typeof caps.attachments === 'boolean' ? caps.attachments : null,
          artifacts: typeof caps.artifacts === 'boolean' ? caps.artifacts : null,
        },
        activeRuns: count('activeRuns'),
        unknownRuns: count('unknownRuns'),
        pendingNotifications: count('pendingNotifications'),
        lastError: safeCode(value.lastError),
      };
    }
    function identity(value) {
      return isRecord(value) && typeof value.botId === 'string' && typeof value.botName === 'string'
        ? { botId: value.botId.slice(0, 128), botName: value.botName.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 100) }
        : null;
    }
    function splitLines(value) {
      return text(value).split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
    }
    function draftFrom(settings) {
      const source = isRecord(settings) ? settings : {};
      const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : '';
      const workspaces = isRecord(source.workspaces) ? source.workspaces : {};
      return {
        guildId: text(source.guildId),
        applicationId: text(source.applicationId),
        allowedUserIds: list(source.allowedUserIds),
        allowedChannelIds: list(source.allowedChannelIds),
        workspaces: Object.keys(workspaces).sort().flatMap(key => typeof workspaces[key] === 'string' ? [{ alias: key, path: workspaces[key] }] : []).concat(Object.keys(workspaces).length ? [] : [{ alias: '', path: '' }]),
        autoStart: source.autoStart === true,
        connectionDm: source.connectionNotifications?.dm === true,
        connectionChannels: source.connectionNotifications?.channels === true,
      };
    }
    function parseWorkspaces(value) {
      const result = Object.create(null);
      if (!Array.isArray(value) || value.length > 32) return null;
      for (const row of value) {
        const alias = text(row.alias).trim();
        const path = text(row.path).trim();
        if (!alias && !path) continue;
        if (!/^[a-zA-Z0-9_-]{1,40}$/u.test(alias) || !path || path.length > 1024 || /[\0\r\n]/u.test(path) || !/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(path) || Object.hasOwn(result, alias)) return null;
        result[alias] = path;
      }
      return result;
    }
    // Compare effective nonsecret settings, not whether an input ever fired onChange.
    function draftKey(draft) {
      const workspaces = parseWorkspaces(draft.workspaces);
      if (workspaces === null) return null;
      return JSON.stringify({
        guildId: draft.guildId.trim(), applicationId: draft.applicationId.trim(),
        allowedUserIds: splitLines(draft.allowedUserIds).sort(),
        allowedChannelIds: splitLines(draft.allowedChannelIds).sort(),
        workspaces: Object.keys(workspaces).sort().map(alias => [alias, workspaces[alias]]),
        autoStart: draft.autoStart, connectionDm: draft.connectionDm, connectionChannels: draft.connectionChannels,
      });
    }
    function displayCount(value) { return Number.isSafeInteger(value) && value >= 0 ? String(value) : '—'; }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NAMESPACE, { en: dictionaries.en, zh: dictionaries.zh }));
        ctx.effect(() => ctx.locale.register(NAMESPACE, 'ja', dictionaries.ja));
        // Plugin-instance memory only: navigation may unmount the settings page.
        // Never retain confirmations or put candidate credentials in browser storage.
        const retained = { draft: null, token: '', uncertain: false };
        ctx.effect(() => () => { retained.draft = null; retained.token = ''; retained.uncertain = false; });

        function SettingsPage({ t: translate, view }) {
          // A page-local choice: never change DSH's global language or persist secrets.
          const [language, setLanguage] = React.useState('system');
          const t = key => language === 'system' ? translate(key) : dictionaries[language][key] || translate(key);
          const [status, setStatus] = React.useState(null);
          const [draft, setDraft] = React.useState(() => retained.draft || draftFrom(null));
          const [dirty, setDirty] = React.useState(!!retained.draft);
          const [tokenInput, setTokenInput] = React.useState(retained.token);
          const [busy, setBusy] = React.useState(true);
          const [pendingOperation, setPendingOperation] = React.useState('status');
          const [uncertain, setUncertain] = React.useState(retained.uncertain);
          const [message, setMessage] = React.useState(null);
          const [confirmCommands, setConfirmCommands] = React.useState(false);
          const [confirmDelete, setConfirmDelete] = React.useState(false);
          const [confirmExclusive, setConfirmExclusive] = React.useState(false);
          const [validation, setValidation] = React.useState(false);
          const [confirmAutoStart, setConfirmAutoStart] = React.useState(false);
          const dirtyRef = React.useRef(!!retained.draft);
          const draftRef = React.useRef(draft);
          const statusRef = React.useRef(null);
          const busyRef = React.useRef(false);
          const pendingRequests = React.useRef(new Set());

          function applyStatus(value, forceDraft = false) {
            const next = normalizeStatus(value);
            if (!next) return false;
            const previous = statusRef.current;
            statusRef.current = next;
            setStatus(next);
            retained.uncertain = false;
            setUncertain(false);
            if (forceDraft || !previous || next.revision !== previous.revision) {
              setConfirmCommands(false);
              setConfirmExclusive(false);
            }
            if (forceDraft || !dirtyRef.current) {
              const nextDraft = draftFrom(next.settings);
              retained.draft = null;
              draftRef.current = nextDraft;
              setDraft(nextDraft);
              dirtyRef.current = false;
              setDirty(false);
            }
            if (!forceDraft && dirtyRef.current) {
              const key = draftKey(draftRef.current);
              const changed = key === null || key !== draftKey(draftFrom(next.settings));
              dirtyRef.current = changed;
              setDirty(changed);
              retained.draft = changed ? draftRef.current : null;
            }
            return true;
          }
          function updateToken(value) {
            retained.token = value;
            setTokenInput(value);
          }
          // Bound even an RPC implementation that ignores AbortSignal. Late replies
          // never reach applyStatus; abort only cancels transport, not a Host mutation.
          async function callHost(request, signal) {
            const rpc = ctx.connection && ctx.connection.rpc;
            if (!rpc || typeof rpc.call !== 'function') throw new Error('unavailable');
            const transport = new AbortController();
            let timer;
            let abort;
            try {
              return await new Promise((resolve, reject) => {
                abort = () => { reject(new Error('aborted')); transport.abort(); };
                if (signal.aborted) { abort(); return; }
                signal.addEventListener('abort', abort, { once: true });
                timer = setTimeout(() => {
                  reject(new Error('timeout'));
                  transport.abort();
                }, request.operation === 'status' ? STATUS_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
                Promise.resolve(rpc.call(CHANNEL, ENDPOINT, request, transport.signal)).then(resolve, reject);
              });
            } finally {
              clearTimeout(timer);
              if (abort) signal.removeEventListener('abort', abort);
            }
          }
          async function readStatus(signal) {
            const envelope = await callHost({ operation: 'status' }, signal);
            const response = envelope?.ok === true ? envelope.value : null;
            if (signal.aborted) return;
            if (!isRecord(response) || response.ok !== true || !applyStatus(response.value)) {
              statusRef.current = null; setStatus(null);
              throw new Error('invalid');
            }
          }
          React.useEffect(() => {
            const controller = new AbortController();
            pendingRequests.current.add(controller);
            setBusy(true);
            setPendingOperation('status');
            busyRef.current = true;
            void readStatus(controller.signal).then(() => {
              if (!controller.signal.aborted) setMessage(null);
            }).catch(error => {
              if (!controller.signal.aborted) setMessage({ kind: 'error', text: t(error.message === 'timeout' ? 'statusTimeout' : 'loadFailed') });
            }).finally(() => {
              if (!controller.signal.aborted) {
                pendingRequests.current.delete(controller);
                busyRef.current = false;
                setBusy(false);
              }
            });
            return () => {
              for (const pending of pendingRequests.current) pending.abort();
              pendingRequests.current.clear();
              busyRef.current = false;
            };
          }, []);

          async function refresh() {
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy(true);
            setPendingOperation('status');
            setMessage(null);
            const controller = new AbortController();
            pendingRequests.current.add(controller);
            try {
              await readStatus(controller.signal);
            } catch (error) {
              if (!controller.signal.aborted) {
                statusRef.current = null; setStatus(null);
                setMessage({ kind: 'error', text: t(error.message === 'timeout' ? 'statusTimeout' : 'loadFailed') });
              }
            } finally {
              if (!controller.signal.aborted) {
                pendingRequests.current.delete(controller);
                busyRef.current = false;
                setBusy(false);
              }
            }
          }

          async function invoke(request, operation) {
            if (busyRef.current) return;
            // No dispatch means a known local failure, not an uncertain Host result.
            if (!ctx.connection?.rpc || typeof ctx.connection.rpc.call !== 'function') {
              setMessage({ kind: 'error', text: t('connectionUnavailable') });
              return;
            }
            if (['start', 'registerCommands', 'reconnect'].includes(operation) && (dirtyRef.current || tokenInput.length > 0)) { setMessage({ kind: 'error', text: t('unsaved') }); return; }
            busyRef.current = true;
            setBusy(true);
            setPendingOperation(operation);
            setMessage(null);
            const submittedToken = Object.hasOwn(request, 'token') ? request.token : undefined;
            if (submittedToken !== undefined) updateToken('');
            if (operation !== 'test') { retained.uncertain = true; setUncertain(true); }
            const controller = new AbortController();
            pendingRequests.current.add(controller);
            try {
              const envelope = await callHost(request, controller.signal);
              const response = envelope?.ok === true ? envelope.value : null;
              if (controller.signal.aborted) return;
              if (!isRecord(response) || typeof response.ok !== 'boolean') {
                throw new Error('invalid');
              }
              if (response.ok !== true) {
                const code = safeCode(response.code);
                setMessage({ kind: 'error', text: code ? `${t('operationFailed')} ${code}` : t('operationFailed') });
                if (operation !== 'test') {
                  try { await readStatus(controller.signal); } catch { statusRef.current = null; setStatus(null); /* Status refresh is safe; never replay the mutation. */ }
                }
                return;
              }
              if (operation === 'test') {
                const bot = identity(response.value);
                if (bot) setMessage({ kind: 'success', text: `${t('testSuccess')}${bot.botName} (${bot.botId})` });
                else setMessage({ kind: 'error', text: t('unexpected') });
                return;
              }
              if (isStatus(response.value)) {
                applyStatus(response.value, operation === 'save');
              } else {
                statusRef.current = null; setStatus(null);
                await readStatus(controller.signal);
                if (controller.signal.aborted) return;
              }
              const success = operation === 'save' ? 'saved'
                : operation === 'start' ? 'started'
                  : operation === 'stop' ? 'stopped'
                    : operation === 'reconnect' ? 'reconnected'
                      : operation === 'registerCommands' ? 'commandsRegistered'
                        : operation === 'deleteSecret' ? 'secretDeleted' : 'unexpected';
              setMessage({ kind: 'success', text: t(operation === 'save' ? 'confirmAfterSave' : success) });
            } catch {
              if (!controller.signal.aborted) {
                setMessage({ kind: 'error', text: t('resultUnknown') });
                if (operation !== 'test') {
                  try { await readStatus(controller.signal); } catch { statusRef.current = null; setStatus(null); /* Do not replay an uncertain operation. */ }
                }
              }
            } finally {
              if (!controller.signal.aborted) {
                pendingRequests.current.delete(controller);
                busyRef.current = false;
                setBusy(false);
              }
            }
          }

          function edit(key, value) {
            setConfirmCommands(false);
            setConfirmExclusive(false);
            const next = { ...draftRef.current, [key]: value };
            const saved = statusRef.current;
            const normalized = draftKey(next);
            const changed = !saved || normalized === null || normalized !== draftKey(draftFrom(saved.settings));
            draftRef.current = next;
            retained.draft = changed ? next : null;
            dirtyRef.current = changed;
            setDirty(changed);
            setDraft(next);
          }
          function revisionRequest(operation, extra = {}) {
            if (!status || !Number.isSafeInteger(status.revision)) return null;
            return { operation, expectedRevision: status.revision, ...extra };
          }
          function field(label, key, options = {}) {
            const id = `dra-${key}`;
            const controlProps = {
              id,
              className: `dra-control${options.secret ? ' dra-token' : ''}`,
              value: key === 'token' ? tokenInput : draft[key],
              disabled: busy && pendingOperation !== 'status',
              'aria-invalid': validation && !!errors[key],
              'aria-describedby': [options.hint ? `${id}-hint` : '', validation && errors[key] ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined,
              spellCheck: false,
              ...(options.secret ? { type: 'password', autoComplete: 'new-password', autoCapitalize: 'off' } : {}),
              ...(options.multiline ? { rows: options.rows || 3 } : {}),
              onChange: event => {
                if (key === 'token') {
                  setConfirmCommands(false);
                  setConfirmExclusive(false);
                  updateToken(event.target.value);
                } else edit(key, event.target.value);
              },
            };
            return h('div', { className: 'dra-field', key },
              h('label', { className: 'dra-label', htmlFor: id }, label),
              options.multiline ? h('textarea', controlProps) : h('input', controlProps),
              options.hint ? h('span', { className: 'dra-hint', id: `${id}-hint` }, options.hint) : null,
              validation && errors[key] ? h('span', { className: 'dra-message', 'data-kind': 'error', id: `${id}-error` }, errors[key]) : null);
          }
          function checkbox(label, checked, onChange, id) {
            return h('label', { className: 'dra-checkbox', htmlFor: id, key: id },
              h('input', { id, type: 'checkbox', checked, disabled: busy && pendingOperation !== 'status', onChange: event => onChange(event.target.checked) }),
              h('span', null, label));
          }
          function capability(label, value, key) {
            const state = value === true ? 'true' : value === false ? 'false' : 'unknown';
            const textValue = value === true ? t('supported') : value === false ? t('unavailable') : t('unknown');
            return h('li', { className: 'dra-capability', 'data-supported': state, key },
              h('span', null, label), h('strong', null, textValue));
          }
          function stat(label, value, key) {
            return h('div', { className: 'dra-stat', key }, h('dt', null, label), h('dd', null, displayCount(value)));
          }

          const canMutate = !!status && Number.isSafeInteger(status.revision) && !busy && !uncertain;
          const state = status ? status.state : 'unknown';
          const workspaceMap = parseWorkspaces(draft.workspaces);
          const errors = {};
          for (const key of ['guildId', 'applicationId']) if (!/^\d{17,20}$/u.test(draft[key].trim())) errors[key] = t('requiredId');
          for (const key of ['allowedUserIds', 'allowedChannelIds']) {
            const ids = splitLines(draft[key]);
            if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^\d{17,20}$/u.test(id))) errors[key] = t('requiredList');
          }
          if (workspaceMap === null) errors.workspaces = t('requiredWorkspace');
          if (status && !status.tokenConfigured && !tokenInput.trim()) errors.token = t('requiredToken');
          const formInvalid = Object.keys(errors).length > 0;
          const unsaved = dirty || tokenInput.length > 0;
          const canUseSaved = canMutate && !!status.settings && !unsaved;
          const canTest = !busy && !!status && (status.tokenConfigured || tokenInput.length > 0);
          const canStart = canUseSaved && status.tokenConfigured && confirmExclusive && !['connected', 'connecting', 'blocked', 'disposed'].includes(state);
          const canStop = canMutate && ['connected', 'connecting'].includes(state);
          const canReconnect = canUseSaved && confirmExclusive && ['connected', 'connecting'].includes(state);
          const autoStartNeedsConsent = !!draft.autoStart && (!status || !isRecord(status.settings) || status.settings.autoStart !== true);

          const commonBlock = busy ? t(pendingOperation === 'status' ? 'statusLoading' : 'waitingOperation')
            : !status ? t('saveBlocked') : uncertain ? t('unknownBlocked') : '';
          const savedBlock = commonBlock || (unsaved ? t('unsaved') : !status.settings || !status.tokenConfigured ? t('tokenNeeded') : '');
          const commandsBlock = savedBlock || (!confirmCommands ? t('confirmCommandsNeeded') : '');
          const startBlock = savedBlock || (!confirmExclusive ? t('confirmStartNeeded') : !canStart ? t('stateBlocked') : '');
          if (view !== 'page') return null;
          return h('div', { className: 'dra-root', 'aria-busy': busy ? 'true' : 'false' },
            h('style', null, CSS),
            h('div', { className: 'dra-stack' },
              h('header', null,
                h('h2', { className: 'dra-heading' }, t('title')),
                h('p', { className: 'dra-copy' }, t('intro')),
                h('div', { className: 'dra-field', style: { maxWidth: 240, marginTop: 12 } },
                  h('label', { className: 'dra-label', htmlFor: 'dra-language' }, '表示言語 / Language'),
                  h('select', { id: 'dra-language', className: 'dra-control', value: language,
                    onChange: event => { if (['system', 'ja', 'en', 'zh'].includes(event.target.value)) setLanguage(event.target.value); } },
                    h('option', { value: 'system' }, 'DSHの設定 / Follow DSH'),
                    h('option', { value: 'ja' }, '日本語'), h('option', { value: 'en' }, 'English'),
                    h('option', { value: 'zh' }, '简体中文')))),
              h('div', { className: 'dra-notice' },
                h('strong', null, t('singleOperator')),
                h('p', null, t('singleOperatorBody'))),
              h('div', { className: 'dra-notice' },
                h('strong', null, t('scope')),
                h('p', null, t('scopeBody'))),
              unsaved ? h('div', { className: 'dra-message' }, t('unsaved'), h('div', { className: 'dra-actions' }, h('button', { className: 'dra-button', type: 'button', disabled: !canMutate, onClick: () => { if (!status || busyRef.current) return; updateToken(''); retained.draft = null; dirtyRef.current = false; setDirty(false); draftRef.current = draftFrom(status.settings); setDraft(draftRef.current); setValidation(false); setConfirmExclusive(false); setConfirmCommands(false); setConfirmAutoStart(false); } }, t('discard')))) : null,
              message ? h('div', { className: 'dra-message', 'data-kind': message.kind, role: message.kind === 'error' ? 'alert' : 'status', 'aria-live': 'polite' }, message.text) : null,
              h('p', { className: 'dra-hint' }, t('draftHelp')),
              commonBlock ? h('div', { className: 'dra-message', role: 'status', 'aria-live': 'polite' },
                h('p', { id: 'dra-save-blocked', className: 'dra-copy' }, commonBlock),
                h('div', { className: 'dra-actions' }, h('button', { className: 'dra-button', type: 'button', disabled: busy, onClick: refresh }, t('retryStatus')))) : null,
              h('form', { className: 'dra-section', onSubmit: event => {
                event.preventDefault();
                setValidation(true);
                if (!canMutate) return;
                if (autoStartNeedsConsent && !confirmAutoStart) { setMessage({ kind: 'error', text: t('autoStartConsentRequired') }); return; }
                if (formInvalid) { setMessage({ kind: 'error', text: Object.values(errors)[0] }); return; }
                const request = revisionRequest('save', {
                  settings: {
                    guildId: draft.guildId.trim(),
                    applicationId: draft.applicationId.trim(),
                    allowedUserIds: splitLines(draft.allowedUserIds),
                    allowedChannelIds: splitLines(draft.allowedChannelIds),
                    workspaces: workspaceMap,
                    autoStart: draft.autoStart === true,
                    connectionNotifications: { dm: draft.connectionDm === true, channels: draft.connectionChannels === true },
                  },
                  ...(tokenInput.length > 0 ? { token: tokenInput } : {}),
                });
                if (request) void invoke(request, 'save');
              } },
                h('h3', { className: 'dra-section-title' }, t('stepSave')),
                h('p', { className: 'dra-copy' }, t('settingsHelp')),
                h('div', { className: 'dra-grid' },
                  field(t('guildId'), 'guildId', { hint: t('idHelp') }),
                  field(t('applicationId'), 'applicationId', { hint: t('appHelp') }),
                  field(t('allowedUsers'), 'allowedUserIds', { multiline: true, hint: t('onePerLine') }),
                  field(t('allowedChannels'), 'allowedChannelIds', { multiline: true, hint: t('onePerLine') }),
                  h('div', { className: 'dra-field' },
                    h('span', { className: 'dra-label' }, t('workspaces')),
                    ...draft.workspaces.map((row, index) => h('div', { className: 'dra-grid', key: index },
                      ...['alias', 'path'].map(key => h('div', { className: 'dra-field', key },
                        h('label', { className: 'dra-label', htmlFor: 'dra-workspace-' + index + '-' + key }, t(key === 'alias' ? 'alias' : 'folder')),
                        h('input', { id: 'dra-workspace-' + index + '-' + key, className: 'dra-control', value: row[key], disabled: busy && pendingOperation !== 'status', 'aria-invalid': validation && !!errors.workspaces, 'aria-describedby': validation && errors.workspaces ? 'dra-workspaces-help dra-workspaces-error' : 'dra-workspaces-help', onChange: event => edit('workspaces', draft.workspaces.map((item, i) => i === index ? { ...item, [key]: event.target.value } : item)) }))),
                      h('button', { className: 'dra-button', type: 'button', disabled: busy && pendingOperation !== 'status', onClick: () => edit('workspaces', draft.workspaces.filter((_, i) => i !== index)) }, t('removeWorkspace')))),
                    h('span', { className: 'dra-hint', id: 'dra-workspaces-help' }, t('workspaceHelp')),
                    validation && errors.workspaces ? h('span', { className: 'dra-message', 'data-kind': 'error', id: 'dra-workspaces-error' }, errors.workspaces) : null,
                    h('button', { className: 'dra-button', type: 'button', disabled: busy && pendingOperation !== 'status', onClick: () => edit('workspaces', [...draft.workspaces, { alias: '', path: '' }]) }, t('addWorkspace')))),
                h('fieldset', { className: 'dra-section', style: { borderLeft: 0, borderRight: 0, borderBottom: 0, margin: '14px 0 0', minWidth: 0 } },
                  h('legend', { className: 'dra-section-title' }, t('connectionNoticeTitle')),
                  h('p', { className: 'dra-hint', id: 'dra-connection-notice-help' }, t('connectionNoticeHelp')),
                  h('div', { className: 'dra-stack', style: { gap: 8 } },
                    checkbox(t('connectionNoticeDm'), draft.connectionDm, value => edit('connectionDm', value), 'dra-connection-dm'),
                    checkbox(t('connectionNoticeChannels'), draft.connectionChannels, value => edit('connectionChannels', value), 'dra-connection-channels'))),
                h('details', null, h('summary', { className: 'dra-section-title' }, t('advanced')),
                h('div', { className: 'dra-actions' },
                  checkbox(t('autoStart'), draft.autoStart, value => { setConfirmAutoStart(false); edit('autoStart', value); }, 'dra-auto-start')),
                h('p', { className: 'dra-hint' }, t('autoStartHelp')),
                draft.autoStart ? checkbox(t('confirmAutoStart'), confirmAutoStart, setConfirmAutoStart, 'dra-confirm-auto-start') : null),
                h('div', { className: 'dra-grid' },
                  field(t('tokenTitle'), 'token', { secret: true, hint: t('tokenHelp') })),
                h('div', { className: 'dra-actions' },
                  h('button', { className: 'dra-button', type: 'submit', 'data-kind': unsaved || !status || !status.tokenConfigured ? 'primary' : undefined, disabled: !canMutate, 'aria-describedby': commonBlock ? 'dra-save-blocked' : undefined }, busy && pendingOperation === 'save' ? t('saving') : t('save'))),
                 h('details', null, h('summary', { className: 'dra-label' }, t('testToken')),
                 h('div', { className: 'dra-actions' },
                  h('button', { className: 'dra-button', type: 'button', disabled: !canTest, onClick: () => { if (!canTest) return; void invoke({ operation: 'test', ...(tokenInput.length > 0 ? { token: tokenInput } : {}) }, 'test'); } }, busy ? t('testing') : t('testToken')),
                  h('span', { className: 'dra-hint' }, t('optionalTest'))))),
              h('section', { className: 'dra-section', 'aria-labelledby': 'dra-commands-title' },
                h('h3', { id: 'dra-commands-title', className: 'dra-section-title' }, t('stepCommands')),
                h('p', { className: 'dra-copy' }, t('commandsHelp')),
                 h('p', { className: 'dra-hint' }, t('commandsNote')),
                checkbox(t('confirmCommands'), confirmCommands, setConfirmCommands, 'dra-confirm-commands'),
                h('div', { className: 'dra-actions' },
                  h('button', { className: 'dra-button', type: 'button', disabled: !canUseSaved || !confirmCommands || !status.tokenConfigured, 'aria-describedby': commandsBlock ? 'dra-commands-blocked' : undefined, onClick: () => {
                    if (!confirmCommands || !canUseSaved || !status || !status.tokenConfigured) return;
                    const request = revisionRequest('registerCommands', { confirmation: true });
                    if (request) { setConfirmCommands(false); void invoke(request, 'registerCommands'); }
                  } }, busy && pendingOperation === 'registerCommands' ? t('registering') : t('registerCommands'))),
                commandsBlock ? h('p', { id: 'dra-commands-blocked', className: 'dra-hint' }, commandsBlock) : null),
              h('section', { className: 'dra-section', 'aria-labelledby': 'dra-status-title' },
                h('h3', { id: 'dra-status-title', className: 'dra-section-title' }, t('stepStart')),
                status ? h('div', { className: 'dra-status' },
                  h('span', { className: 'dra-state', 'data-state': state }, h('span', { className: 'dra-dot', 'aria-hidden': 'true' }), `${t('state')}: ${t(STATES.has(state) ? `state_${state}` : 'unknown')}`),
                  h('span', { className: 'dra-meta' }, `${t('tokenState')}: ${status.tokenConfigured ? t('tokenSet') : t('tokenMissing')}`),
                  status.botName ? h('span', { className: 'dra-meta' }, `${t('bot')}: ${status.botName}${status.botId ? ` (${status.botId})` : ''}`) : null)
                  : h('p', { className: 'dra-copy' }, t('noStatus')),
                h('p', { className: 'dra-copy' }, t('exclusiveControlHelp')),
                checkbox(t('confirmExclusive'), confirmExclusive, setConfirmExclusive, 'dra-confirm-exclusive'),
                h('div', { className: 'dra-actions' },
                  h('button', { className: 'dra-button', type: 'button', disabled: busy, onClick: refresh }, busy ? t('refreshing') : t('refresh')),
                  h('button', { className: 'dra-button', type: 'button', 'data-kind': !unsaved && status && status.settings && status.tokenConfigured && state === 'stopped' ? 'primary' : undefined, disabled: !canStart, 'aria-describedby': startBlock ? 'dra-start-blocked' : undefined, onClick: () => { if (!canStart) return; const request = revisionRequest('start', { confirmation: true }); if (request) { setConfirmExclusive(false); void invoke(request, 'start'); } } }, t('start')),
                  h('button', { className: 'dra-button', type: 'button', disabled: !canStop, onClick: () => { if (!canStop) return; setConfirmExclusive(false); const request = revisionRequest('stop'); if (request) void invoke(request, 'stop'); } }, t('stop'))),
                startBlock ? h('p', { id: 'dra-start-blocked', className: 'dra-hint' }, startBlock) : null,
                h('p', { className: 'dra-hint' }, t('startHelp')),
                 status && status.lastError ? h('p', { className: 'dra-message', 'data-kind': 'error' }, status.lastError === 'CONNECTION_NOTICE_UNCONFIRMED' ? t('connectionNoticeWarning') : `${t('lastError')}: ${status.lastError}`) : null,
                 state === 'connected' ? h('p', { className: 'dra-copy' }, t('useHelp')) : null),
              h('details', { className: 'dra-section' }, h('summary', { className: 'dra-section-title' }, t('deleteTitle')),
                h('p', { className: 'dra-copy' }, t('deleteHelp')),
                checkbox(t('confirmDelete'), confirmDelete, setConfirmDelete, 'dra-confirm-delete'),
                h('div', { className: 'dra-actions' },
                  h('button', { className: 'dra-button', 'data-kind': 'danger', type: 'button', disabled: !canMutate || !confirmDelete || !status.tokenConfigured, onClick: () => {
                    if (!confirmDelete || !canMutate || !status || !status.tokenConfigured) return;
                    const request = revisionRequest('deleteSecret', { confirmation: true });
                    if (request) void invoke(request, 'deleteSecret');
                    setConfirmDelete(false);
                  } }, busy ? t('deleting') : t('deleteSecret')))),
              h('details', { className: 'dra-section' }, h('summary', { className: 'dra-section-title' }, t('advanced')), h('div', { className: 'dra-actions' }, h('button', { className: 'dra-button', type: 'button', disabled: !canReconnect, onClick: () => { if (!canReconnect) return; const request = revisionRequest('reconnect', { confirmation: true }); if (request) { setConfirmExclusive(false); void invoke(request, 'reconnect'); } } }, t('reconnect'))), h('h3', { className: 'dra-section-title' }, t('diagnostics')),
                status ? h('dl', { className: 'dra-stats' },
                  stat(t('activeRuns'), status.activeRuns, 'active'),
                  stat(t('unknownRuns'), status.unknownRuns, 'unknown'),
                  stat(t('pendingNotifications'), status.pendingNotifications, 'pending')) : null,
                status && status.lastError ? h('p', { className: 'dra-copy' }, `${t('lastError')}: `, h('code', { className: 'dra-inline-code' }, status.lastError)) : null,
                h('ul', { className: 'dra-capabilities' },
                  capability(t('textCapability'), status ? status.capabilities.text : null, 'text'),
                  capability(t('atomicCapability'), status ? status.capabilities.atomicAcceptance : null, 'atomic'),
                  capability(t('approvalCapability'), status ? status.capabilities.approval : null, 'approval'),
                  capability(t('cancelCapability'), status ? status.capabilities.cancel : null, 'cancel'),
                  capability(t('attachmentsCapability'), status ? status.capabilities.attachments : null, 'attachments'),
                  capability(t('artifactsCapability'), status ? status.capabilities.artifacts : null, 'artifacts')))));
        }

        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: PACKAGE, locale: NAMESPACE,
        }, SettingsPage));
      },
    };
  },
});
