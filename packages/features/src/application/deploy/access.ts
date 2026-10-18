import { createHash } from "node:crypto";
import type {
  DeploymentTarget,
  DeploymentToken,
  WorkspaceId,
} from "../../contracts/index.js";
import type { DeploymentRepository, DeploymentTransaction } from "./ports.js";
export class DeploymentAccessError extends Error {
  constructor() {
    super("invalid_token");
  }
  readonly code = "invalid_token";
}
export function deploymentTokenDigest(token: string): string | undefined {
  if (typeof token !== "string" || !/^edp_[A-Za-z0-9_-]{43}$/.test(token))
    return undefined;
  return createHash("sha256").update(token).digest("hex");
}
export interface AuthorizedDeployment {
  tx: DeploymentTransaction;
  target: DeploymentTarget;
  grant: DeploymentToken;
  now: string;
}
/** No request-body scope. Authenticate again under the target lock before every read/replay/write. */
export class DeploymentAccess {
  constructor(
    private readonly repository: DeploymentRepository,
    private readonly allowed: (scope: WorkspaceId) => boolean,
  ) {}
  async run<T>(
    token: string,
    capability: DeploymentToken["capabilities"][number],
    work: (context: AuthorizedDeployment) => Promise<T>,
  ): Promise<T> {
    const hash = deploymentTokenDigest(token);
    if (!hash) throw new DeploymentAccessError();
    const context = await this.repository.findTokenContext(hash);
    if (!context || !this.allowed(context.workspaceId))
      throw new DeploymentAccessError();
    return this.repository.transaction(context.workspaceId, async (tx) => {
      const target = await tx.targets.get(context.targetId);
      if (!target?.enabled) throw new DeploymentAccessError();
      const grant = await tx.tokens.get(target.id, hash);
      const service = await tx.services.get(target.serviceId);
      const now = await tx.currentTime();
      if (
        !service?.enabled ||
        !grant ||
        grant.id !== context.id ||
        grant.targetId !== target.id ||
        grant.revokedAt !== null ||
        !grant.capabilities.includes(capability) ||
        Date.parse(grant.createdAt) > Date.parse(now) ||
        Date.parse(grant.expiresAt) <= Date.parse(now)
      )
        throw new DeploymentAccessError();
      return work({ tx, target, grant, now });
    });
  }
}
