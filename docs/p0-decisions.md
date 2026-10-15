# P0 decisions

Use the supported Host/Client plugin bundle; do not modify the installed application or depend on extracted implementation files. Internal observations are not stable public API guarantees. Prioritize Discord; preserve existing Telegram code and regression tests.

Preserve exact Native Session IDs and per-run pinned destinations. Authorization is explicit and fail-closed. Ambiguous admission or delivery remains unknown and is never silently replayed.

Protected storage uses Windows CurrentUser DPAPI plus private-path checks. No plaintext fallback or weakened filesystem checks. DPAPI does not establish per-process identity against other processes of the same OS user.

Full-spec release remains gated on shared Desktop/connector atomic admission and stable Native receipt, upstream trusted owner/bootstrap and caller-bound authorization, targeted Run cancellation and verified approval/event contracts. Do not substitute a plugin mutex, Cookie identity or Session cancellation.

The restricted profile is not full-spec acceptance. History/model/settings/context contracts, DM-only mode, configuration C, OUT08 full retention and live acceptance remain gaps. See [specification](<../specification.md>) and [verification](<integration-verification.md>).
