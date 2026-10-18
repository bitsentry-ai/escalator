import { readFileSync } from "node:fs";
import {
  Controller,
  Get,
  Post,
  Param,
  Headers,
  Res,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import type { Response } from "express";
import {
  AcknowledgementHttp,
  acknowledgementHeaders,
  acknowledgementHtml,
} from "@bitsentry-escalator/features/application";
/** Public capability surface; GET never acknowledges and cookies confer no authority. */
@Controller({ path: "ack", version: VERSION_NEUTRAL })
export class EscalatorAcknowledgementController {
  private readonly script = readFileSync(
    require.resolve("@bitsentry-escalator/features/ack-assets"),
    "utf8",
  );
  constructor(private readonly http: AcknowledgementHttp) {}
  @Get(["assets/client.js", ":workspaceId/assets/client.js"])
  asset(@Res() response: Response) {
    response
      .set(acknowledgementHeaders)
      .type("application/javascript")
      .send(this.script);
  }
  @Get(":workspaceId")
  view(@Res() response: Response) {
    response.set(acknowledgementHeaders).type("html").send(acknowledgementHtml);
  }
  @Get(":workspaceId/state")
  preview(
    @Param("workspaceId") scope: string,
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.set(acknowledgementHeaders);
    return this.http.execute("GET", scope, authorization);
  }
  @Post(":workspaceId/state")
  acknowledge(
    @Param("workspaceId") scope: string,
    @Headers("authorization") authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.set(acknowledgementHeaders);
    return this.http.execute("POST", scope, authorization);
  }
}
