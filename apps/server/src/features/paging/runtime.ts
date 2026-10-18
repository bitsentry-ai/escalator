import { PostgresRuleReplayRepository } from "../../platform/database/rule-replay.repository.js";
import { PostgresRuleLiveRepository } from "../../platform/database/rule-live.repository.js";
import { postgresRulePolicyStore } from "../../platform/database/postgres-rule-policy.store.js";
import {
  withRuleEvaluationHandlers,
  ruleEvaluationLane,
  ruleReplayLane,
  ruleBacktestLane,
  withRuleBacktestHandlers,
  withRuleReplayHandlers,
} from "@bitsentry-escalator/features/application";
import { RepositoryConnections } from "@bitsentry-escalator/features/investigation";
import {
  withDeploymentTimeoutHandlers,
  deploymentTimeoutLane,
  withDeploymentWatchHandlers,
  withWatchCadenceHandlers,
  deploymentWatchLane,
  deploymentWatchCadenceLane,
} from "@bitsentry-escalator/features/application";
import { PostgresDeploymentWatchRuntimeRepository } from "../../platform/database/deployment-watch-runtime.repository.js";
import { PostgresMetricsRepository } from "../../platform/database/metrics.repository.js";
import { PostgresHeartbeatRepository } from "../../platform/database/heartbeats.repository.js";
import { PostgresProbeRepository } from "../../platform/database/probes.repository.js";
import type { Pool } from "pg";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import {
  RetentionMaintenanceJobs,
  withRetentionHandlers,
  retentionJobLane,
  type RetentionRuntimeResources,
  RetentionCoordinator,
  ProbeDeployment,
  HealthDeployment,
  WatchdogJobs,
  withWatchdogHandlers,
  MetricDeployment,
  PrometheusMetricsReader,
  withMetricHandlers,
  metricJobLane,
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
  retention: RetentionRuntimeResources,
  deployment = new ProbeDeployment(),
  metrics = new MetricDeployment(),
  health = new HealthDeployment(),
  repositoryConnections = new RepositoryConnections(),
) {
  const repository = new PostgresDetectionRepository(
    pool,
    repositoryConnections,
  );
  const secrets = new EncryptedSecretStore(
    keys,
    new PostgresSecretReader(pool),
  );
  const http = new PublicHttpsChannelTransport();
  const channels = createPagingChannels(secrets, http);
  const handlers = withMetricHandlers(
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
    new PostgresMetricsRepository(pool),
    new PrometheusMetricsReader(
      new PolicyHttpProbeTransport(metrics.policy),
      secrets,
    ),
  );
  const deployments = new PostgresDeploymentWatchRuntimeRepository(
    pool,
    repositoryConnections,
  );
  const deploymentHandlers = withWatchCadenceHandlers(
    withDeploymentWatchHandlers(
      withDeploymentTimeoutHandlers(handlers, deployments),
      deployments,
    ),
    deployments,
    deployment.limits,
  );
  const retainedHandlers = withRetentionHandlers(
    deploymentHandlers,
    new RetentionMaintenanceJobs(retention.repository),
    retention.admission,
  );
  const ruleHandlers = withRuleEvaluationHandlers(
    retainedHandlers,
    new PostgresRuleLiveRepository(
      pool,
      postgresRulePolicyStore,
      repositoryConnections,
    ),
  );
  const replayHandlers = withRuleReplayHandlers(
    ruleHandlers,
    new PostgresRuleReplayRepository(pool),
  );
  const reportHandlers = withRuleBacktestHandlers(
    replayHandlers,
    new PostgresRuleReplayRepository(pool),
  );
  const watchdog = health.watchdog
    ? new WatchdogJobs(
        repository,
        scope,
        health.watchdog,
        { check: () => runtime.health.check() },
        secrets,
        http,
      )
    : undefined;
  const runtime: PostgresJobsRuntime = new PostgresJobsRuntime(
    pool,
    scope,
    watchdog ? withWatchdogHandlers(reportHandlers, watchdog) : reportHandlers,
    onError,
    [
      ...monitoringJobLanes,
      probeJobLane,
      heartbeatJobLane,
      deploymentTimeoutLane,
      deploymentWatchLane,
      deploymentWatchCadenceLane,
      metricJobLane,
      retentionJobLane,
      ruleEvaluationLane,
      ruleReplayLane,
      ruleBacktestLane,
      ...(watchdog ? [watchdog.lane] : []),
    ],
    {
      "probe.execute": deployment.limits.concurrency,
      "metrics.poll": metrics.limits.concurrency,
      "rules.evaluate": 1,
      "rules.replay": 1,
      "rules.backtest": 1,
    },
    health,
    new RetentionCoordinator(
      retention.repository,
      [scope],
      retention.admission,
      () => onError("job"),
    ),
  );
  return { repository, runtime };
}
