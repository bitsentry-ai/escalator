# Deployment watch cadence contracts

These shared plans and persistence ports do not change live probe intervals yet. Both hosts still need cadence job handlers, adapters, migrations and worker registration before activation.

Eligible captured probes can be shortened to the existing minimum of 60 seconds. Already-fast or disabled probes are skipped, and expired watches cannot begin a change. The application must use the existing configured-capacity check before applying a candidate; rejected candidates remain unchanged and get an explicit receipt.

A current lease preserves the original interval and the exact probe version applied by the watch. An overlapping watch extends that lease's restoration deadline without replacing the original interval. An operator edit invalidates ownership even if it leaves the interval at 60 seconds. A delayed first application also skips probes whose configuration version changed after baseline capture, unless a current lease proves that a watch still owns the cadence. Restoration must never overwrite that edit.

An immutable receipt per watch and probe prevents a successful but unsettled job from applying again after an operator edit. A generation and revision fence prevents an old restoration job from deleting a newer lease. Receipts, leases, actual probe configuration/history/scheduling and audits must commit on the same physical transaction.

The probe transaction is namespaced as `probeContext` so its signal-ingress token port cannot overwrite the deployment token port. Both contexts must share the same physical transaction, scope and timestamp.

The shared port takes capacity before target/source/probe locks, checks scope and captured inventory, and uses the existing poisoned-transaction guard. Host primitives must filter every operation by the host tenant key. The Dashboard key remains the WorkOS organization ID. No provider calls or secret resolution belong inside these transactions.

Probe configuration writes use the existing transaction timestamp. Workers also check live database time for expired watches; backwards or stale chronology must retry instead of backdating configuration. Restoring a longer interval reduces request capacity but still uses the capacity lock for serialization.
