# Email paging submission

The email channel uses authenticated SMTP submission to a public DNS hostname on port 465 with implicit TLS. Both hosts use the same adapter. There is no cleartext, STARTTLS downgrade, unauthenticated relay, private-network relay, proxy, OAuth or custom-certificate mode in this first adapter. Choose a provider supporting authenticated TLS submission on 465.

Store one opaque credential reference per delivery contact. The encrypted JSON contains `host`, `port` (465), `username`, `password`, `from` and `to`. Sender and recipient are single ASCII mailboxes without display names or recipient lists. Use the local write-only credential form, or the separate Dashboard secret broker after its integration. These values never enter incident records, outbox payloads or audit events.

The adapter validates every DNS result, rejects special/private ranges and pins one public address. Certificate verification and SNI still use the original hostname. It owns and destroys the socket when the total ten-second budget expires or a persisted claim is cancelled. Nodemailer's transport close method alone is insufficient to cancel an active SMTP connection. Connections are not pooled.

Only plain text is sent: incident message followed by the acknowledgement URL. File/URL content access and SMTP logging are disabled. One fixed envelope recipient prevents header expansion. A workspace-and-delivery hash forms a stable Message-ID; this is not an SMTP deduplication guarantee. Explicit 4xx refusals retry, 5xx refusals are permanent, and interrupted or unrecognized results remain unknown and may be retried. A lost reply can therefore result in duplicate mail. Successful submission means the SMTP server accepted it, not that it reached an inbox or that anyone acknowledged the incident.

## Dependency decision

Nodemailer 10.0.13 owns MIME encoding and SMTP authentication/protocol handling. It requires Node 20 or newer, includes TypeScript declarations and has no production dependencies. The standalone feature workspace owns the dependency. Worker staging already uses production `pnpm deploy` to carry its dependency closure; no compiled output is committed. See [SMTP options](https://nodemailer.com/smtp) and [the pinned transport source](https://github.com/nodemailer/nodemailer/blob/v10.0.13/src/smtp-transport/index.ts).
