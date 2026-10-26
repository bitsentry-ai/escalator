import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  hkdfSync,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";

export interface SecretIdentity {
  workspaceId: string;
  id: string;
}
export interface SecretEnvelope {
  version: 1;
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}
const MAX_SECRET_BYTES = 65_536;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid secret key configuration");
  return value as Record<string, unknown>;
}
function decode(value: unknown, length?: number): Buffer {
  if (typeof value !== "string")
    throw new Error("Invalid encrypted secret encoding");
  if (length !== undefined && value.length !== 4 * Math.ceil(length / 3))
    throw new Error("Invalid encrypted secret encoding");
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (length !== undefined && decoded.length !== length)
  ) {
    decoded.fill(0);
    throw new Error("Invalid encrypted secret encoding");
  }
  return decoded;
}
/** Master keys stay private; callers receive envelopes or purpose-derived cookie keys. */
export class SecretKeyRing {
  private constructor(
    private readonly keys: Map<string, Buffer>,
    readonly activeKeyId: string,
  ) {}
  static parse(raw: unknown): SecretKeyRing {
    const input = object(raw);
    if (
      input.version !== 1 ||
      typeof input.activeKeyId !== "string" ||
      !keyIdPattern.test(input.activeKeyId)
    )
      throw new Error("Invalid secret key configuration");
    const entries = Object.entries(object(input.keys));
    if (entries.length < 1 || entries.length > 16)
      throw new Error("Expected 1–16 secret encryption keys");
    const keys = new Map<string, Buffer>();
    try {
      for (const [id, value] of entries) {
        if (!keyIdPattern.test(id))
          throw new Error("Invalid secret key identifier");
        keys.set(id, decode(value, 32));
      }
      if (!keys.has(input.activeKeyId))
        throw new Error("Active secret encryption key is missing");
      return new SecretKeyRing(keys, input.activeKeyId);
    } catch {
      for (const key of keys.values()) key.fill(0);
      throw new Error("Invalid secret encryption key configuration");
    }
  }
  /** Operator-mounted JSON, outside the database volume. Missing key is fatal. */
  static fromFile(file: string | undefined): SecretKeyRing {
    if (!file || !isAbsolute(file))
      throw new Error(
        "ESCALATOR_SECRET_KEY_FILE must name an absolute mounted key file",
      );
    let descriptor: number | undefined;
    let bytes: Buffer | undefined;
    try {
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0)
        throw new Error(
          "Mounted key file must be private (0400/0600) and at most 16 KiB",
        );
      bytes = readFileSync(descriptor);
      return SecretKeyRing.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new Error(
        "Unable to load ESCALATOR_SECRET_KEY_FILE: require valid version-1 JSON and a private mounted file",
      );
    } finally {
      bytes?.fill(0);
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  /** Purpose-separated cookie keys; retain historical keys for existing signed sessions. */
  sessionSigningKeys(workspaceId: string): string[] {
    if (!workspaceId) throw new Error("Session workspace is required");
    const order = [this.activeKeyId, ...this.keys.keys()].filter(
      (id, index, ids) => ids.indexOf(id) === index,
    );
    return order.map((id) =>
      Buffer.from(
        hkdfSync(
          "sha256",
          this.key(id),
          Buffer.from(workspaceId),
          Buffer.from("bitsentry-escalator/session-signing/v1"),
          32,
        ),
      ).toString("base64url"),
    );
  }
  /** The active key and every listed key are loaded together, so a missing one means the ring is corrupt. */
  private key(id: string): Buffer {
    const key = this.keys.get(id);
    if (!key) throw new Error("Required secret encryption key is unavailable");
    return key;
  }
  private aad(identity: SecretIdentity, keyId: string): Buffer {
    if (!identity.workspaceId || !identity.id)
      throw new Error("Secret identity is required");
    return Buffer.from(
      JSON.stringify([1, identity.workspaceId, identity.id, keyId]),
      "utf8",
    );
  }
  seal(identity: SecretIdentity, value: Uint8Array): SecretEnvelope {
    if (value.byteLength < 1 || value.byteLength > MAX_SECRET_BYTES)
      throw new Error("Secret must contain 1–65536 bytes");
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.key(this.activeKeyId),
      nonce,
      { authTagLength: 16 },
    );
    cipher.setAAD(this.aad(identity, this.activeKeyId));
    const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
    return {
      version: 1,
      keyId: this.activeKeyId,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }
  open(identity: SecretIdentity, envelope: SecretEnvelope): Buffer {
    if (
      envelope.version !== 1 ||
      typeof envelope.keyId !== "string" ||
      !keyIdPattern.test(envelope.keyId)
    )
      throw new Error("Unsupported encrypted secret envelope");
    const key = this.keys.get(envelope.keyId);
    if (!key) throw new Error("Required secret decryption key is unavailable");
    const nonce = decode(envelope.nonce, 12);
    const tag = decode(envelope.tag, 16);
    if (
      typeof envelope.ciphertext !== "string" ||
      envelope.ciphertext.length > 87_384
    )
      throw new Error("Invalid encrypted secret size");
    const ciphertext = decode(envelope.ciphertext);
    if (ciphertext.length < 1 || ciphertext.length > MAX_SECRET_BYTES)
      throw new Error("Invalid encrypted secret size");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(this.aad(identity, envelope.keyId));
    decipher.setAuthTag(tag);
    let provisional: Buffer | undefined;
    try {
      provisional = decipher.update(ciphertext);
      const tail = decipher.final(); // Authenticate before releasing any plaintext.
      return Buffer.concat([provisional, tail]);
    } catch {
      throw new Error("Encrypted secret authentication failed");
    } finally {
      provisional?.fill(0);
    }
  }
}
