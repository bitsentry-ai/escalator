# Capacity verification

Status: not runtime-verified. No supported production envelope or latency result
is claimed. The initial reference workload is a target to measure, not a sizing
guarantee: 100 one-minute probes, 20 simultaneously active incidents and two
investigations. Measure both hosts separately; Dashboard results must include its
backend and Encore worker, and cannot be inferred from standalone results.

## Record the deployment

Record commit/image digest, schema/contract versions, CPU and memory limits,
PostgreSQL version/resources/storage, replica counts, configured job/provider/model
concurrency, connection-pool sizes, tick intervals, network latency and provider
simulator behavior. Include automatic retries, backtests, rule evaluation and
retention work in the configuration. Do not copy secrets into the evidence bundle.

Use a disposable authorized deployment with test recipients and independent
watchdog monitoring. Do not benchmark a live on-call workspace or rely on actual
SMS/push recipients for load generation. Preserve scheduler lease and rate limits;
increasing them to make the benchmark pass changes the envelope under test.

## Workloads

1. Warm up until every scheduler lane has made progress, then collect an idle
   baseline for CPU, resident memory, event-loop delay, database size and queue lag.
2. Configure 100 one-minute probes with ordinary staggered scheduling. Sustain
   20 active incidents and two bounded investigations. Collect steady-state
   evidence for at least one hour after warmup, with exact attempt/sample counts.
3. Repeat with a burst of simultaneously due probes/incidents, a slow or unavailable
   notification provider, a model timeout, replay/backtest pressure and retention
   work. Verify acknowledgement latency and paging deadlines in each case.
4. Exercise process loss after durable commit, expired worker leases and temporary
   database loss. Confirm recovery preserves intent, reports uncertainty honestly
   and does not silently drop or duplicate acknowledged escalation steps.
5. Increase one load dimension at a time only after the reference workload passes.
   Publish the last passing and first failing workload with the exact resource
   configuration; do not extrapolate from average CPU utilization.

## Timing evidence

The initial target is 95% of first dispatch attempts starting within 10 seconds
of committed incident creation, and 99% of escalation attempts within 10 seconds
of their due time. External delivery latency is a separate distribution. Include
all eligible deadlines, including work for which no attempt starts: missing or
late attempts are misses, not excluded samples. Cancellations/acknowledgements
must be independently evidenced before a due step is removed from the denominator.

Measure the incident commit boundary in the authorized harness and correlate it
with durable incident/page identifiers. A persisted creation timestamp may denote
transaction time rather than actual commit; label any timestamp-derived lag as a
proxy and do not claim it proves the commit-to-attempt target. Record clock source,
skew and monotonic elapsed times. Separate request scheduling delay, transaction
commit, dispatch-start and provider completion. Preserve uncertain provider outcomes.

Collect queue age by kind/priority, event-loop delay percentiles, process CPU and
resident memory, database table/index growth, connections and lock waits throughout
the run. Include peaks and time series, not only averages. Compare retained data
growth against configured quotas and pruning progress; a per-record size limit
is not an aggregate database-capacity bound.

## Release evidence table

| Host / scenario      | Resources  | Eligible first pages / on time | Escalations / on time | Ack latency | CPU / RSS / loop delay | DB growth  | Result               |
| -------------------- | ---------- | ------------------------------ | --------------------- | ----------- | ---------------------- | ---------- | -------------------- |
| Standalone reference | Unmeasured | Unmeasured                     | Unmeasured            | Unmeasured  | Unmeasured             | Unmeasured | Not runtime-verified |
| Dashboard reference  | Unmeasured | Unmeasured                     | Unmeasured            | Unmeasured  | Unmeasured             | Unmeasured | Not runtime-verified |

Attach sample counts, raw redacted observations, dropped samples and collection
failures. A build or typecheck is not capacity evidence. Keep the release envelope
unpublished until the required runtime measurements exist.

## Supplied measurement tools

The operator-only `scripts/capacity-process.cjs` preload records CPU deltas, RSS,
heap/external memory and event-loop delay every five seconds, at most 1,440 samples (nominally two hours). Reserve enough of that
window for warmup plus the complete one-hour steady-state measurement; otherwise
start a fresh authorized measurement run and keep the incomplete run labeled.
Use `ESCALATOR_CAPACITY_DISPOSABLE=1`, an absolute private
`ESCALATOR_CAPACITY_PROCESS_OUTPUT`, and label `standalone`, `dashboard-backend`
or `dashboard-worker`. Preload it only in the authorized disposable process; it
is not wired into ordinary startup. Give every process a unique output file.
It performs small synchronous writes, whose overhead must be included in the
measurement notes. It never overrides shutdown signals. A file without a final
record, including after a forced stop, is incomplete evidence.

The read-only snapshot script records tenant-scoped queue counts and lag plus
explicitly database-wide Escalator table sizes. It uses a separate disposable
connection variable, never the application's database URL. Snapshots span several
READ COMMITTED statements; they are diagnostics, not atomic dispatch measurements.

Run the snapshot from the standalone workspace only after privately configuring
`ESCALATOR_CAPACITY_DISPOSABLE=1`, `ESCALATOR_CAPACITY_HOST` (`standalone` or
`dashboard`), `ESCALATOR_CAPACITY_WORKSPACE_ID`,
`ESCALATOR_CAPACITY_DATABASE_URL` (restricted disposable role) and an absolute
`ESCALATOR_CAPACITY_OUTPUT` pointing to a new private file:

```sh
node scripts/capacity-snapshot.mjs
```

For process sampling, additionally set `ESCALATOR_CAPACITY_PROCESS_LABEL` and
`ESCALATOR_CAPACITY_PROCESS_OUTPUT`, then add an absolute
`--require=/path/to/scripts/capacity-process.cjs` to the authorized application's
Node options. Preserve existing options and remove the preload after measurement.
Do not set one shared output path for a parent process and its Node children;
exclusive creation will reject the second writer. The production image contains
these three diagnostics under `/app/scripts`; provide a private writable evidence
mount because the supplied application container has a read-only filesystem.

The offline `scripts/capacity-evaluate.mjs INPUT OUTPUT` accepts absolute paths to
an at-most-8-MiB JSON evidence file and a new private output file. It reports the
95% initial and 99% escalation ten-second fractions, including missing attempts
in their denominators. Empty cohorts are unknown, never passing. It rejects
unfinished ten-second windows, duplicate IDs and contradictory timestamps. Only
steps with an acknowledged-before-due evidence reference and no attempt may be
excluded. Keep the corresponding immutable acknowledgement evidence separately;
never include bearer tokens.

Evidence format 1 contains `host` (`standalone` or `dashboard`),
`clock: "synchronized_utc"`, `commitObservation: "database_commit_timestamp"`,
`startedAt`, `endedAt`, `initialPages` (incidentId, committedAt,
firstAttemptAt nullable) and `escalationSteps` (stepId, dueAt,
firstAttemptAt nullable, acknowledgedAt nullable, ackEvidenceId when excluded).
Timestamps are canonical UTC with millisecond precision. Capture actual database
transaction commit times with authorized disposable-database instrumentation,
for example transaction IDs associated with PostgreSQL commit-timestamp evidence.
An application log written after COMMIT returns, an incident creation timestamp,
or an HTTP response timestamp is not an exact commit observation and must not be
relabeled as one. Record clock synchronization and timing uncertainty. Collect
all eligible incidents/steps from the load cohort, not only successful deliveries.

The evaluator deliberately marks provenance as operator-supplied and does not
certify a supported capacity envelope. Its fractions must be accompanied by the
load manifest, all-process resource samples, database growth, queue lag, provider
latencies and the scenario/retention evidence described above. No tools or
workloads in this section were run against an application or database here.
