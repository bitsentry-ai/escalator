import { Controller, Post, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  ProviderHttp,
  type ProviderRoute,
} from "@bitsentry-escalator/features/application";

/** Provider authentication is performed by shared intake, never cookie sessions. */
@Controller("v1/ingest/providers")
export class ProviderIngestController {
  constructor(private readonly http: ProviderHttp) {}
  @Post(":provider/:reference")
  async accept(
    @Param("provider") provider: ProviderRoute,
    @Param("reference") reference: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const body: unknown = req.body;
    delete req.body;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!Buffer.isBuffer(body)) {
      res.status(503).json({ error: "unavailable" });
      return;
    }
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", abort);
    res.once("close", abort);
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref();
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    try {
      const result = await this.http.accept({
        provider,
        reference,
        body,
        signal: controller.signal,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        signature: header(
          provider === "sentry"
            ? "sentry-hook-signature"
            : "x-grafana-alerting-signature",
        ),
        timestamp: header("x-grafana-alerting-timestamp"),
      });
      if (!res.destroyed) res.status(result.status).json(result.body);
    } finally {
      body.fill(0);
      clearTimeout(timer);
      req.off("aborted", abort);
      res.off("close", abort);
    }
  }
}
