import type { OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { MaintenanceAdmission } from "@bitsentry-escalator/features/application";
import { PostgresRetentionMaintenanceRepository } from "../../platform/database/retention-maintenance.repository.js";
/** One extra connection, separate from the paging/API pool; application shutdown follows runner stop. */
export class StandaloneRetentionResources implements OnApplicationShutdown {
  readonly admission = new MaintenanceAdmission();
  readonly pool: Pool;
  readonly repository: PostgresRetentionMaintenanceRepository;
  constructor(connectionString: string, onError: () => void) {
    if (!connectionString)
      throw new Error("ESCALATOR_DATABASE_URL is required");
    this.pool = new Pool({
      connectionString,
      max: 1,
      statement_timeout: 5000,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    this.pool.on("error", () => {
      try {
        onError();
      } catch {
        /* Observability cannot crash the host. */
      }
    });
    this.repository = new PostgresRetentionMaintenanceRepository(this.pool);
  }
  async onApplicationShutdown(): Promise<void> {
    await this.admission.drain();
    await this.pool.end();
  }
}
