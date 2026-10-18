import {
  opaqueIdSchema,
  type DeploymentWatchView,
} from "../../contracts/index.js";
import { PersistenceError } from "../ports/persistence.js";
import { DeploymentAccessError, deploymentTokenDigest } from "./access.js";
import type { DeploymentWatchReader } from "./watch-read.js";

export interface DeploymentWatchHttpResponse {
  status: 200 | 400 | 401 | 404 | 429 | 503;
  body:
    | DeploymentWatchView
    | {
        error:
          | "invalid_input"
          | "invalid_token"
          | "not_found"
          | "busy"
          | "unavailable";
      };
}
/** GET reads persisted state only. Live scoped grant checks still run on every poll. */
export class DeploymentWatchHttp {
  private active = 0;
  constructor(
    private readonly reader: Pick<DeploymentWatchReader, "read">,
    private readonly available = () => true,
    private readonly maxInFlight = 8,
  ) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64)
      throw new RangeError("Invalid deployment watch read capacity");
  }
  async read(
    id: string,
    authorization?: string,
  ): Promise<DeploymentWatchHttpResponse> {
    try {
      if (!this.available())
        return { status: 503, body: { error: "unavailable" } };
    } catch {
      return { status: 503, body: { error: "unavailable" } };
    }
    const match = /^Bearer (.+)$/i.exec(authorization ?? "");
    if (!match || !deploymentTokenDigest(match[1]))
      return { status: 401, body: { error: "invalid_token" } };
    if (!opaqueIdSchema.safeParse(id).success)
      return { status: 400, body: { error: "invalid_input" } };
    if (this.active >= this.maxInFlight)
      return { status: 429, body: { error: "busy" } };
    this.active++;
    try {
      return { status: 200, body: await this.reader.read(match[1], id) };
    } catch (error) {
      if (error instanceof DeploymentAccessError)
        return { status: 401, body: { error: "invalid_token" } };
      if (error instanceof PersistenceError && error.code === "not_found")
        return { status: 404, body: { error: "not_found" } };
      return { status: 503, body: { error: "unavailable" } };
    } finally {
      this.active--;
    }
  }
}
