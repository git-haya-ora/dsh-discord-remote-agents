# Security boundary

This is an experimental Windows-only DSH plugin, not a security sandbox. Installed Host code runs with the DSH user's permissions. Install only a revision you have reviewed. The authenticated GUI operator can manage this bridge; independent owner/admin roles are not provided.

- Never submit tokens, cookies, databases, local configuration, protected-secret blobs, logs containing conversation text, or screenshots of secrets to GitHub Issues or this repository.
- Rotate any token exposed in chat or an issue. Enter fresh tokens only in the local password field. A blank token on save retains the saved token; confirmed deletion is a separate action.
- CurrentUser DPAPI protects the Bot credential at rest. Unsafe storage ACLs, reparse points, unsupported schemas and prohibited PowerShell logging policy fail closed. Do not weaken those checks. Same-user/admin compromise is outside this protection boundary.
- Allowlist user, guild, channel/thread and exact workspace destinations. Workspace allowlists are not OS isolation. Native history remains governed by DSH, not encrypted by this plugin.
- Do not use concurrent Desktop/Discord submission or run a second receiver. Stable native Run receipts and shared atomic acceptance are unavailable in the inspected DSH build.
- Unknown prompts and ambiguous notifications are held without automatic replay. Never delete the metadata database to force a retry. Preserve the metadata and protected secrets together when doing offline backup or recovery; do not publish either.
- Approval, Run-target cancellation, attachments and artifacts remain unavailable through this bridge.

For a suspected vulnerability, do not post exploitation details or confidential material publicly. Use a private reporting channel where available. This repository does not promise an emergency response SLA. Actual DSH installation, GUI behavior, live Discord operation and long-running deployment acceptance are not yet verified.
