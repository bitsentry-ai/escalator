# Coolify

Put Escalator's gate in the release job before calling Coolify's authenticated deploy webhook. Coolify documents this [GitHub Actions trigger pattern](https://coolify.io/docs/applications/sources/github/actions). Build/publish the immutable image first, and configure that image on the intended application. The webhook response only starts/queues deployment; it does not prove completion.

Complete the [common configuration](README.md), using `ESCALATOR_SOURCE=coolify`, a unique CI attempt ID, the exact environment and immutable release reference. Store `COOLIFY_WEBHOOK` and `COOLIFY_TOKEN` separately from the Escalator grant in the runner's secret mechanism. Copy the authenticated webhook URL from the intended application.

```sh
set -eu
umask 077
node ./ops/escalator/hook.mjs begin
curl --fail --silent --show-error --max-time 30 --request POST \
  --header "Authorization: Bearer $COOLIFY_TOKEN" \
  --output "$(dirname "$ESCALATOR_STATE")/coolify-trigger.json" \
  "$COOLIFY_WEBHOOK"
```

Do not automatically retry the provider trigger after an ambiguous network failure: its idempotency contract differs from Escalator's. Reconcile whether Coolify queued the deployment first. Disable parallel automatic deployment paths for a release that is meant to be coverage-gated; a notification emitted after deployment starts cannot enforce preflight.

## Confirm completion

Record the specific provider deployment UUID returned by the trigger (or reconcile it in Coolify after an ambiguous response). The [deployment lookup API](https://coolify.io/docs/api/endpoints/deployments/get-deployment-by-uuid) exposes the deployment UUID, commit and status:

```sh
# COOLIFY_API is the trusted instance base ending in /api/v1.
# COOLIFY_DEPLOYMENT_UUID is the exact recorded provider deployment, not "latest".
curl --fail --silent --show-error --max-time 15 \
  --header "Authorization: Bearer $COOLIFY_TOKEN" \
  --output "$(dirname "$ESCALATOR_STATE")/coolify-status.json" \
  "$COOLIFY_API/deployments/$COOLIFY_DEPLOYMENT_UUID"
```

Before reporting a finish, verify that the record is for the intended application and immutable release, and that the installed Coolify version reports a terminal successful result. Also check the release's configured health result. Never convert HTTP 200, a queue receipt, an older successful deployment or an unknown status into success.

After that confirmation:

```sh
node ./ops/escalator/hook.mjs finish SUCCEEDED
```

For an independently confirmed terminal failure/cancellation, use `FAILED`/`CANCELLED`. If the result is uncertain, preserve the state and leave the deployment open for timeout paging. A CI completion adapter must bind the exact provider UUID and use status values verified against its installed Coolify version; the generic lookup reference defines `status` as a string rather than a closed enum. This recipe intentionally requires that provider-specific terminal verification instead of embedding an unverified enum or treating queue acceptance as completion.

## Manual check, not runtime-verified

Run the common cases and record the Coolify version and actual response shapes. Confirm blocked coverage prevents the webhook call. Queue a deploy and verify no finish is recorded until the same UUID/release reaches the confirmed terminal result. Exercise failure, cancellation, a lost trigger response and an unrelated concurrent deploy; none may select the newest successful record as a substitute. Verify finish retries retain the original state. These provider calls were not executed during implementation.
