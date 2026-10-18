import { initTRPC } from "@trpc/server";
import type { Request, Response } from "express";
import type { WorkspaceId } from "@bitsentry-escalator/features/contracts";
import type { LocalAuthService } from "../auth/auth.service.js";
import type { ServiceUseCases } from "@bitsentry-escalator/features/application";
export interface AppContext {
  services: ServiceUseCases;
  req: Request;
  res: Response;
  auth: LocalAuthService;
  workspaceId: WorkspaceId;
}
export const t = initTRPC.context<AppContext>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    message:
      error.code === "INTERNAL_SERVER_ERROR" ? "Request failed" : shape.message,
    data: { ...shape.data, stack: undefined },
  }),
});
