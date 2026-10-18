import { resolve } from "node:path";
import type { Express } from "express";
import { createApp } from "./main.js";
import { listenPort } from "./platform/http/listen-port.js";
import { mountStaticWeb } from "./platform/http/static-web.js";
/** Explicit production entry; importing for compilation/fixtures never starts a server. */
export async function start(): Promise<void> {
  const port = listenPort(process.env.PORT);
  const app = await createApp();
  try {
    await mountStaticWeb(
      app.getHttpAdapter().getInstance() as Express,
      resolve(__dirname, "../public"),
    );
    await app.listen(port, "0.0.0.0");
  } catch (error) {
    await app.close();
    throw error;
  }
}
if (require.main === module)
  void start().catch(() => {
    console.error(
      "Escalator could not start; verify the database, mounted keys, public origin and built assets.",
    );
    process.exitCode = 1;
  });
