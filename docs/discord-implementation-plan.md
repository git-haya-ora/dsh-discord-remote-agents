# Discord implementation plan

This repository is the canonical development home. See [development](<canonical-development.md>) and [specification](<../specification.md>).

Prioritize Discord. Preserve Telegram regression coverage without expanding its feature set. Implement against supported plugin contracts only; internal observations are not stable public APIs.

Keep native Session identity, pinned destinations, explicit authorization and unknown/no-replay behavior. History, model/settings/context operations, DM-only mode and configuration C remain incomplete until supported Native contracts exist. OUT08 complete retention and live acceptance checks remain open.

Use synthetic fixtures. Never commit local runtime metadata, session transcripts, credentials or research extracts. Current verification belongs in [integration verification](<integration-verification.md>), not private development chronology.
