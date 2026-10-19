# Chapter 23A Discord commands

This chapter implements the server-only command-verification slice of specification §23. It does not enable DM-only mode, model/settings mutation, or any C-priority operation. Discord command registration remains an explicit authenticated GUI action; this work does not register commands against Discord. Folder configuration is optional for saving/connecting. An empty allowlist grants no Session access until an operator adds a folder in the GUI or with `/agent workspace-add`. The command updates the saved revision and disarms future auto-start, without stopping the current receiver; stale GUI saves are rejected.

## Registered surface

The `/agent` root has 15 children (14 subcommands and one group), each subcommand has at most 3 options, and `/agent notifications` has 3 subcommands. Thus no command hierarchy level exceeds Discord's 25-option limit.

| Command | Behavior and limits |
| --- | --- |
| `/agent help [topic]` | Lists implemented features and explains unsupported contract-dependent operations. |
| `/agent current` | Shows the selected, authorized Session; safe title, configured Workspace alias when it matches, observed busy state, Binding version, model/reasoning availability, and notification preferences. |
| `/agent workspaces` | Lists configured aliases only; never returns local paths. |
| `/agent workspace-add alias:<new> path:<absolute> confirm-access:true` | Allows an existing directory after connection. Requires configured user/Guild/Channel and explicit access confirmation. Adds at most 32 aliases, never overwrites an alias or selects/creates a Session. Persists before granting runtime access; revision conflicts fail closed. Changes neither credentials nor existing Runs. Paths are submitted to Discord as arguments, never echoed by the response; do not include secrets. |
| `/agent sessions [query] [page]` | Searches authorized non-subagent Sessions by case-insensitive substring of ID or title; page size is 5. |
| `/agent new workspace:<alias>` | Uses the configured alias and current Native `create` contract. Title/model/effort are not accepted; non-null injected/stale values are rejected before Native `create` because no verified creation-settings contract exists. |
| `/agent bind session:<id>` / `/agent unbind` | Selects an authorized Session / removes only the selection. |
| `/agent prompt text:<instruction>` | Sends the prompt through the existing Engine operation. |
| `/agent status [run]` | Reports the owned Run state and notification state; approval status is not available through the current Native contract. |
| `/agent tasks [state] [page]` | Lists only Runs owned by the invoking user and exact Guild/Channel, in currently allowed Sessions; page size is 5. |
| `/agent result [run] [page]` | Calls the Engine's correlated result-page service; it never substitutes another Run's output. |
| `/agent notify run:<id>` | Compatibility alias for notification retry; does not resubmit a prompt. Unknown legacy delivery is refused. |
| `/agent notifications show` | Shows the destination and authorized User/Guild/Channel/Binding scope, plus pending, unknown/sending, blocked, incomplete, and undelivered-part counts. Progress notifications are explicitly unsupported. |
| `/agent notifications set destination:<dm\|origin> [confirm-origin]` | Changes the future-run preference for the invoking actor+Guild+Channel only. `origin` requires an existing selected Binding and explicit confirmation; the response echoes the authorized User/Guild/Channel/Binding/version scope. Existing Runs keep their pinned destination. There is no `progress` option because progress notifications are unsupported. |
| `/agent notifications retry delivery:<id> [part] [confirm-duplicate-risk]` | Retries delivery only. The Engine enforces next-unsent-part order and requires explicit duplicate-risk confirmation for an unknown part. It does not call Native prompt. |
| `/agent diagnose` | Performs an authorized Session-list connectivity check and reports only public adapter-method availability plus safe error codes; it does not expose tokens, paths, raw errors, or secret settings. |

All operations are authorized against the configured user, Guild, and Channel even though this command is guild-only. Session list/current reads are limited to permitted Workspace Sessions. History is unregistered and fails closed. Run listing and result access are restricted to the exact initiating user/Guild/Channel. Session IDs and Run IDs are not shortened in responses.

## Explicitly unavailable

The verified installed Native Session seam used by the adapter has `list`, `create`, `projections`, `page`, and `prompt`. It does not provide verified model catalog, Session model/reasoning read/write, context usage, title update, approval, stop, queue, artifact/file, or normal-chat contracts. `/agent models`, `/agent model`, `/agent reasoning`, `/agent context`, and `/agent settings` therefore are not registered; help explains why. The DSH installed-checkout path supplied during implementation was not present, so no extra upstream contracts were inferred from it. Capabilities not proven by the adapter are shown as unavailable/unknown, not guessed from arbitrary projection fields.

**History unavailable:** the supported Native `page(request, signal)` uses `{address:{kind:"session",sessionId},throughSeq,maxMessages,beforeSeq?}` and returns `{records:[{type:"event",event:{type,seq,time,data,surfaceOp}}],hasMore}`; no verified event-type or field filter exists. Fetching full page records and filtering afterward would violate §23.2's no-private-field-fetch requirement. Therefore `/agent history` is unregistered; a stale/injected invocation is rejected before snapshot/page/events/history calls. This does not disable the existing Engine event correlation or `/agent result` recovery/output paging.

All C-priority commands remain unregistered and disabled: `context compact`, `stop`, `approval`, `queue`, `files`, and `chat enable/disable`. Telegram code and command behavior remain unchanged.

## DM-only mode: design/proof checklist only

No slash commands, message listener, authentication route, or live mutation enable DM operation. Completion DMs from existing notifications do not imply that DM interaction is supported.

- Define distinct tagged conversation identities, never a Guild-shaped key with null/zero IDs:
  - `DiscordGuildConversationKey = (transport=discord, kind=guild, botId, guildId, channelId, threadId | null)`
  - `DiscordDmConversationKey = (transport=discord, kind=dm, botId, userId, dmChannelId)`
- A future GUI must explicitly select `DM-only`, `server-only`, or `both`. Existing settings must not auto-migrate. DM-only setup still requires verified Bot/Application identity, the explicitly allowed User ID, Workspace authorization, and Native Session authorization; absence of Guild IDs never means allow-all.
- Verify official Discord User Install and global-command `integration_types`, `contexts` including `BOT_DM`, Gateway receive behavior, and authorized follow-up DMs. Guild registration or legacy `dm_permission` is not proof. No external HTTP endpoint or alternate receiver may be silently introduced.
- Validate Bot identity, real interaction context, `user.id`, and a true 1:1 DM channel/recipient on each operation. Reject non-owner Users, Bot/Webhook actors, group DMs, fake contexts, and forged/stale components with zero side effects. Never auto-promote the first DM sender.
- Preserve one active Binding per conversation and Native Session uniqueness: a Native Session cannot be bound to a Guild and DM simultaneously. Explicitly unbind before switching; never move existing Runs, their actor/session/destination, approvals, or outbox records.
- Keep ordinary DM messages inert. Initial operation, if proven, is slash-command-only. Any later explicit chat enable must apply only to new messages and cannot bypass approval, sandbox, or busy checks.
- Keep DM-only disabled until the actual install → command display → Gateway interaction → Native Session operation → long-running completion delivery flow has been verified on real Discord, including restart/reconnect and non-owner/group-DM denial. No live proof is claimed by this implementation.
