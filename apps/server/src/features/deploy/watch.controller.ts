import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { DeploymentWatchHttp } from "@bitsentry-escalator/features/application";
/** Machine reads require a scoped bearer grant, never a browser session. */
@Controller("v1/deploys")
export class DeploymentWatchController {
  constructor(private readonly http: DeploymentWatchHttp) {}
  @Get(":id/watch")
  async read(
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const result = await this.http.read(id, req.headers.authorization);
    if (result.status === 429 || result.status === 503)
      res.setHeader("Retry-After", "1");
    res.status(result.status).json(result.body);
  }
}
