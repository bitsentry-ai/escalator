# Dokploy

Use Escalator's gate before the provider trigger in the trusted release job. Dokploy documents [programmatic deployment](https://docs.dokploy.com/docs/core/auto-deploy), [application deployment requests](https://docs.dokploy.com/docs/api/application) and [deployment lookup](https://docs.dokploy.com/docs/api/deployment). Its generic notification webhook is an outbound notification mechanism, not a blocking coverage check.

Complete the [common configuration](README.md), using `ESCALATOR_SOURCE=dokploy` and a unique attempt ID. Configure the intended application with the immutable release before beginning. Supply the trusted API base ending in `/api`, the application ID and an API key through the runner's configuration/secret mechanism. The provider API key is separate from the Escalator grant.

```sh
set -eu
umask 077
node ./ops/escalator/hook.mjs begin
jq -cn --arg id "$DOKPLOY_APPLICATION_ID" '{applicationId:$id}' \
  > "$(dirname "$ESCALATOR_STATE")/dokploy-trigger-input.json"
curl --fail --silent --show-error --max-time 30 --request POST \
  --header "x-api-key: $DOKPLOY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data-binary "@$(dirname "$ESCALATOR_STATE")/dokploy-trigger-input.json" \
  --output "$(dirname "$ESCALATOR_STATE")/dokploy-trigger.json" \
  "$DOKPLOY_API/application.deploy"
```

No provider request is sent when the preceding Escalator command fails. Disable parallel automatic deployment paths for releases that require this gate. Do not retry an ambiguous provider trigger without reconciling its result; Escalator's idempotency keys do not make Dokploy's API idempotent.

## Confirm completion

Record the actual provider deployment ID and bind it to the application, attempt and immutable release. The application deployment inventory can assist reconciliation:

```sh
curl --fail --silent --show-error --max-time 15 --get \
  --header "x-api-key: $DOKPLOY_API_KEY" \
  --data-urlencode "applicationId=$DOKPLOY_APPLICATION_ID" \
  --output "$(dirname "$ESCALATOR_STATE")/dokploy-deployments.json" \
  "$DOKPLOY_API/deployment.all"
```

Inspect the exact deployment in Dokploy, confirm that it belongs to the intended release and verify its terminal result and configured health checks. After confirmed success:

```sh
node ./ops/escalator/hook.mjs finish SUCCEEDED
```

Use `FAILED` or `CANCELLED` only for a confirmed terminal result. Unknown outcomes stay open for timeout paging. Never choose the newest successful deployment from a list: another actor may have deployed concurrently. The generic API reference does not specify a complete deployment response schema; a CI completion adapter must validate the installed version's deployment ID/status mapping with the manual procedure before automating this confirmation. The trigger response alone is insufficient.

## Manual check, not runtime-verified

Run the common cases and record the installed Dokploy version, response schema and provider deployment identity. Confirm the preflight stops the trigger when nobody else covers the environment. Trigger a successful release, a failed release and a cancellation, then verify each finish refers to the exact attempt. Test a lost trigger response and an unrelated concurrent deployment; keep the Escalator deployment unconfirmed if identity cannot be established. No provider deployment was executed for this recipe.
