import { PostgresHeartbeatRepository } from "../../platform/database/heartbeats.repository.js";
import { PostgresProbeRepository } from "../../platform/database/probes.repository.js";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  ProbeDeployment,
  HttpProbeRunner,
  PolicyHttpProbeTransport,
  withProbeHandlers,
  withHeartbeatHandlers,
  heartbeatJobLane,
  probeJobLane,
  createMonitoringHandlers,
  monitoringJobLanes,
  type WorkQueue,
} from "@bitsentry-escalator/features/application";
import {
  createPagingChannels,
  PublicHttpsChannelTransport,
} from "@bitsentry-escalator/features/channels";
import { PostgresDetectionRepository } from "../../platform/database/detection.repository.js";
import { PostgresJobsRuntime } from "../../platform/jobs/postgres-jobs.runtime.js";
import { EncryptedSecretStore } from "../../platform/secrets/encrypted-secret.store.js";
import { PostgresSecretReader } from "../../platform/secrets/postgres-secret.reader.js";
import type { SecretKeyRing } from "../../platform/secrets/keyring.js";
export function standalonePagingRuntime(
  pool: Pool,
  scope: WorkspaceId,
  keys: SecretKeyRing,
  publicUrl: string,
  onError: (queue: WorkQueue) => void,
  deployment = new ProbeDeployment(),
) {
  const repository = new PostgresDetectionRepository(pool);
  const secrets = new EncryptedSecretStore(
    keys,
    new PostgresSecretReader(pool),
  );
  const channels = createPagingChannels(
    secrets,
    new PublicHttpsChannelTransport(),
  );
  return {
    repository,
    runtime: new PostgresJobsRuntime(
      pool,
      scope,
      withHeartbeatHandlers(
        withProbeHandlers(
          createMonitoringHandlers(repository, channels, publicUrl),
          new PostgresProbeRepository(pool),
          new HttpProbeRunner(
            new PolicyHttpProbeTransport(deployment.policy),
            secrets,
          ),
        ),
        new PostgresHeartbeatRepository(pool),
      ),
      onError,
      [...monitoringJobLanes, probeJobLane, heartbeatJobLane],
      { "probe.execute": deployment.limits.concurrency },
    ),
  };
}
