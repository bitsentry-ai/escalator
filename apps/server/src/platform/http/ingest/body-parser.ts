import { raw, type RequestHandler } from "express";
import { SIGNAL_INGRESS_MAX_BYTES } from "@bitsentry-escalator/features/contracts";
function bodyErrorCode(status: number | undefined): string {
  if (status === 413) return "body_too_large";
  if (status === 415) return "unsupported_content_type";
  return "invalid_input";
}
/** Install before any broad JSON parser. Raw bytes are bounded before parsing. */
export function signalBodyParser(
  limit = SIGNAL_INGRESS_MAX_BYTES,
): RequestHandler {
  const read = raw({
    limit,
    inflate: false,
    type: () => true,
  });
  return (req, res, next) => {
    if (req.method !== "POST") return next();
    // Slow or unfinished bodies must not retain a connection indefinitely.
    const timer = setTimeout(() => req.destroy(), 10_000);
    timer.unref();
    const clear = () => {
      clearTimeout(timer);
      req.off("close", clear);
      res.off("close", clear);
    };
    req.once("close", clear);
    res.once("close", clear);
    read(req, res, (error) => {
      clear();
      if (error) {
        if (res.headersSent || req.aborted) return;
        const status = (error as { status?: number }).status;
        const code = bodyErrorCode(status);
        res.setHeader("Cache-Control", "no-store");
        res
          .status(status === 413 || status === 415 ? status : 400)
          .json({ error: code });
        return;
      }
      // No framed body is still bounded input; let JSON validation reject it.
      if (req.body === undefined) req.body = Buffer.alloc(0);
      next();
    });
  };
}
