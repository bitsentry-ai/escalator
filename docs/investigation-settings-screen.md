# Investigation settings in both hosts

Open **Investigation settings** and select a service and environment. Both hosts
render the same screen and use their own authenticated tRPC transport. The
Dashboard derives scope from current organization membership; standalone uses
the current local session. The browser never supplies a workspace identifier.

The screen displays the configured provider, model, endpoint and declared local
or remote destination. Selecting local does not bypass runtime destination
checks, and there is no automatic fallback to a remote model. New configurations
start disabled. Saving changes configures future investigation jobs; it does
not execute a model request.

Administrators can choose time, evidence and output budgets and add scoped
probe, alert, metric and deployment sources. Each selection has a bounded
lookback and result count. Existing unavailable selections remain visible until
removed; changing the catalog filter does not erase them. Log and repository
connections require explicit host bindings before they can be added.

Edits include the loaded revision. If another administrator changes the profile,
reload before retrying; the screen never silently retries an overwrite. Switching
service or environment discards the previous form, and late responses cannot
replace the new scope's configuration. Read-only users can inspect settings but
cannot submit mutations.

## Credentials

Authorized standalone administrators can store a model API key separately from
profile settings. The key field is cleared before sending the authenticated
request. Only the returned opaque credential reference is copied into settings;
keys are not included in profile payloads or browser storage. Browser strings
cannot be guaranteed securely erased from memory.

Dashboard users reference credentials from the existing secret broker. Secret-
backed activation remains dependent on integrating that separate stack; the
settings adapter denies an unapproved reference. Local Ollama can be configured
without a credential. Creating a credential alone does not activate a model.
