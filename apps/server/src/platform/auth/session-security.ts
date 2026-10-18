import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler, Request } from "express";
import session from "express-session";
import type { AccountProof } from "./auth.repository.js";
declare module "express-session" {
  interface SessionData {
    account?: AccountProof;
    csrf?: string;
  }
}
export function csrfToken(request: Request): string {
  return (request.session.csrf ??= randomBytes(32).toString("base64url"));
}
export function cookieOriginGuard(origin: string): RequestHandler {
  return (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const source = request.headers.origin;
    if (
      (source && source !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      const token = request.headers["x-escalator-csrf"];
      const expected = request.session.csrf;
      if (
        source !== origin ||
        typeof token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        !expected ||
        token.length !== expected.length ||
        !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      ) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
    }
    next();
  };
}
export function sessionOptions(
  origin: URL,
  secrets: string[],
  store: session.Store,
): session.SessionOptions {
  const secure = origin.protocol === "https:";
  if (
    !secure &&
    !(
      origin.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
  )
    throw new Error("Public URL requires HTTPS");
  if (!secrets.length || secrets.some((secret) => secret.length < 43))
    throw new Error("Session signing keys are required");
  return {
    name: secure ? "__Host-escalator" : "escalator",
    secret: secrets,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/",
      maxAge: 8 * 3600000,
    },
  };
}
export async function saveSession(request: Request): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    request.session.save((error) => (error ? reject(error) : resolve())),
  );
}
export async function resetSession(request: Request): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    request.session.regenerate((error) => (error ? reject(error) : resolve())),
  );
}
export async function establishSession(
  request: Request,
  account: AccountProof,
): Promise<void> {
  await resetSession(request);
  request.session.account = account;
  csrfToken(request);
  await saveSession(request);
}
export async function destroySession(request: Request): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    request.session.destroy((error) => (error ? reject(error) : resolve())),
  );
}
