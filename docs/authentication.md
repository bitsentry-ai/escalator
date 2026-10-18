# Standalone authentication implementation

## Dependency decision D4

The standalone NestJS/Express host uses these pinned libraries:

| Concern          | Library                  | Integration                                                           |
| ---------------- | ------------------------ | --------------------------------------------------------------------- |
| Password hashing | `argon2` 0.45.1          | Argon2id; explicit 64 MiB, three iterations, one lane                 |
| Sessions         | `express-session` 1.19.0 | Server-side state through a host PostgreSQL Store                     |
| Optional TOTP    | `otplib` 13.5.0          | Six digits, 30-second period, explicit lowercase SHA-1 algorithm name |

The server also declares `zod` 4.3.6 directly for its authentication input
schemas, matching the feature package version.

These libraries support the host's CommonJS output and local accounts without
email delivery. Password hashing and OTP computation use library implementations.
The native Argon2 package loaded and passed hash/verification tests on Node 22.14;
container and other-platform native loading are not runtime-verified.

[Argon2's API and prebuilt-binary documentation](https://github.com/ranisalt/node-argon2/blob/master/README.md)
describes its hash/verify functions and installation requirements.
[Express session documentation](https://expressjs.com/en/resources/middleware/session/)
provides the persistent-store contract and session regeneration API. Its default
MemoryStore is unsuitable for deployment; application composition must supply
PostgreSQL persistence.
[otplib's verification API](https://otplib.yeojz.dev/api/@otplib/totp/functions/verify.html)
returns a matched time step, which the host must consume atomically to prevent
replay. All of these dependencies remain inside the standalone workspace.

## Delivery status

This part installs dependencies and verifies their CommonJS interfaces. It does
not activate login, sessions or TOTP routes. Following parts supply scoped
persistence, one-use bootstrap and invitations, session revocation, CSRF checks,
rate limiting, TOTP/recovery-code handling, and the standalone screens.
Encrypted TOTP material must participate in the existing key-rotation procedure.
PostgreSQL conformance will remain explicitly not runtime-verified until a
separate disposable test database is provided; tests never use the application's
connection string as a fallback.
