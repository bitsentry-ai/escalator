import { Controller, Post, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { DeploymentHttp } from "@bitsentry-escalator/features/application";
/** Machine grants are independent of browser sessions. */
@Controller("v1/deploys")
export class DeploymentController {
  constructor(private readonly http: DeploymentHttp) {}
  @Post("start")
  start(@Req() req: Request, @Res() res: Response) {
    return this.accept("start", null, req, res);
  }
  @Post(":id/finish")
  finish(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    return this.accept("finish", id, req, res);
  }
  @Post("preflight")
  preflight(@Req() req: Request, @Res() res: Response) {
    return this.accept("preflight", null, req, res);
  }
  private async accept(
    action: "start" | "finish" | "preflight",
    id: string | null,
    req: Request,
    res: Response,
  ) {
    const body: unknown = req.body;
    delete req.body;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!Buffer.isBuffer(body)) {
      res.status(503).json({ error: "unavailable" });
      return;
    }
    const key = req.headers["idempotency-key"];
    const request = {
      body,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      idempotencyKey: typeof key === "string" ? key : undefined,
    };
    const result =
      action === "preflight"
        ? await this.http.preflight(request)
        : action === "start"
          ? await this.http.start(request)
          : await this.http.finish(id!, request);
    if (result.status === 429 || result.status === 503)
      res.setHeader("Retry-After", "1");
    res.status(result.status).json(result.body);
  }
}
