# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The Client is a surface inside the existing DSH Desktop/Web GUI, not a separate website, application root, or replacement server. The Host runs on the user's Windows PC.

## Users

People operating their own Windows PC's DSH AI agents primarily from a smartphone through Discord, and continuing the same work in the PC GUI. This audience and workflow are specified in [the specification](<specification.md#1-目的と基本方針>).

## Product Purpose

Let an authorized Discord conversation continue an exact native DSH Session and receive progress, results, native approval requests and artifacts. Success requires the specification's security, recovery and live acceptance evidence, not only passing foundation tests.

## Operating Context

- Discord-first formal Host/Client plugin delivery through the supported DSH bundle mechanism. Telegram feature development is deferred; existing regressions remain required.
- The Client displays and collects approved UI input; the Host owns credentials, Bot connections, native execution and durable state.
- Existing Native Session identity, original authorization scope and fixed Run/notification destinations must survive reconnects and restarts.

## Capabilities and Constraints

- [The specification](<specification.md>) is the normative source. Design interfaces are not claims that corresponding upstream APIs exist.
- The user explicitly approved the [restricted profile](<docs/limited-profile.md>): a single authenticated DSH GUI operator manages the plugin; this does not establish independent owner/admin grants. Shared native atomic admission and stable Run/approval/cancel remain unavailable.
- That approval supersedes the earlier static-only notice increment. The connected Client belongs in the official Plugin Manager bundle configuration slot and uses the existing DSH visual language; see the [settings surface brief](<docs/client-settings-surface.md>).
- The Client may show nonsecret Host settings, connection state and safe diagnostics. It can submit a locally entered Bot token only to the authenticated Host management boundary; credentials are never read back, logged, placed in generic configuration or persisted in the browser. Saving and starting are separate actions.
- No separate server, ASAR modification, research runtime dependency, shared DSH process termination, credential reuse or plaintext secret fallback.
- Unknown execution or notification outcomes are not automatically replayed.

## Evidence on Hand

- [Implementation status](<docs/development-status.md>) and [verification history](<docs/verification.md>) separate mock, local private-store/process fixtures and uncompleted live acceptance requirements.
- Local Run-terminal/notification atomicity is available as an [internal journal](<docs/run-outbox-journal-foundation.md>), not distributed Native/Discord atomicity.
- Client SDK source/template inspection is research evidence only. This plugin's live Client installation, rendered appearance, keyboard behavior and compatibility are not yet proven.
- No product logo, marketing proof or new visual identity has been supplied. The Client addition inherits the host's established system rather than replacing it.

## Product Principles

1. Preserve the exact native Session and original scope; never substitute a copied conversation or retarget uncertain work.
2. Fail closed at authority and capability boundaries; show what is unavailable without pretending to diagnose unseen Host state.
3. Keep credentials in protected Host storage and outside Client persistence, logs and exported source.
4. Make acceptance evidence explicit and keep unsupported requirements open.

## Open Decisions

- The official Plugin Manager bundle configuration slot is the connected settings target. Live installation, runtime compatibility, rendered/theme/keyboard/mobile verification and actual Discord/Native acceptance remain separate gates.
- Baseline semantic HTML, explicit labels, keyboard access, readable responsive content and honest destructive-action confirmation are required. This increment inherits DSH rather than introducing a separate navigation shell.
