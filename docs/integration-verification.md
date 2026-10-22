# Canonical integration verification

## Scope

This public repository is now the canonical source, tests, documentation and supported bundle development home. The integration preserves existing public Git history and releases; no private repository history, local settings, credentials, runtime data or research extracts are imported.

Canonical source lives in `src/` and `packages/discord-plugin/`. Root JavaScript, declarations, PowerShell helpers and `runtime/` remain the prebuilt GitHub-installable distribution. Builds check root/source package-contract parity and generate `MANIFEST.sha256`; `--check` rejects stale generated payloads. No install or prepare lifecycle build hook is required.

## Offline checks (2026-10-15)

- Windows Node.js 22.23.3, npm 10.9.3.
- Final frozen full regression: **204 passed, zero failures, zero skips** (267,789.8138 ms), using genuinely private Windows synthetic fixture storage. Includes native SQLite/process-crash and synthetic CurrentUser DPAPI tests, exact manual-development-script exporter acceptance, lifecycle/changed-command refusal, registry-private guard rejection and exporter source-checkout/junction boundary refusal without writes. The focused bundle/security suite also passed 10/10 with zero failures or skips.
- Build and source/distribution contract checks passed. Both manifests require `private: true`; this prevents accidental npm registry publication without blocking local/GitHub installation. Heuristic public source scan covered 157 worktree files and 124 staged changed paths. Scans withhold matching values and are not universal secret/PII proof.
- `npm audit`: zero known vulnerabilities at verification time.
- `npm pack --ignore-scripts`: 40 files, 23 inspected JavaScript modules. Archive inspection passed path safety, required runtime, relative imports, declared dependencies and known forbidden-artifact/secret patterns.
- Packed archive SHA256: `0e42a5bec27cb772dd3377754d43bd193a932dc4fe5e96ff374da280b87e8697`. Repacking after the final documentation/exporter guard changes reproduced the same archive bytes; these files are outside the packed runtime. This identifies this verification artifact, not every later rebuild or a cryptographic release signature.
- Isolated install of that archive with lifecycle scripts disabled installed 26 packages. Host entry import succeeded and exported `apply`; it was not called. No receiver, Discord command registration or live service was started.

## Publication safety and remaining gaps

Only reviewed allowlisted source, synthetic tests/examples, portable documentation, tooling and generated distribution are staged. The old private checkout retains its original remote/history and receives only a development-location redirect. Public history is not rewritten; normal reviewed branch publication is required.

This is not evidence of live DSH Plugin Manager installation, authenticated GUI rendering, Discord login/command registration, PC↔Discord round-trip, deployment, autostart or long-running recovery. No token was used, no npm registry publication performed, no installed application modified, no authentication bypass used, and no shared DSH process killed.

Full-spec acceptance remains incomplete: shared Desktop/connector atomic admission, trusted owner/bootstrap and caller-bound authorization, filtered Session history, Session-only model/reasoning settings/reset, fresh/atomic context-meter provenance, DM-only mode, exact-Run cancellation, external approval/events, shared durable FIFO queue, safe file/Artifact transfer, compact integration, configuration C and full OUT08 durable full-output retention/cleanup. Read-only catalog/current model metadata, guarded no-CAS title rename, and Native actual-start notice are implemented locally but do not satisfy live acceptance. Some Native context-pressure/token-meter projections exist; without a currentness/freshness and atomic-request contract the bridge does not present them as exact current context usage. Existing Telegram implementation and regressions are preserved; live compatibility is not claimed.

Follow [canonical development](<canonical-development.md>) for future work and [restricted installation](<restricted-installation.md>) for the supported bundle installation path.
