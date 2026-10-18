import type { RetentionClient } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient } from "../../auth/auth-client.js";
export function retentionClient(client: LocalAuthClient): RetentionClient {
  return {
    get: () => client.query("retention.get"),
    update: (input) => client.mutate("retention.update", input),
    coverage: (input) => client.query("retention.coverage", input),
    streams: async (kind, input) => {
      const page = await client.query<
        Awaited<ReturnType<RetentionClient["streams"]>>
      >(
        kind === "signal"
          ? "signals.list"
          : kind === "probe"
            ? "probes.list"
            : "metrics.list",
        input,
      );
      return {
        next: page.next,
        items: page.items.map(({ id, name }) => ({ id, name })),
      };
    },
  };
}
