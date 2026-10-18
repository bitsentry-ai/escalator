# Alert grouping contracts

T3.4's shared domain layer keeps one watermark for each scoped source/fingerprint.
The grouping key also includes service and environment. Explicit cross-source
fingerprint grouping can join matching fingerprints; it never joins every alert
from a service. A contributing alert keeps its grouping key while its incident is
active, even if an administrator edits source grouping.

Recovery must be strictly newer than the last active observation. Active wins an
equal-timestamp ambiguity. Duplicate signal IDs and older observations are
ignored. Events more than five minutes ahead of database time are rejected by
processing rather than poisoning the watermark. Disabled sources and manual-only
recovery modes cannot manufacture a healthy state.

Every contributing alert must explicitly recover before a recovery deadline can
exist. Each alert's hold starts at database processing time; repeated recovered
observations do not postpone it. A relapse removes the deadline. Empty groups,
missing telemetry and active alerts never establish health.

Automatic paging requires an explicit service/environment policy binding. The
persistence contract defines scoped bindings, serialized group creation,
immutable processing receipts and guarded alert-to-incident links. It shares the
same physical transaction with existing configuration, signal and paging stores.
Lock order is source, group, page, then durable work claim.

This part contains domain and persistence-boundary unit tests. Processing jobs,
SQL adapters, migrations and runtime registration follow in later stack parts;
these exports alone do not start automatic paging. PostgreSQL atomicity and
contention still require the opt-in conformance procedure and are not claimed by
the storage-guard unit stubs.
