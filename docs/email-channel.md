# Email paging submission

The email channel uses authenticated SMTP submission to a public DNS hostname on port 465 with implicit TLS. Both hosts use the same adapter. There is no cleartext, STARTTLS downgrade, unauthenticated relay, private-network relay, proxy, OAuth or custom-certificate mode in this first adapter. Choose a provider supporting authenticated TLS submission on 465.

Store one opaque credential reference per delivery contact. The encrypted JSON contains `host`, `port` (465), `username`, `password`, `from` and `to`. Sender and recipient are single ASCII mailboxes without display names or recipient lists. Use the local write-only credential form, or the separate Dashboard secret broker after its integration. These values never enter incident records, outbox payloads or audit events.

The adapter validates every DNS result, rejects special/private ranges and pins one public address. Certificate verification and SNI still use the original hostname. It owns and destroys the socket when the total ten-second budget expires or a persisted claim is cancelled. Nodemailer's transport close method alone is insufficient to cancel an active SMTP connection. Connections are not pooled.

Only plain text is sent: incident message followed by the acknowledgement URL. File/URL content access and SMTP logging are disabled. One fixed envelope recipient prevents header expansion. A workspace-and-delivery hash forms a stable Message-ID; this is not an SMTP deduplication guarantee. Explicit 4xx refusals retry, 5xx refusals are permanent, and interrupted or unrecognized results remain unknown and may be retried. A lost reply can therefore result in duplicate mail. Successful submission means the SMTP server accepted it, not that it reached an inbox or that anyone acknowledged the incident.

## Dependency decision

Nodemailer 10.0.13 owns MIME encoding and SMTP authentication/protocol handling. It requires Node 20 or newer, includes TypeScript declarations and has no production dependencies. The standalone feature workspace owns the dependency. Worker staging already uses production `pnpm deploy` to carry its dependency closure; no compiled output is committed. See [SMTP options](https://nodemailer.com/smtp) and [the pinned transport source](https://github.com/nodemailer/nodemailer/blob/v10.0.13/src/smtp-transport/index.ts).

## Verified package staging

`pnpm --filter @bitsentry/worker run build:escalator-package` and `pnpm --filter @bitsentry/worker exec tsc --noEmit -p tsconfig.escalator.json` passed with the SMTP dependency. CJS and ESM import assertions also confirmed Nodemailer resolves inside the staged package’s own production dependency tree. This verifies package staging, not an Encore image build.

## Verification procedure

Unit tests use injected resolvers, sockets, mailer and secret store; they do not open a listener or contact a mail provider. In a separately authorized runtime environment:

1. Configure a dedicated provider account and recipient with verified sender permission, then store credentials through the host's secret adapter.
2. Create an email paging contact and trigger a disposable incident. Check receipt in the mailbox and verify that submission alone does not acknowledge the incident.
3. Follow the acknowledgement link and verify the normal incident acknowledgement and cancellation behavior.
4. Repeat with invalid credentials, invalid sender, a refused recipient, a stalled server and a connection dropped after DATA. Confirm bounded work, redacted results, and the documented unknown/duplicate semantics.
5. Revoke the running delivery lease and check the underlying connection closes before another send can complete.
6. Repeat in the Dashboard once the separate broker stack is integrated. Build the Encore image in an equipped environment and verify the compiled channels export resolves Nodemailer there.

Live SMTP delivery, TLS handshake against a real provider, image execution and Dashboard broker activation are not runtime-verified in this implementation environment.
