import { z } from "zod";
import { ProbeDestinationPolicy } from "../../adapters/probes/policy.js";
import {
  defaultMetricLimits,
  metricLimitsSchema,
  type MetricLimits,
} from "./capacity.js";
const deploymentSchema = z.strictObject({
  destinations: z.strictObject({
    hosts: z
      .array(
        z.strictObject({
          hostname: z.string().min(1).max(253),
          ports: z.array(z.number().int().min(1).max(65535)).min(1).max(100),
        }),
      )
      .max(1000),
    privateCidrs: z.array(z.string().min(1).max(64)).max(1000),
  }),
  limits: metricLimitsSchema.default({ ...defaultMetricLimits }),
});
/** Trusted deployment input only; never accept these rules from application clients. */
export class MetricDeployment {
  readonly policy: ProbeDestinationPolicy;
  readonly limits: Readonly<MetricLimits>;
  constructor(
    input: unknown = { destinations: { hosts: [], privateCidrs: [] } },
  ) {
    try {
      const value = deploymentSchema.parse(input);
      this.policy = new ProbeDestinationPolicy(value.destinations);
      this.limits = Object.freeze(value.limits);
    } catch {
      // Configuration errors must not print internal hostnames or supplied environment values.
      throw new Error("Invalid metric deployment configuration");
    }
  }
  static fromJSON(value: string | undefined): MetricDeployment {
    if (value === undefined || value === "") return new MetricDeployment();
    try {
      if (Buffer.byteLength(value) > 131072)
        throw new Error("configuration exceeds 128 KiB");
      return new MetricDeployment(JSON.parse(value));
    } catch {
      throw new Error("Invalid metric deployment configuration");
    }
  }
}
