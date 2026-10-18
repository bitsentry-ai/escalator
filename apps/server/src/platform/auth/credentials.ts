import { randomBytes, createHash } from "node:crypto";
import { argon2id, hash, verify as verifyPassword } from "argon2";
import { generateSecret, generateURI, verify as verifyOtp } from "otplib";

export class AuthenticationError extends Error {
  readonly code = "authentication_failed";
  constructor() {
    super("Authentication failed");
  }
}
/** Host-only adapters. Password hashing and OTP algorithms belong to reviewed libraries. */
export class PasswordHasher {
  private active = 0;
  constructor(private readonly maximumConcurrent = 2) {
    if (
      !Number.isInteger(maximumConcurrent) ||
      maximumConcurrent < 1 ||
      maximumConcurrent > 8
    )
      throw new Error("Invalid password hashing concurrency");
  }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximumConcurrent) throw new AuthenticationError();
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
  async create(password: string): Promise<string> {
    if (
      Buffer.byteLength(password, "utf8") > 1024 ||
      Array.from(password).length < 12
    )
      throw new Error(
        "Password must contain at least 12 characters and at most 1024 bytes",
      );
    return this.bounded(() =>
      hash(password, {
        type: argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 1,
      }),
    );
  }
  async matches(encoded: string, password: string): Promise<boolean> {
    if (!password || Buffer.byteLength(password, "utf8") > 1024) return false;
    return this.bounded(async () => {
      try {
        return await verifyPassword(encoded, password);
      } catch {
        return false;
      }
    });
  }
}
/** Raw tokens are returned once to the operator/user; only their digest is persisted. */
export function issueToken(): { value: string; digest: string } {
  const value = randomBytes(32).toString("base64url");
  return { value, digest: tokenDigest(value) };
}
export function tokenDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function newTotpEnrollment(login: string) {
  const secret = generateSecret({ length: 20 });
  return {
    secret,
    uri: generateURI({
      secret,
      issuer: "Escalator",
      label: login,
      algorithm: "sha1",
      digits: 6,
      period: 30,
    }),
  };
}
/** Caller must atomically persist the matched step before granting access. */
export async function verifyTotp(
  secret: string,
  token: string,
  epochSeconds: number,
  lastStep?: number,
): Promise<number | undefined> {
  if (!/^\d{6}$/.test(token)) return undefined;
  try {
    const result = await verifyOtp({
      secret,
      token,
      strategy: "totp",
      algorithm: "sha1",
      digits: 6,
      period: 30,
      epoch: epochSeconds,
      epochTolerance: 30,
      afterTimeStep: lastStep,
    });
    return result.valid && "timeStep" in result ? result.timeStep : undefined;
  } catch {
    return undefined;
  }
}
