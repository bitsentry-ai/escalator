import type { OperationalHealthCheck, OperationalHealth } from "./health.js";
import { HealthDeployment } from "./deployment.js";
export interface HealthBinding {
  deployment: HealthDeployment;
  health?: Pick<OperationalHealthCheck, "check">;
}
const denied = new HealthDeployment();
export const healthHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
/** Health REST exception: host selects the runtime; caller never supplies database scope. */
export class OperationalHealthHttp {
  constructor(
    private readonly lookup: (scope: string) => HealthBinding | undefined,
  ) {}
  async readiness(
    scope: string,
    authorization: string | undefined,
  ): Promise<{
    status: 200 | 401 | 503;
    body: OperationalHealth | { error: "unauthorized" | "unavailable" };
  }> {
    const binding = scope.length <= 160 ? this.lookup(scope) : undefined;
    if (!(binding?.deployment ?? denied).authorized(authorization))
      return { status: 401, body: { error: "unauthorized" } };
    if (!binding?.health)
      return { status: 503, body: { error: "unavailable" } };
    try {
      const result = await binding.health.check();
      return { status: result.ready ? 200 : 503, body: result };
    } catch {
      return { status: 503, body: { error: "unavailable" } };
    }
  }
}
