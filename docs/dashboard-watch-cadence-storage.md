# Dashboard watch cadence persistence

The Dashboard adapter uses `organizationId` equal to the WorkOS organization ID. The shared package receives that value as `workspaceId`; no second tenant identifier is stored. The additive migration introduces current cadence ownership and immutable per-watch/probe receipts, with composite ownership foreign keys, JSON consistency checks and forced row security.

`PrismaWatchCadenceRepository` composes deployment, baseline, watch, paging, probe and signal ports on one guarded Prisma transaction. Probe/source changes, restoration jobs, receipts and audit commit together. Deployment-token methods remain separate from signal-ingress tokens. This adapter is not registered in the live runtime until the watch worker lanes and budget are composed in both hosts.

Updates require the expected ownership revision and generation. Receipts cannot be updated or deleted by the application role. Deleting an expired or superseded lease preserves its receipts so a retried application cannot overwrite an operator edit.
