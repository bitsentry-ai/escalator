import express, { type Express } from "express";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
/** API misses must remain API misses; only browser document requests get the shell. */
export function isShellRequest(
  method: string,
  path: string,
  accept: string | undefined,
): boolean {
  return (
    ["GET", "HEAD"].includes(method) &&
    path === "/" &&
    accept
      ?.split(",")
      .some((value) => value.trim().split(";")[0] === "text/html") === true
  );
}
export async function mountStaticWeb(
  app: Express,
  directory: string,
): Promise<void> {
  const root = resolve(directory),
    index = resolve(root, "index.html");
  if (!(await stat(index)).isFile())
    throw new Error("Web build is unavailable");
  const assets = express.static(root, {
    index: false,
    dotfiles: "deny",
    redirect: false,
    fallthrough: true,
    setHeaders(response, file) {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader(
        "Cache-Control",
        file.includes(`${root}/assets/`)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    },
  });
  app.use((request, response, next) => {
    if (/^\/(?:trpc|v1|health|ack)(?:\/|$)/i.test(request.path)) return next();
    assets(request, response, next);
  });
  app.use((request, response, next) => {
    if (!isShellRequest(request.method, request.path, request.headers.accept))
      return next();
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.sendFile(index, (error) => {
      if (error) next(error);
    });
  });
}
