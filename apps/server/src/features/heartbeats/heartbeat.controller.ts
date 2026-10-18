import { Controller, Post, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { HeartbeatHttp } from "@bitsentry-escalator/features/application";
/** Versioned machine ingress: bearer grants, never browser sessions. */
@Controller("v1/heartbeats")
export class HeartbeatIngestController {
  constructor(private readonly http: HeartbeatHttp) {}
  @Post(":probeId")
  async accept(
    @Param("probeId") probeId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const body: unknown = req.body;
    // Do not leave raw evidence attached to a request for later error reporting.
    delete req.body;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!Buffer.isBuffer(body)) {
      res.status(503).json({ error: "unavailable" });
      return;
    }
    const result = await this.http.accept({
      probeId,
      body,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
    });
    res.status(result.status).json(result.body);
  }
}
