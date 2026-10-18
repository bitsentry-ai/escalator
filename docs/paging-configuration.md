# Paging configuration persistence

Schedules, policies, contacts and declared working hours are workspace-scoped,
versioned records. Creation expects `null` and version one; replacement expects the
current version and increments it exactly once. Conflicting writers receive `false`
and must reload. A record cannot change its service or responder identity.

Both host adapters implement `ConfigurationRecordStore` inside the existing paging
transaction, then call `configurationTransaction`. The shared assembler validates
references and schedule semantics, poisons caught errors, and expires handles with
the transaction. Stores must scope every read/write, enforce unique scoped IDs,
lock records for replacement, and preserve atomic rollback. Concurrent insert
conflicts may raise `already_exists`; callers retry outside the transaction.

Previews are immutable records of the computed effective intervals, including gaps.
Insertion recomputes intervals from the locked schedule revision. The timestamp is
transaction time. Enabled policies require saved previews of the current enabled
primary and peer schedules. Gaps remain visible and do not automatically reject a
policy: the explicit fallback ladder still applies. Editing a schedule invalidates
its preview for subsequent policy activation; old previews remain inspectable.
Page-creation orchestration must select and validate the active configuration in
its transaction before snapshotting the policy. An existing page keeps its snapshot.

Contact records contain only an opaque secret ID, never a provider destination or
credential. `secretExists` reads scoped metadata in the same transaction; it must
not call a broker or resolve plaintext. Delivery authorization still checks the
persisted work claim and frozen approved secret IDs. Dashboard secret activation
remains dependent on integration of the separate secret-store broker stack.

Declared working hours are keyed by responder ID. They describe availability for
deploy coverage, not on-call duty or proof that someone is awake. This storage layer
does not suppress an assigned responder's overnight pages.

The reusable `test/conformance/configuration.ts` suite exercises compare-and-swap,
scope isolation, stale previews, rollback, and handle lifetime. The memory adapter
shares the foundation and paging transaction draft, including rollback. Standalone
and Dashboard adapters and registrations follow in the next stack parts. No live
PostgreSQL run is claimed: no disposable test database is configured. Host test
procedures must keep using explicit test-only database variables without falling
back to the application database.
