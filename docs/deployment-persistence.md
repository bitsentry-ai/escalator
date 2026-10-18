# Deployment persistence contract

`DeploymentRepository` extends the existing scoped foundation transaction model.
Both database adapters must use `deploymentTransaction` with the same physical
transaction and `TransactionGuard` as foundation writes. A caught operation error
still poisons the transaction; escaped handles cannot be reused.

## Records

- A target is unique per workspace, service and environment. It owns versioned
  timeout settings and the configured escalation-policy reference.
- A grant belongs to one target. Only its hash is stored; capability, expiry,
  optional responder mapping and first revocation time remain explicit.
- A deployment keeps its immutable start identity and a routing-policy snapshot.
  Later policy, mapping or timeout changes do not alter an existing record.
  `targets.routing` reads the active definition inside the same transaction used
  to create the deployment; callers need no nested configuration transaction.
- An idempotency receipt is unique per workspace, target and key, across token
  rotation. It stores a request hash and original result, not raw request bodies
  or tokens. Key collisions never overwrite that result.

Grant lookup outside a tenant transaction returns only workspace, target and
grant IDs. It is not authentication: the application must reload and check the
target, capability, expiry and revocation under locks before performing a command
or returning a replay response. Read-only grants must never authorize writes.
The machine-ingress use cases implement those checks in a subsequent part.

## Host adapter requirements

Lock the target before its grant, deployment, receipt or durable work. Its unique
service/environment identity serializes concurrent starts even when the deployment
row does not exist yet. Keep transactions short and free of network calls. Use
database uniqueness for natural deployment keys and globally unique token hashes,
not a lookup followed by an unprotected insert.

Use live database time after waiting for locks. Recorded timestamps must fall
between transaction start and the current database time; lifecycle chronology
must also remain valid. Target/deployment updates increment exactly one revision
and use conditional updates. Routing and start identity are immutable.

Deployment, receipt, audit and durable work commit or roll back together. An
accepted receipt must identify the current persisted revision when inserted;
later lifecycle changes do not rewrite its original response. Rejected commands
may retain an explicit rejection result, but the application still owns
authorization, request hashing and audit metadata.

## Conformance

`test/conformance/deployments.ts` exports the reusable suite for both adapters.
`deployments-memory.test.ts` runs it against a test-only serializable memory
adapter. Run it with:

```sh
pnpm --dir apps/escalator --filter @bitsentry-escalator/features test
```

The memory suite covers scope isolation, uniqueness, concurrent revisions,
immutable snapshots, late finish, receipts, atomic rollback and transaction
lifetime. It does not prove PostgreSQL lock behavior. The two host adapters and
their opt-in database harnesses follow in subsequent parts; no disposable database
is configured and no infrastructure is started by this work.
