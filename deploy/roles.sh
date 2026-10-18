#!/bin/sh
# Invoked by the PostgreSQL image only for an empty data volume.
set -eu
export ESCALATOR_MIGRATOR_PASSWORD="$(cat /run/secrets/migrator_password)"
export ESCALATOR_APP_PASSWORD="$(cat /run/secrets/app_password)"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password ESCALATOR_MIGRATOR_PASSWORD
\getenv app_password ESCALATOR_APP_PASSWORD
BEGIN;
CREATE ROLE escalator_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD :'migration_password';
CREATE ROLE escalator_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'app_password';
REVOKE ALL ON DATABASE escalator FROM PUBLIC;
GRANT CONNECT ON DATABASE escalator TO escalator_migrate, escalator_app;
ALTER SCHEMA public OWNER TO escalator_migrate;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO escalator_app;
COMMIT;
SQL
unset ESCALATOR_MIGRATOR_PASSWORD ESCALATOR_APP_PASSWORD
