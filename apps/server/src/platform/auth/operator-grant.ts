import { open, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { issueToken } from "./credentials.js";
/** Local CLI only. Never print the grant, overwrite a file, or accept a password argument. */
export async function writeOperatorGrant(
  file: string,
  persist: (digest: string) => Promise<void>,
): Promise<void> {
  if (!isAbsolute(file)) throw new Error("Grant file must be absolute");
  const handle = await open(file, "wx", 0o600);
  const token = issueToken();
  try {
    await handle.writeFile(`${token.value}\n`, "utf8");
    await handle.sync();
    await persist(token.digest);
  } catch (error) {
    await unlink(file);
    throw error;
  } finally {
    await handle.close();
  }
}
