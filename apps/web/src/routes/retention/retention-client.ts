import type { RetentionClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
const STREAM_LISTS = {
  signal: "signals.list",
  probe: "probes.list",
  metric: "metrics.list",
} as const;
export function retentionClient(client: LocalAuthClient): RetentionClient {
  return {
    get: () => client.query("retention.get"),
    update: (input) => client.mutate("retention.update", input),
    coverage: (input) => client.query("retention.coverage", input),
    streams: async (kind, input) => {
      const page = await client.query<
        Awaited<ReturnType<RetentionClient["streams"]>>
      >(STREAM_LISTS[kind], input);
      return {
        next: page.next,
        items: page.items.map(({ id, name }) => ({ id, name })),
      };
    },
  };
}
