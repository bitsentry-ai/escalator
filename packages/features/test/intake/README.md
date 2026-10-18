# Intake fixtures

`sentry-issue-alert.json` retains only the event identity, observation time and
severity fields from Sentry's published issue-alert example:
https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/

Retrieved on 2026-10-02 from the corresponding official source:
https://github.com/getsentry/sentry-docs/blob/master/docs/integrations/integration-platform/webhooks/issue-alerts.mdx

The fixture is a documentation sample, not a captured production webhook. Tests
add synthetic secret-bearing fields to verify they are not retained. Signature
fixtures use a test-only secret and verify original bytes, including whitespace.
Live Sentry delivery is not runtime-verified.

Sentry's documented HMAC authenticates the body. Its request/timestamp headers
are not included in that MAC; they must not be treated as authenticated event
identity or a cryptographic replay window. The signed event ID supplies durable
idempotency. Issue alerts are active-only and require manual source recovery.

Native GlitchTip alert payloads differ from Sentry's: they contain attachments
but no signed event ID or occurrence timestamp. They must have their own adapter
and authenticated host binding, not be passed to the Sentry parser.

The native GlitchTip synthetic fixture follows `send_issues_as_webhook` in the
official backend source inspected on 2026-10-02:
https://gitlab.com/glitchtip/glitchtip-backend/-/blob/master/apps/alerts/webhooks.py

It is deliberately labeled synthetic: a live notification has not been captured
in this environment. The normalizer requires a host-assigned durable receipt ID
and database receipt time. Identical payloads from later receipts must be
allowed to produce a new observation; permanently hashing the whole payload as
an event ID would suppress future incidents. The host receipt/authentication
binding is a separate required part before this adapter can be activated.

Grafana tests use a synthetic reduced payload based on the default documented
notification format, including mixed per-alert states and the zero `endsAt`
sentinel for firing alerts:
https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/

The signature verifier requires a configured timestamp header and authenticates
`timestamp + ':' + raw body`, with a five-minute clock tolerance. A host may
instead authenticate an explicitly configured scoped bearer grant. Truncated or
empty batches are rejected; missing alerts never mean recovery. Per-alert
fingerprint and occurrence start distinguish later occurrences from retries.
Annotations, arbitrary labels and embedded URLs are not retained. Live Grafana
delivery is not runtime-verified; host wiring remains required.
