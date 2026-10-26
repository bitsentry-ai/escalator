import { z } from "zod";
import {
  ModelDestinationPolicy,
  type ModelEgressRules,
} from "@bitsentry-escalator/features/investigation";
const schema = z.strictObject({
  enabled: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(4).default(1),
  pollEveryMs: z.number().int().min(250).max(60000).default(1000),
  egress: z
    .strictObject({
      hosts: z
        .array(
          z.strictObject({
            hostname: z.string().min(1).max(253),
            ports: z.array(z.number().int().min(1).max(65535)).min(1).max(100),
          }),
        )
        .max(1000),
      privateCidrs: z.array(z.string().min(3).max(100)).max(1000),
      allowLocalLoopback: z.boolean(),
    })
    .default({ hosts: [], privateCidrs: [], allowLocalLoopback: false }),
});
export class StandaloneInvestigationDeployment {
  readonly enabled: boolean;
  readonly concurrency: number;
  readonly pollEveryMs: number;
  readonly policy: ModelDestinationPolicy;
  constructor(input: unknown = {}) {
    const value = schema.parse(input);
    this.enabled = value.enabled;
    this.concurrency = value.concurrency;
    this.pollEveryMs = value.pollEveryMs;
    this.policy = new ModelDestinationPolicy(value.egress as ModelEgressRules);
  }
  static fromJSON(raw: string | undefined) {
    try {
      if (raw !== undefined && Buffer.byteLength(raw, "utf8") > 262144)
        throw new Error("configuration exceeds 256 KiB");
      return new StandaloneInvestigationDeployment(
        raw === undefined ? {} : JSON.parse(raw),
      );
    } catch {
      throw new Error("Invalid ESCALATOR_INVESTIGATION configuration");
    }
  }
}
