import type { WorkspaceId } from "../../src/contracts/index.js";
import type { StuckDeploymentTransaction } from "../../src/application/deploy/stuck.js";
import { stuckConformance } from "./stuck.js";
import { MemoryDeploymentRepository } from "./memory-deployments.js";
import { withDeploymentTimeout } from "../../src/application/deploy/stuck.js";
stuckConformance("memory deployment timeout", async () => {
  const storage = new MemoryDeploymentRepository();
  return {
    repository: {
      findTokenContext: (hash: string) => storage.findTokenContext(hash),
      transaction<T>(
        scope: WorkspaceId,
        run: (tx: StuckDeploymentTransaction) => Promise<T>,
      ): Promise<T> {
        return storage.withExtensions(
          scope,
          (deployment, configuration, _extensions, guard) =>
            run(
              withDeploymentTimeout({ ...configuration, ...deployment }, guard),
            ),
        );
      },
    },
    configuration: storage.configuration,
    work: storage.work,
    dispose: async () => {},
  };
});
