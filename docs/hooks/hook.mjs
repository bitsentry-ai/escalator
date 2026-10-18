#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { open, mkdir, lstat, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  HookError,
  endpoint,
  initialSession,
  transport,
  begin,
  finish,
} from "./client.mjs";

const required = (env, name) => {
  if (!env[name]) throw new HookError(`Missing ${name}`);
  return env[name];
};
function intent(env) {
  return {
    version: 1,
    source: required(env, "ESCALATOR_SOURCE"),
    externalId: required(env, "ESCALATOR_RUN_ID"),
    environmentId: required(env, "ESCALATOR_ENVIRONMENT"),
    actor: required(env, "ESCALATOR_ACTOR"),
    commit: env.ESCALATOR_COMMIT || null,
    artifact: env.ESCALATOR_ARTIFACT || null,
    occurredAt: new Date().toISOString(),
  };
}
function ownership(stat) {
  if (
    typeof process.getuid !== "function" ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw new HookError(
      "Use a private state path owned by the current Unix user",
    );
}
/** An exclusive sibling lock prevents two hook invocations from changing one intent. */
export async function withState(path, run) {
  path = resolve(path);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const parent = await lstat(dir);
  ownership(parent);
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new HookError("Invalid state directory");
  let lock;
  try {
    lock = await open(path + ".lock", "wx", 0o600);
  } catch {
    throw new HookError(
      "State is locked; verify no hook is running before removing a stale lock",
    );
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await lock.sync();
    let state = null;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        ownership(stat);
        if (!stat.isFile() || stat.size > 65536)
          throw new HookError("Invalid state file");
        state = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const save = async (value) => {
      const bytes = JSON.stringify(value);
      if (Buffer.byteLength(bytes) > 65536)
        throw new HookError("State exceeds the client limit");
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        const directory = await open(dir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    };
    return await run(state, save);
  } finally {
    await lock.close();
    await unlink(path + ".lock");
  }
}
function validateState(state, base) {
  if (state?.version !== 1 || state.baseUrl !== base)
    throw new HookError("State belongs to another API endpoint");
  initialSession(base, state.event, state.key);
  if (
    typeof state.finished !== "boolean" ||
    (state.deploymentId !== null && typeof state.deploymentId !== "string")
  )
    throw new HookError("Invalid deployment session");
  if (state.startBody !== null) {
    const { coverageDecisionId, ...event } = state.startBody;
    if (
      typeof coverageDecisionId !== "string" ||
      !coverageDecisionId ||
      JSON.stringify(event) !== JSON.stringify(state.event)
    )
      throw new HookError("Stored start intent differs");
  }
  if (state.finishBody !== null) {
    const { version, source, externalId, environmentId, actor } = state.event;
    const { occurredAt, outcome } = state.finishBody;
    if (
      !["SUCCEEDED", "FAILED", "CANCELLED"].includes(outcome) ||
      !Number.isFinite(Date.parse(occurredAt)) ||
      JSON.stringify(state.finishBody) !==
        JSON.stringify({
          version,
          source,
          externalId,
          environmentId,
          actor,
          occurredAt,
          outcome,
        })
    )
      throw new HookError("Stored finish intent differs");
  }
}
export async function main(
  args = process.argv.slice(2),
  env = process.env,
  fetcher = fetch,
) {
  const [action, outcome] = args;
  if (
    (action !== "begin" && action !== "finish") ||
    args.length !== (action === "begin" ? 1 : 2)
  )
    throw new HookError(
      "Usage: node hook.mjs begin | finish SUCCEEDED|FAILED|CANCELLED",
    );
  const base = endpoint(required(env, "ESCALATOR_URL"));
  const send = transport(base, required(env, "ESCALATOR_TOKEN"), fetcher);
  return withState(required(env, "ESCALATOR_STATE"), async (state, save) => {
    if (!state) {
      if (action !== "begin")
        throw new HookError("Missing confirmed deployment session");
      state = initialSession(base, intent(env));
      await save(state); // Persist the key and timestamp BEFORE the first network request.
    }
    validateState(state, base);
    if (action === "begin") {
      const current = intent(env);
      for (const key of [
        "source",
        "externalId",
        "environmentId",
        "actor",
        "commit",
        "artifact",
      ])
        if (current[key] !== state.event[key])
          throw new HookError(
            "Use the original deployment intent when retrying",
          );
      return begin(state, send, save);
    }
    return finish(state, outcome, send, save);
  });
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main()
    .then((deploymentId) =>
      process.stdout.write(JSON.stringify({ deploymentId }) + "\n"),
    )
    .catch((error) => {
      console.error(
        error instanceof HookError
          ? error.message
          : "Escalator hook failed; request outcome may be unknown",
      );
      process.exitCode = 1;
    });
}
