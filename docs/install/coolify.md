# Coolify installation

Documentation reviewed 2026-10-08. Manual deployment: **not runtime-verified**.
Use an authorized disposable deployment before relying on this recipe.

1. Select a Git-backed Docker Compose application. With the monorepo source, use
   `/apps/escalator` as Base Directory and `/compose.yaml` as Compose Location;
   an extracted standalone repository uses its root instead. Review the resulting
   Compose content before deployment.
2. Provision persistent PostgreSQL data and private operator/key files outside the
   replaceable Git checkout. Adapt the composition's relative file binds to those
   persistent paths. Keep the keyring readable only by the application UID and
   retain separate PostgreSQL/application/migration credentials. Do not replace the
   restricted application role with the PostgreSQL administrative account.
3. Supply the documented application environment through a persistent private
   `app.env` file, or explicitly map it to Coolify-managed environment references.
   Never commit that file. Set the exact HTTPS public origin and the trusted proxy
   hop count for the actual network path.
4. Start only the database initially, then perform the explicit migration, runtime
   grants and one-use administrator bootstrap from the common installation guide.
   The application image does not migrate its database automatically.
5. Configure the public domain for service `app`, internal port `3000`. Remove the
   localhost host-port mapping if the platform routes directly through its proxy.
   Keep PostgreSQL off public ports and preserve private app-to-database networking.
6. Deploy the app and complete the common verification checklist. The container's
   `/health/live` probe is only process liveness; configure authenticated readiness
   and an independent watchdog separately. Preserve their credentials privately.

Record Coolify version, image digest, Compose revision, storage mappings and actual
verification date. Disable unattended image replacement until the pending-page
handoff and rollback procedure is established. Application code and data never
need the Dashboard, WorkOS, Encore or Desktop checkout.

Provider-specific configuration follows the official
[Coolify Compose documentation](https://coolify.io/docs/applications/builds/docker-compose).
Deployment success, authentication, migrations and recovery are not established
by this documentation review.
