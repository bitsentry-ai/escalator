# Dashboard deployment watch storage

The Dashboard watch adapter uses the same `withDeploymentWatches` transaction contract as the standalone server. The package workspace ID is the trusted WorkOS organization ID; database rows carry only `organization_id`. Watch identity, source/criteria bindings, transaction-time validation, revision checks, incident matching and finalization all remain in the shared package.

The additive migration creates watch records with organization-scoped foreign keys and forced row-level security. A failed verdict requires a matching incident in the same organization, service and environment. Captured-source retention pins are inserted with the initial watch on the same physical transaction. Initialization retries retain the first watch and pin expiry.

Neither this adapter nor the preceding standalone adapter is activated by these persistence layers. Finish-triggered durable jobs, evidence evaluation, incident coalescing, probe cadence adjustment/restoration and watch read routes follow. Dashboard activation also retains the existing separate secret-broker integration requirement; this change does not substitute another credential store.
