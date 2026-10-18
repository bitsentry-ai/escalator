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

Dependency support, persistence, login/MFA orchestration and operator commands
are implemented. Public login, session and TOTP routes are not active yet. The
following part adds CSRF checks, HTTP middleware registration and standalone screens.
Encrypted TOTP material must participate in the existing key-rotation procedure.
PostgreSQL conformance will remain explicitly not runtime-verified until a
separate disposable test database is provided; tests never use the application's
connection string as a fallback.

## Persistence foundation

The standalone migration adds scoped accounts, one-use registration/recovery
credentials, recovery-code hashes, sessions and rate buckets. Registration
consumes a token and creates its account, responder and audit entry in one
transaction. Invitation roles come from the stored token; caller-supplied scope
or privilege fields are rejected. Login names are normalized ASCII identifiers.
Password hashing runs outside persistence transactions and has a bounded number
of concurrent operations.

Session IDs are hashed at rest. PostgreSQL caps their lifetime at eight hours;
revocation leaves a tombstone so an in-flight save cannot recreate that ID.
Expiration and tombstone cleanup will be included in the operational retention
work. The encrypted-secret schema separates `authentication` and `provider`
purposes. Provider redemption explicitly accepts only `provider` secrets, while
key rotation covers both purposes.

This foundation is not yet registered as active authentication middleware or
public login routes. The subsequent flow and shell parts perform that wiring.
Run `pnpm --filter @bitsentry-escalator/server test` from this workspace for
library/validation tests and opt-in PostgreSQL scenarios. Database scenarios
require both dedicated test variables described in the README; without them,
the runner explicitly skips database cases. PostgreSQL migration, concurrent
registration, rate limiting and session persistence remain not runtime-verified.

## Login and MFA flows

The host limits attempts by IP before allocating per-account/token rate buckets.
Unknown logins perform a dummy password verification. After password work, the
security transaction locks the account and responder and checks the current
account version and enabled state before allowing access. Every authenticated
request must also recheck that version when HTTP composition is registered.

TOTP enrollment requires a current session plus the account password. Enrollment
expires after ten minutes, stores only encrypted authentication material, and
requires a valid code before activation. Activation returns ten random recovery
codes once and increments the account version. TOTP steps and recovery-code
hashes are consumed under the account lock; concurrent replay cannot grant two
logins. Disabling MFA requires the password plus a TOTP/recovery code and revokes
all previous account versions and unused codes. Key rotation includes TOTP keys.
Never include account password hashes or secret IDs in public session responses.

## Local operator procedure

These commands are delivered but have not been run against PostgreSQL. Apply the
standalone migrations first, retain the mounted secret keys, and configure
`ESCALATOR_DATABASE_URL`, `ESCALATOR_WORKSPACE_ID`, `ESCALATOR_SECRET_KEY_FILE` and
an absolute `ESCALATOR_AUTH_GRANT_FILE` inside a private operator directory.
The output path must not exist. `ESCALATOR_WORKSPACE_NAME` optionally names the
initial workspace. Run from `apps/escalator` after building:

```sh
pnpm --filter @bitsentry-escalator/server auth:operator bootstrap
pnpm --filter @bitsentry-escalator/server auth:operator recover local-login-name
```

Bootstrap creates or reissues the initial unused credential; it cannot replace
an existing account. Recovery immediately invalidates the account's existing
session versions and prior recovery grants. Both commands write a random,
fifteen-minute, one-use credential to a new mode-0600 file and store only its
SHA-256 digest. The CLI never prints it and accepts no password argument.
Retrieve the file locally, use the setup/recovery screen once that screen is
wired, then remove it. Recovery redemption replaces the password, disables old
MFA credentials, invalidates all prior sessions again, and requires fresh login.
Enable MFA again after recovery. No email service is needed. If issuance fails,
fix the configuration and retry with an unused output path; no credential is
printed in errors.

Run the server test command above for flow and operator-file unit tests. With the
explicit disposable database variables configured, the same suite additionally
checks MFA encryption, concurrent recovery-code consumption, expired enrollment,
disabling/re-enabling MFA and one-use operator recovery. Those PostgreSQL scenarios
remain not runtime-verified; the operator CLI was not executed against a database.
