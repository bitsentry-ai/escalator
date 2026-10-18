import { acknowledgementResultSchema } from "../../contracts/index.js";
import type { AcknowledgementClient } from "./client.js";
/** Capability-only requests: no cookies, token query parameters, or persisted credentials. */
export function acknowledgementHttpClient(
  endpoint: string,
  token: string,
  request: typeof fetch = fetch,
): AcknowledgementClient {
  async function run(method: "GET" | "POST", signal: AbortSignal) {
    const response = await request(endpoint, {
      method,
      signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Acknowledgement unavailable");
    return acknowledgementResultSchema.parse(await response.json());
  }
  return {
    preview: (signal) => run("GET", signal),
    acknowledge: (signal) => run("POST", signal),
  };
}
