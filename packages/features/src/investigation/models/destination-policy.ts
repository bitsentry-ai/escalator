import { BlockList, isIP } from "node:net";
import {
  ProbeDestinationPolicy,
  type ProbeEgressRules,
} from "../../adapters/probes/policy.js";
import { isPublicChannelAddress } from "../../adapters/channels/public-address.js";
export type ModelLocation = "local" | "remote";
export class ModelDestinationError extends Error {
  constructor() {
    super("Model destination denied");
    this.name = "ModelDestinationError";
  }
}
export interface ModelEgressRules extends ProbeEgressRules {
  /** Deployment administrator only; profile forms cannot grant loopback access. */
  allowLocalLoopback: boolean;
}
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
/** Same host/port and private-network approval as probes, with explicitly local loopback. */
export class ModelDestinationPolicy {
  private readonly approved: ProbeDestinationPolicy;
  private readonly allowLoopback: boolean;
  constructor(rules: ModelEgressRules) {
    try {
      this.approved = new ProbeDestinationPolicy(rules);
      this.allowLoopback = rules.allowLocalLoopback === true;
    } catch {
      throw new ModelDestinationError();
    }
  }
  endpoint(value: string, location: ModelLocation): URL {
    try {
      if (!["local", "remote"].includes(location))
        throw new ModelDestinationError();
      const url = this.approved.target(value);
      if (url.search || (location === "remote" && url.protocol !== "https:"))
        throw new ModelDestinationError();
      return url;
    } catch {
      throw new ModelDestinationError();
    }
  }
  request(value: string, endpoint: URL, location: ModelLocation): URL {
    const url = this.endpoint(value, location);
    const prefix = endpoint.pathname.replace(/\/$/, "");
    if (
      url.origin !== endpoint.origin ||
      (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/"))
    )
      throw new ModelDestinationError();
    // Encoded path separators/dots could be normalized differently by a reverse proxy.
    if (/%(?:2e|2f|5c|25)/i.test(url.pathname))
      throw new ModelDestinationError();
    return url;
  }
  address(value: string, location: ModelLocation): boolean {
    const family = isIP(value);
    if (!family || value.includes("%")) return false;
    if (location === "remote")
      return isPublicChannelAddress(value) && this.approved.address(value);
    if (location !== "local" || isPublicChannelAddress(value)) return false;
    // BlockList maps IPv4-mapped IPv6 onto IPv4 subnets; never use that for
    // the loopback exception. Only native IPv6 ::1 qualifies.
    const localLoopback =
      family === 4
        ? loopback.check(value, "ipv4")
        : new URL(`http://[${value}]`).hostname === "[::1]";
    if (localLoopback) return this.allowLoopback;
    return this.approved.address(value);
  }
}
