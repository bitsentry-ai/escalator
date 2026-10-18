# Guarded replay pruning transactions

The shared pruning use case selects at most 100 normalized receipts from an ordered page of at most 1,000 candidates belonging to one locked source. It uses database time, the saved policy, deployment ceilings and the committed payload counter. Each candidate carries protection established by the host's reference and live-work checks under the source lock.

The candidate protection total is only a lower bound for this batch. Selecting a batch does not require a full-history aggregate, and the result does not claim an exact global protected-byte total. A protected receipt is never selected to relieve storage pressure. Usage may remain above the maintenance target.

The transaction adapter must keep source identity, work eligibility, accounting and policy stable until deletion commits. It applies tombstones, dependent terminal records and receipt deletion together, then returns actual row, byte and counter totals. A discrepancy poisons the transaction even when the callback catches the error. Audit failure also rolls back the batch. Handles expire at transaction completion, and a selection cannot be reused across snapshots.

The use case returns a continuation through the last examined receipt, including protected records. Adapters must preserve database timestamp precision in UTC cursor text and use the same timestamp/kind/ASCII-ID order; PostgreSQL timestamps have microsecond resolution. See the [PostgreSQL date/time documentation](https://www.postgresql.org/docs/18/datatype-datetime.html). Reaching the deletion limit stops before eligible records that have not been deleted. A protected page can advance without an audit or a reclamation claim. Once byte pressure is relieved and an ordered page reaches the age cutoff, the sweep can stop without reading the remaining recent history. Later sweeps must restart so late arrivals and records whose protection has ended are reconsidered.

A returned result is committed only after the enclosing repository transaction resolves. A durable caller must bind the operation to its authoritative work claim and commit the next maintenance cursor/job in the same transaction. Source locks precede work and accounting locks; a caller must not acquire a second source lock afterward.

This part supplies the shared transaction contract, use case and memory tests. PostgreSQL candidate/reference checks, deletion adapters, durable scheduling, API registration and UI activation follow in subsequent parts of T3.12. The repository interface is internal; it is not an authenticated application endpoint. Production deletion is not activated here.

Run the shared cases with:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
```

PostgreSQL pruning and concurrency checks will require the existing explicit disposable test database variables. No database or server is started by this procedure.
