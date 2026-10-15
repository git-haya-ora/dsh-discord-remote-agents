# Plugin foundation

The installable root preserves the supported DSH bundle metadata, Host ESM exports, Client export and Cordis patch. Source ownership and generated distribution rules are in [canonical development](<canonical-development.md>).

Host resources must use effect-owned lifecycle cleanup. Client resources use scoped registration and cleanup. Do not infer trusted operator identity from an arbitrary client message. Existing authenticated host transport is not a generalized owner/admin authorization contract.

No research extract is a runtime dependency. Do not patch the installed application, invent Native APIs, or introduce a private unauthenticated management server. Build/import success is not proof of Plugin Manager activation or live rendering. Follow [restricted installation](<restricted-installation.md>).
