import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  createPagingHandlers,
  pagingJobLanes,
  type WorkQueue,
} from "@bitsentry-escalator/features/application";
import {
  createPagingChannels,
  PublicHttpsChannelTransport,
} from "@bitsentry-escalator/features/channels";
import { PostgresConfigurationRepository } from "../../platform/database/configuration.repository.js";
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
) {
  const repository = new PostgresConfigurationRepository(pool);
  const channels = createPagingChannels(
    new EncryptedSecretStore(keys, new PostgresSecretReader(pool)),
    new PublicHttpsChannelTransport(),
  );
  return {
    repository,
    runtime: new PostgresJobsRuntime(
      pool,
      scope,
      createPagingHandlers(repository, channels, publicUrl),
      onError,
      pagingJobLanes,
    ),
  };
}
