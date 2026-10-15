# Canonical development

This repository owns source, tests and the installable GitHub bundle. Continue future development here, not in the former private checkout. Open this repository folder in your editor/DSH workspace; no workspace-switching API is assumed. No private Git history was imported.

## Ownership

- Edit TypeScript in `src/` and plugin implementation in `packages/discord-plugin/`.
- Edit tests in `test/`, build tooling in `scripts/`, validation/export tools in `tools/`.
- Root plugin JavaScript, declarations, patch, PowerShell helpers and `runtime/` are generated mirrors. Never hand-edit them. `npm run build` regenerates them from canonical sources and checks package-contract parity. Before committing, run `node scripts/sync-distribution.mjs --check` to reject stale mirrors or inventory drift without overwriting authored changes.
- Root `package.json` owns development commands. Its supported install contract must match `packages/discord-plugin/package.json`; the build rejects divergence. Only explicitly allowlisted non-lifecycle development scripts are accepted by bundle verification. No install/prepare hooks run source builds.
- `MANIFEST.sha256` covers the generated installation payload; it is not a signature.

## Commands

Use Node.js 22.23.0 or newer. Run `npm ci --ignore-scripts`, `npm test`, `npm run verify:source`, then `npm pack --ignore-scripts`. On Windows, configure `DSH_DISCORD_TEST_PRIVATE_PARENT` to a genuinely private test-fixture directory when necessary; do not loosen production path checks. Require zero skipped native tests before claiming complete Windows test evidence.

Review generated diffs and use `node tools/verify-bundle.mjs` for bundle inspection. The standalone exporter `node tools/export-github-bundle.mjs <bundle.tgz> <new-output-directory>` creates a disposable distribution-only artifact. Destination must not exist; never export into this checkout or another canonical source tree. It is not a migration command.

GitHub installation continues to use the root prebuilt bundle. The npm `files` allowlist excludes development source and tests from the archive. Both manifests set `private: true` and omit `publishConfig` to block accidental npm registry publication while retaining local archive/GitHub installation. Build and source verification enforce that policy. Registry publication, live command registration and DSH deployment require separate authorization.

Before publishing: inspect staged paths/diff, run `node tools/verify-public-source.mjs --staged`, audit dependencies, inspect the archive, and verify the pushed branch SHA. Heuristic secret scans are not universal proof. Never publish real settings, tokens, databases, backups, logs, transcripts or extracted research.

## Remaining constraints

See [verification](<integration-verification.md>), [security](<../SECURITY.md>) and [specification](<../specification.md>). Mock/regression success is not live Discord/DSH acceptance.
