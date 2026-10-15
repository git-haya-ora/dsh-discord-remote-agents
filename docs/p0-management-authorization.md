# Management authorization boundary

Management must authenticate and authorize the operator before reading or mutating settings or credentials. A shared authenticated transport identity does not prove distinct owner/admin roles. Never add an unauthenticated fallback or bypass host authentication.

The restricted single-operator management controller validates its own request envelope and operator policy. This is not a generalized official owner-role contract or proof of live GUI activation. Full-spec management remains gated on trusted upstream owner/bootstrap, delegation/revocation and caller-bound grants. Cookie, Peer identity, loopback and self-reported roles do not satisfy that requirement.

Strict DTO validation, revision checks, write-only secrets, explicit confirmation and fail-closed authorization must precede side effects. Hostile live tests remain outstanding. See [security](<../SECURITY.md>) and [specification](<../specification.md>).
