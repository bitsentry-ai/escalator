# Kamal accessory installation

Documentation reviewed 2026-10-08 against Kamal 2.12 documentation. Manual
installation: **not runtime-verified**. This is an accessory fragment for an
existing operator-managed Kamal deployment, not a new Dashboard worker runtime.

Build the isolated app image and publish it to your own registry before using
this procedure. Replace the image/host/domain placeholders in the fragment with
an immutable image reference and the intended server. Keep PostgreSQL on the same
private accessory network, and supply the app's restricted database URL through
Kamal's secret environment mechanism. The database must already have the complete
migration chain, restricted grants and operator bootstrap applied before app boot.

Boot only the `escalator-db` accessory first. Its empty-volume initialization
creates separate roles from private password files; existing volumes are never
reinitialized. Adjust the local `roles.sh` path for an extracted workspace. Apply
migrations and grants explicitly, then verify private connectivity using the
actual accessory container name in the restricted database URL. Application
migrations do not run automatically. Never point a fresh accessory at a live
paging database while an unfenced old dispatcher is still running.

Store the encryption key and operator directory outside version control. The
example file ownership requires root access on the host; verify UID 1000 can read
the owner-only key and write the private operator directory. Keep these assets
across accessory replacement. Configure a single trusted proxy hop only when that
matches the actual request path.

Kamal accessories are managed independently of the main service and do not provide
zero-downtime replacement. Use the operations handoff before `accessory` lifecycle
commands, and inspect `kamal accessory --help` for the installed version. The proxy
uses `/health/live` only to recognize a listening process; authenticated readiness
and the external watchdog remain separate release gates. Do not interpret the
proxy's deployment health check as continuous operational monitoring.

After authorized installation, record the installed Kamal version, rendered
configuration, image digest and outcomes of the common verification checklist.
See the official [accessory configuration](https://kamal-deploy.org/docs/configuration/accessories/)
and [proxy configuration](https://kamal-deploy.org/docs/configuration/proxy/).
