# Receipt reconciliation and provider cancellation

`PagingProviderJobs` executes the Pushover receipt and cancellation intents from
page delivery. Both hosts use the same handler and channel factory; host routing
persistence and scheduler registration follow in subsequent parts.

A delivery freezes its opaque secret reference alongside its contact and channel.
Cancellation never looks up a replacement contact or a different account. The
job payload approves only that reference, and the host secret adapter checks the
persisted job claim before releasing credentials. Older pre-activation delivery
records parse with a null reference and cannot authorize provider I/O. There is
no fallback to another secret, account or workspace.

Each receipt job binds an attempt, receipt and approved secret reference. The
send handler writes it atomically with either accepted attempt storage or safe
late-result audit evidence. Recovery may already have classified that attempt as
unknown; reconciliation retains that history. Caller-supplied lease payloads
cannot replace the persisted receipt or secret authority.

Provider I/O runs outside transactions. After inspecting a receipt, the handler
locks the page and rechecks the live claim. Only the authenticated Pushover adapter
can report acknowledgement; it verifies the configured individual recipient.
Token acknowledgement and provider acknowledgement share one transaction helper
for first ownership, remaining-work cancellation and audit. A revoked claim or a
response arriving after another acknowledgement cannot take ownership again.

Pending polls use the job-only wait result until the acknowledgement grant's
absolute expiry (24 hours by default, at most seven days). Superseding a ladder
step stops its provider retries but keeps its receipt available for acknowledgement.
Provider retry expiry completes the receipt job, since Pushover no longer prompts
for acknowledgement; the page stays open and its token link remains valid.
Both pending polls and uncertain retries wait at least five seconds before
another request. Retries use bounded exponential jitter and the
runner's failure budget. These bounds follow the [Pushover receipts API](https://pushover.net/api/receipts),
which keeps receipt status available for up to a week. The acknowledgement deadline
is rechecked after I/O before ownership can change. Cancellation retries are idempotent by delivery tag,
including the additional intents created after late provider acceptance.
Persisted later escalation steps keep an older delivery superseded even if the
database clock moves backward before cancellation executes.

## Activation and verification

Register receipt/cancellation handlers in a separate provider-job polling lane,
filtered by kind. Keep their network calls off the pure escalation deadline lane.
Use the shared `createPagingChannels` factory with the host secret adapter and
`PublicHttpsChannelTransport`; do not replace validated egress with raw fetch.
Dashboard secret activation depends on integration of the separate broker stack.

Run `pnpm --dir apps/escalator --filter @bitsentry-escalator/features test` for
in-memory recovery, expiry, claim-fence, frozen-secret and acknowledgement races.
These fixtures do not send live notifications. PostgreSQL, live-provider,
Docker and Encore execution remain not runtime-verified. The final paging
scenario part registers the remaining end-to-end scenarios for both adapters.
