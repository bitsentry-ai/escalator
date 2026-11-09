import type { Request } from "express";
import type { Actor, Role } from "@bitsentry-escalator/features/contracts";
import type { AppContext } from "../../src/platform/trpc/context.js";

/**
 * A router context with a signed-in local session. Tests pass only the use
 * cases they exercise, so adding a dependency to AppContext edits no fixture.
 */
export function routerContext(
  dependencies: { [Key in keyof AppContext]?: unknown } = {},
  account: { id?: string; role?: Role } = {},
) {
  const { id = "owner", role = "administrator" } = account;
  return {
    workspaceId: "local",
    req: {
      session: { account: { accountId: id, authVersion: 1 } },
    } as unknown as Request,
    res: {},
    auth: { current: async () => ({ id, role }) },
    ...dependencies,
  } as unknown as AppContext;
}

export function sessionActor(
  id = "owner",
  role: Role = "administrator",
): Actor {
  return { workspaceId: "local", responderId: id, role } as Actor;
}
