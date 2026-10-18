# Retention settings and historical coverage

Both hosts expose the same Retention and coverage screen. Administrators may change the replay policy; readers can inspect effective settings and historical evidence. Updates use the loaded policy version, so a concurrent edit requires a refresh. Limits come from the deployment, never from the request. The default is 30 days and 5 GiB of replay payloads; this is not a total PostgreSQL disk quota, and protected operational records can exceed the target.

Standalone application procedures are `retention.get`, `retention.update`, and `retention.coverage`. Dashboard procedures are `getRetention`, `updateRetention`, and `replayCoverage` on the existing Escalator tRPC router. Both derive the actor from authenticated host identity and reject request-supplied workspace identifiers. Dashboard settings and historical reads are available to enrolled organizations independently of broker activation; background monitoring still requires the separately integrated broker.

Coverage accepts a signal source, probe or metric monitor, a half-open window of at most 31 days, and an evidence cutoff. The UI uses local date/time inputs and displays the browser time zone; responses include UTC snapshot and gap timestamps. Receipts unavailable at the cutoff cannot establish coverage. Missing, disabled, late, retrospective, unusable and unknown evidence stay distinct. Event counts never imply uninterrupted monitoring. An empty expected-sample count does not establish health.

Readers enforce the existing 10,000-configuration and 100,000-receipt query bounds. A truncated query reports incomplete coverage; choose a smaller window. The screen paginates stream choices and renders at most 100 gaps per page. Changing the selection or window clears the old report.

Settings and coverage share maintenance's single admission slot and dedicated pool. Busy requests return `TOO_MANY_REQUESTS` and can be retried; they do not accumulate behind a long query or occupy every paging connection. Database details are not exposed in capacity or invalid-window errors.

The maintenance lane uses one slot within the existing 64-job-worker ceiling. Defaults fit; custom probe/metric concurrency already at that ceiling must decrease by one. See [durable retention maintenance](durable-retention-maintenance.md) for migration order, restart behavior, transaction timing limits and the outstanding PostgreSQL/load procedures. No application, database or browser session was started to verify this screen; builds and unit tests are the available checks here.
