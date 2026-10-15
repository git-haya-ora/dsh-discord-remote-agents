# Discord Client: non-connected notice foundation

> **Historical static-only increment.** Its non-connected scope and earlier counts below are retained as evidence, not the current product boundary. The approved [restricted profile](<limited-profile.md>) replaces it with authenticated Plugin Manager settings; see the [current surface brief](<client-settings-surface.md>) and [installation runbook](<restricted-installation.md>). Offline Client fixtures still do not establish live rendering or accessibility.

## Scope and gate

The user approved a compact non-connected prerequisite panel as the first Client increment and direct code-first work inheriting the existing DSH theme. [Product context](<../PRODUCT.md>) and [surface direction](<client-notice-surface.md>) record that decision. The full GUI and real Discord/Native requirements are not reduced or completed by this panel.

The [Client entry](<../packages/discord-plugin/client.js>) contains package-authored static information, not a Host diagnostic. It does not inspect operational/plugin configuration, status, identities, grants, counters, secret references or credentials. It collects no token and provides no save/start/stop/connect operation. It uses the public Client UI locale only to choose display text; this is not a Host settings/diagnostic query. Management reads as well as writes remain unavailable until RFC-M is verified. Existing Host capabilities remain false.

## Documented Client format

The inspected DSH `0.2.0-rc.2` reference and decoration template describe:

- A `./client` package export and `dsh.client` metadata, with platform `web`, immediate activation and dependency ordering.
- `window.__ModuleLoader__.load` with a factory ID matching the package name. React comes from the baseline browser module table; no second React, CDN or private Client UI module import is used.
- An allocated `conversation.composer.dock` contribution through `ctx.slots.inject` / `ctx.slots.register`, owned by declaration and plugin lifecycle. It is session-scoped and appears only with a live conversation input, not on the home/settings navigation surface.
- Effect-owned `ctx.locale.register(namespace, {zh, en})` and `ctx.locale.bind(namespace)`; both built-in dictionaries are required. Dictionary-only `ja` registration does not add/select a language or write a preference. Japanese copy is available only with an existing Japanese language definition. `resolveText` is for manifest text, not namespace keys.
- Slot metadata `locale: namespace` enables the renderer's revision-specific translation seat. The component retains its live namespace binder, accepts no parameters and ignores all injected Session data. No custom subscription or timer is introduced.

The hand-authored browser artifact directly uses the documented lazy-factory format. Root TypeScript build, JavaScript syntax check and contract tests validate source; they are not a fabricated SDK compiler or proof of deployment. No research extract or generated dependency directory is a runtime/distribution dependency. The inspected SDK/templates are static evidence only and do not prove the currently running GUI loaded this artifact.

## Offline evidence (2026-10-14)

After the three product/test paths were frozen, the commander independently ran strict build/full suites: default TEMP **96 total / 90 passed / 0 failed / 6 private-path skips**; the accepted workspace fixture parent **96 / 96 / 0 / 0**. Existing Telegram16 regressions are preserved. Fresh synthetic fixture directories remaining: 0.

The [four Client tests](<../test/plugin-client.test.ts>) capture the lazy module, baseline-only require, service injection, effect-owned dictionaries, namespace metadata, slot collapse/reappearance/unload/reactivation and complete translation keys. AST checks cover native collapsed disclosure and absence of privileged calls/global DOM/styles/focus replacement. These tests intentionally do not execute the component or implement a fake React/DOM renderer. Source semantics do not prove actual keyboard behavior, contrast, responsiveness, locale switching or visibility.

These foundation-only test and package counts are historical, not the current integration result. See [current verification](<integration-verification.md>) for the complete regression suite, bundle inspection and dependency audit. Offline evidence does not establish live compatibility or rendering.

## Live evidence and finish disposition

Live authenticated installation and rendering remain unverified. An unauthenticated HTTP response would not establish owner authority, plugin installation or visual correctness. Use only the supported bundle installation and the existing authorized GUI; do not start an alternate server, bypass authentication, modify ASAR/profile state or restart shared processes as a shortcut.

A fresh finish reviewer returned **recapture**, reviewing evidence validity only, not visual/source quality: no real captures were supplied. Required evidence is full-viewport desktop and mobile, collapsed/expanded under host light/dark themes, native focus/keyboard behavior, and the actual user's width if available. There are no matching visual goldens or fabricated screenshots. Only the normal authorized existing GUI may supply that evidence after supported installation/compatibility checks; no automatic HMR update is promised. Source publication is not visual shipment, PL/AC success or completion of the surface's finish gate. The incumbent design system is not replaced and no raster assets are introduced.

## Still open

Formal bundle/Client installation and compatibility; settings/navigation allocation; caller-bound owner/admin authorization; protected settings/token flows; actual Host status and receiver lifecycle; real Discord sending and Native admission/events/Approval/stop; payload producer, retention and migration; live PC↔Discord↔PC and long-duration acceptance tests.
