# Monitoring credential selection and stored probe status

Both hosts show named credential metadata in the probe editor. Administrators can page the list, refresh it, or keep an existing opaque reference that is not currently visible. Readers do not fetch credential metadata. A failed or unavailable metadata request does not silently remove an existing reference.

The picker lists all authorized metadata; it cannot inspect encrypted values or infer their format from names. Choose a credential created for HTTP probe headers. Metrics and inbound signing formats are distinct. The server still validates authorization and credential format when using a reference.

Standalone administrators can create a write-only HTTP credential using the existing encrypted store. Creation is separate from saving a probe. Successful creation selects the returned reference, but the probe must still be saved explicitly. Values are cleared after success or a changed client/type and are not persisted by the browser. A failed response can have uncertain commit status; refresh the list before retrying.

Dashboard offers metadata selection through the existing organization-authorized binding. It has no local secret writer. Provisioning and activation remain dependent on the separate broker integration, including explicit organization ownership and adapter-compatible bundle formats.

Probe inspection follows the persisted state's observation ID rather than history ordering. The view shows observation time, outcome, reason and configuration version. An old-version observation is explicitly marked; an inactive failure flag does not claim current health. Refresh requests a new stored snapshot, not a network probe. History remains paginated by record ID.

Unit checks cover transport procedures, read-only rendering, password-field bounds, unavailable creation and escaping. Build checks cover both hosts and six locale bundles. No running browser, database or provider was used. In an authorized disposable environment, verify reader/admin navigation, create/select/save, pagination, failed metadata requests, changed organization during a pending request, and a configuration edit before the next probe result. Confirm no secret values appear in response payloads, local storage or diagnostics.
