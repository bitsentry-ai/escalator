# Dokploy installation

Documentation reviewed 2026-10-08. Manual deployment: **not runtime-verified**.

Use a Docker Compose resource with the standalone workspace as its build context,
or reference an image digest built from that context. Review the generated
composition before starting anything. Do not use Docker Swarm/Stack instructions
with a local `build` stanza; this recipe targets ordinary Compose.

Provision the database volume and private key/operator files persistently. Replace
checkout-relative secret binds with explicit persistent paths on the target host.
Supply `app.env` privately, preserve separate restricted and migration roles, and
perform the common database migration/grants/bootstrap steps before starting the
app. Set its HTTPS public origin and the correct proxy-hop count.

In Domains, target service `app` on internal port `3000`. Use Preview Compose to
inspect the platform's injected labels and networks. Prefer an isolated deployment
network and confirm the app and PostgreSQL retain private connectivity. Do not
publish PostgreSQL or attach it to a broad shared proxy network merely to repair
service discovery. Remove the development localhost port binding if unnecessary
for proxy routing.

Run the common verification checklist, including login, a designated test incident,
authenticated readiness failure and independent watchdog alert. Record Dokploy
version, generated Compose, image digest and verification date. Follow the paging
handoff procedure for replacement or rollback; an application restart is not proof
that pending notifications were safely handled.

Provider behavior was checked against
[Dokploy's Compose domain documentation](https://docs.dokploy.com/docs/core/docker-compose/domains).
No platform resource, server or workflow was started during this implementation.
