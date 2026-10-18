# Services in both hosts

The standalone account shell and Dashboard `/escalator` page mount the same compiled Services screen. Their authenticated tRPC adapters invoke the shared list/create/get use cases. Only administrators can create services; every successful creation writes an audit event in the same transaction. Reads use the authenticated workspace and return not-found for another workspace's ID.

## Standalone

Follow `authentication.md` to configure the local database, mounted keyring, public origin and operator bootstrap credential. Apply migrations before deployment. After signing in, Services appears alongside account security. A service has a name, stable key and owning team. Duplicate keys are rejected within the workspace.

## Dashboard rollout

`ESCALATOR_ENABLED_ORGANIZATIONS` is a comma-separated list of exact WorkOS organization IDs. It defaults to empty (disabled); wildcards, malformed entries and lists exceeding 100 entries fail configuration. Enable one internal organization before pilot organizations. Restart the backend to change the list. Both navigation and API availability follow the backend allowlist; browser-supplied tenant or permission fields cannot enable access.

The existing WorkOS session must include its organization and a supported organization role. Identity mapping verifies the existing local user's WorkOS linkage and creates only scoped Escalator records. Ambiguous legacy ownership remains unlinked. Apply the additive Escalator migration before enabling an organization.

The Dashboard secret adapter targets the separately reviewed `secret-store/*` broker stack. Secret-backed features must not be activated until that stack is integrated and the broker authorization adapter is composed. There is no fallback to legacy plaintext credentials. Services does not read secrets and can be evaluated independently.

## Background lifetime

Both hosts register their PostgreSQL scheduler wrappers with application bootstrap and shutdown. Phase 1 has no job handlers; empty registries perform no database claims. Later phases register deadline and delivery handlers in these composition roots. Each queue has its own bounded poll loop; shutdown awaits active attempts before exit. Database leases remain the recovery authority.

Once paging is enabled, removing an organization or stopping dispatch is **not** a safe rollback by itself. Drain, explicitly cancel, or hand off pending pages and notify operators before disabling it. Do not delete durable rows to bypass delivery.
