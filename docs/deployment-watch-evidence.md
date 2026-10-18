# Deployment watch evidence

This part implements shared, pure evaluation of one monitored stream. It does not yet capture baselines, create watch records, schedule jobs, tighten probes, expose watch routes or create incidents. Those integrations must precede completion of T4.5 in both hosts.

A baseline covers the 15 minutes before the deployment's recorded start. A watch covers 30 minutes from its server-controlled watch start. Evaluation can run during that window. A known regression may produce `FAIL` early; healthy observations remain `PENDING` until the full window and a two-minute receipt grace have elapsed. The grace admits delayed receipts, not observations outside the watch window. Retries after the grace keep the original evidence cutoff.

Baseline snapshots must be captured and protected before the deployment proceeds. The evaluator checks their scope, stream identity and time window, but cannot prove how a host obtained them. Host integration must persist the baseline with the accepted start and must not reconstruct it later from data that became available during or after the deployment.

## Criteria version 1

Criteria are explicit snapshots, returned with the result. Defaults are deliberately deterministic:

| Stream     | Baseline requirement                                                  | Watch requirement                                                | Failure condition                                                                                                                                   |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP probe | At least three usable scheduled observations                          | At least one usable observation                                  | The captured probe's consecutive failure threshold; critical probes use one                                                                         |
| Metrics    | At least three usable samples and the monitor's minimum request count | At least three usable samples and the same minimum request count | Error rate exceeds baseline and reaches the maximum of the configured floor, twice baseline, and baseline plus one percentage point, capped at 100% |

Both windows require complete queries. `PASS` and `WARN` also require all expected scheduled slots, with no coverage gaps. A complete watch query whose usable evidence already meets the failure condition reports `FAIL` despite missing watch slots: a probe failure streak resets at each gap, and a metric failure still needs the minimum usable samples and request count. Missing baseline, insufficient metric traffic, unknown outcomes, missing configuration history, incompatible measurement changes and unsafe aggregate counts produce `INSUFFICIENT_DATA`. A valid failed HTTP request is usable negative evidence; an unknown result is not.

A smaller increase or isolated probe failure produces `WARN` at final evaluation. An unhealthy baseline also remains visible instead of being hidden by a later clean window. Synthetic probe observations establish route coverage; they do not establish customer traffic. Metrics use their recorded request counts.

## Evidence selection

Coverage and health use the same selected receipt identities. For each scheduled slot and configuration revision, select the newest receipt recorded by the cutoff, with deterministic identity tie-breaking. A newer unusable receipt cannot be replaced by an older healthy value. Unknown receipt availability and later corrections do not establish earlier health.

Probe/metric observation timestamps must fit the scheduled bucket and the configuration segment that produced them. Compatible cadence changes retain chronological consecutive observations; actual missing coverage interrupts a failure streak. Readers must establish measurement compatibility from captured definitions, not assume every revision is equivalent.

Results contain coverage reports, selected receipt references, aggregate counts and effective thresholds. They contain no provider bodies, credential values or destination URLs. Existing coverage-only callers retain their previous report API without allocating the selected-reference list.

## Host obligations

The persistence/orchestration parts must capture immutable baselines, protect required history from retention, constrain probe tightening to available capacity, and preserve operator changes when restoring cadence. They must retain the first failed verdict/evidence, open or link its incident exactly once, and keep collecting evidence through watch completion. A later aggregate improvement must not erase an earlier failure decision.

Overlapping deployments need separate watch records and an explicit uncertain-attribution marker. Neither a failed watch nor a correlation establishes causality, authorizes rollback or implements a promotion gate.
