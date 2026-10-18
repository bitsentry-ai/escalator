import { Controller, Get, Headers, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  healthHeaders,
  OperationalHealthHttp,
} from "@bitsentry-escalator/features/application";
import { StandaloneDatabase } from "../database/database.module.js";
/** Liveness is process-only; authenticated readiness checks the real scoped scheduler. */
@Controller("health")
export class OperationalHealthController {
  constructor(
    private readonly http: OperationalHealthHttp,
    private readonly database: StandaloneDatabase,
  ) {}
  @Get("live")
  live(@Res() response: Response) {
    response.set(healthHeaders).status(200).json({ live: true });
  }
  @Get("ready")
  async ready(
    @Headers("authorization") authorization: string | undefined,
    @Res() response: Response,
  ) {
    const result = await this.http.readiness(
      this.database.workspaceId,
      authorization,
    );
    response.set(healthHeaders).status(result.status).json(result.body);
  }
}
