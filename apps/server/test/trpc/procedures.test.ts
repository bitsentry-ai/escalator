import test from "node:test";
import assert from "node:assert/strict";
import type { AnyTRPCProcedure } from "@trpc/server";
import type { AppContext } from "../../src/platform/trpc/context.js";
import { appRouter } from "../../src/platform/trpc/router.js";
import { routerContext, sessionActor } from "./router-context.js";

const procedures = Object.entries(
  appRouter._def.procedures as unknown as Record<string, AnyTRPCProcedure>,
);
// auth.* establishes sessions itself and is covered by auth/router.test.ts.
const publicProcedures = new Set(["packageInfo"]);
const guarded = procedures.filter(
  ([path]) => !path.startsWith("auth.") && !publicProcedures.has(path),
);

function call(context: AppContext, path: string, input?: unknown) {
  const procedure = path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      appRouter.createCaller(context),
    );
  return (procedure as (input: unknown) => Promise<unknown>)(input);
}

/** Records any read of a context field the session fixture does not provide, i.e. every use case. */
function untouchableContext(overrides: Partial<AppContext> = {}) {
  const touched: string[] = [];
  const context = new Proxy(routerContext(overrides), {
    get(target, key, receiver) {
      if (!(key in target)) touched.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  return { touched, context };
}

test("every non-public procedure rejects anonymous and revoked sessions before any use case", async () => {
  assert.ok(guarded.length > 100);
  for (const [path] of guarded) {
    const anonymous = untouchableContext();
    delete anonymous.context.req.session.account;
    const revoked = untouchableContext({
      auth: {
        current: async () => {
          throw Object.assign(new Error("private"), {
            code: "authentication_failed",
          });
        },
      } as unknown as AppContext["auth"],
    });
    for (const { context, touched } of [anonymous, revoked]) {
      await assert.rejects(call(context, path), { code: "UNAUTHORIZED" }, path);
      assert.deepEqual(touched, [], path);
    }
  }
});

/** Top-level object schemas behind wrappers, unions and pipes. */
function objectSchemas(schema: unknown): unknown[] {
  const def = (schema as { _zod?: { def: Record<string, unknown> } })._zod?.def;
  if (!def) return [];
  if (def.type === "object") return [schema];
  if (def.type === "union")
    return (def.options as unknown[]).flatMap(objectSchemas);
  if (def.type === "intersection")
    return [def.left, def.right].flatMap(objectSchemas);
  if (def.type === "pipe") return objectSchemas(def.in);
  if (def.type === "lazy")
    return objectSchemas((def.getter as () => unknown)());
  return "innerType" in def ? objectSchemas(def.innerType) : [];
}

test("every procedure input rejects caller-supplied workspace, actor and other unknown keys", () => {
  for (const [path, procedure] of procedures) {
    for (const input of procedure._def.inputs as unknown[])
      for (const object of objectSchemas(input)) {
        const def = (
          object as {
            _zod: {
              def: {
                shape: object;
                catchall?: { _zod: { def: { type: string } } };
              };
            };
          }
        )._zod.def;
        assert.equal(
          def.catchall?._zod.def.type,
          "never",
          `${path} is not strict`,
        );
        assert.equal("workspaceId" in def.shape, false, path);
      }
  }
});

test("strict input fails as BAD_REQUEST before the use case runs", async () => {
  const { context, touched } = untouchableContext();
  await assert.rejects(
    call(context, "services.create", {
      name: "API",
      key: "api",
      owningTeam: "Platform",
      workspaceId: "other",
    }),
    { code: "BAD_REQUEST" },
  );
  assert.deepEqual(touched, []);
});

test("authenticated procedures act as the session's current account in the host workspace", async () => {
  const proofs: unknown[] = [];
  const actors: unknown[] = [];
  const context = routerContext({
    auth: {
      current: async (proof: unknown) => {
        proofs.push(proof);
        return { id: "responder-7", role: "viewer" };
      },
    },
    services: {
      listServices: async (actor: unknown) => {
        actors.push(actor);
        return { items: [], next: null };
      },
    },
  });
  await call(context, "services.list", {});
  assert.deepEqual(proofs, [context.req.session.account]);
  assert.deepEqual(actors, [sessionActor("responder-7", "viewer")]);
});
