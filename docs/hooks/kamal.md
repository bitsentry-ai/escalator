# Kamal

Use extensionless executable `.kamal/hooks/pre-deploy` and `.kamal/hooks/post-deploy` files. Kamal aborts a command when a hook exits nonzero. Its pre-deploy hook is intended for final checks; post-deploy follows deployment, redeployment or rollback. See the official [hook overview](https://kamal-deploy.org/docs/hooks/overview/), [pre-deploy](https://kamal-deploy.org/docs/hooks/pre-deploy/) and [post-deploy](https://kamal-deploy.org/docs/hooks/post-deploy/) documentation, checked against Kamal 2.12 on 2026-10-05.

Complete the [common configuration](README.md). Copy both client files to `ops/escalator/` in the application repository. Preserve any existing hooks by calling this code from them; do not replace existing checks.

Before each new Kamal invocation, create an attempt identity and private state directory. Keep the same values when recovering an interrupted invocation:

```sh
export ESCALATOR_RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
escalator_state_dir="$(mktemp -d "${TMPDIR:-/tmp}/escalator-kamal.XXXXXX")"
export ESCALATOR_STATE="$escalator_state_dir/session.json"
# ESCALATOR_URL, TOKEN and ENVIRONMENT come from the trusted deployment configuration.
```

`.kamal/hooks/pre-deploy`:

```sh
#!/bin/sh
set -eu
export ESCALATOR_SOURCE=kamal
export ESCALATOR_ACTOR="${KAMAL_PERFORMER:?}"
export ESCALATOR_COMMIT="${KAMAL_VERSION:?}"
node ./ops/escalator/hook.mjs begin
```

`.kamal/hooks/post-deploy`:

```sh
#!/bin/sh
set -eu
node ./ops/escalator/hook.mjs finish SUCCEEDED
```

Make these hooks executable in the deployment repository. Run your normal Kamal command with the configuration exported above. A blocked preflight or failed start submission must stop before application boot. Restrict production deployment to this hooked path; bypassing hooks also bypasses the coverage gate.

Kamal does not provide a failure hook in the cited hook list. Do not invent one or send success from an unconditional cleanup trap. If the process fails or disappears after the start, preserve the state and let the durable timeout report the unconfirmed deployment. After independently confirming the actual terminal outcome, retry the original finish or explicitly run `finish FAILED`/`finish CANCELLED`. A failed post-deploy reporting call may occur after the application deployed successfully; it is not a reason to claim a failed release or to roll it back automatically.

## Manual check, not runtime-verified

Use a disposable application and run all common verification cases. Additionally, force a pre-deploy rejection and confirm no application boot occurs; fail the deployment after start and confirm no successful post-deploy event; then simulate a successful application deployment whose finish request times out and recover using the same state. Exercise redeploy and rollback as separate attempt IDs and confirm their version is the `KAMAL_VERSION` being deployed.
