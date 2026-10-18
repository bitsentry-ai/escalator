# Additional notification channels

Both hosts use the shared paging channel factory and the existing durable outbox.
This change enables ntfy, Slack and Discord after Pushover and generic webhook.
Email follows separately. The shared contact editor exposes these three channels;
the standalone write-only credential form accepts their encrypted credentials.
Dashboard credentials continue through the separately integrated broker, using
opaque IDs and its existing metadata picker.

| Channel | Encrypted credential fields            | Supported destination                                               |
| ------- | -------------------------------------- | ------------------------------------------------------------------- |
| ntfy    | `url`, `topic`, optional `bearerToken` | Root URL of a public HTTPS server on port 443                       |
| Slack   | `url`                                  | Standard incoming webhook under `https://hooks.slack.com/services/` |
| Discord | `url`                                  | Standard `discord.com/api/webhooks/` or `api/v10/webhooks/` URL     |

URLs cannot contain embedded user information, fragments or query parameters.
The existing transport pins public DNS addresses, verifies TLS and rejects
redirects. Internal-only ntfy servers and alternate Slack/Discord deployments
are outside these adapters' current destination contract. Do not use public ntfy
topics for incident details; protect the topic with provider access controls.

Provider acceptance does not acknowledge an incident. Each notification includes
the existing transient acknowledgement link; the normal acknowledgement screen
and atomic grant consumption remain authoritative. The ntfy action opens a view;
Discord waits for a created-message response. Slack incident content uses plain
text blocks; Discord suppresses automatic mentions. Provider text is bounded
without splitting Unicode characters.

Explicit HTTP client errors are rejected, with rate limits retryable. Timeout,
redirect, server failure, malformed success response or lost secret/lease after
sending stays unknown. Retries use the existing durable delivery contract and
may duplicate a message after uncertain provider acceptance. These providers do
not supply the Pushover emergency receipt/cancellation semantics.

No response body, webhook credential, bearer token or acknowledgement URL enters
an adapter result or audit record. Fixtures follow the documented protocol and
are synthetic; no live provider request was sent. To verify deployment delivery,
configure a disposable provider destination, an encrypted credential and a test
contact through the relevant host, then follow the paging scenario procedure.
Check provider acceptance, acknowledgement, retries and redacted stored attempts.
Live delivery, PostgreSQL behavior and Dashboard broker activation remain not
runtime-verified here.

Protocol references:

- [ntfy JSON publishing](https://docs.ntfy.sh/publish/#publish-as-json)
- [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
- [Discord webhook execution](https://docs.discord.com/developers/resources/webhook#execute-webhook)
