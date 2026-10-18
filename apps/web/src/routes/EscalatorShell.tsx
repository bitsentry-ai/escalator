import { DeploymentsRoute } from "./deployments/DeploymentsRoute.js";
import { RetentionRoute } from "./retention/RetentionRoute.js";
import { MetricsRoute } from "./metrics/MetricsRoute.js";
import { HeartbeatsRoute } from "./heartbeats/HeartbeatsRoute.js";
import { SourcesRoute } from "./sources/SourcesRoute.js";
import { ProbesRoute } from "./probes/ProbesRoute.js";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LocalAuthClient, LocalUser } from "../auth/auth-client.js";
import { ServicesRoute } from "./services/ServicesRoute.js";
import { IncidentsRoute } from "./incidents/IncidentsRoute.js";
import { OnCallRoute } from "./oncall/OnCallRoute.js";
import { SettingsRoute } from "./settings/SettingsRoute.js";
export function EscalatorShell({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const [view, setView] = useState<
    | "services"
    | "incidents"
    | "oncall"
    | "contacts"
    | "probes"
    | "sources"
    | "heartbeats"
    | "metrics"
    | "retention"
    | "deployments"
  >("services");
  return (
    <>
      <nav aria-label={t("title")}>
        <button
          aria-pressed={view === "services"}
          onClick={() => setView("services")}
        >
          {t("services.title")}
        </button>
        <button
          aria-pressed={view === "incidents"}
          onClick={() => setView("incidents")}
        >
          {t("incidents.heading")}
        </button>
        <button
          aria-pressed={view === "oncall"}
          onClick={() => setView("oncall")}
        >
          {t("oncall.heading")}
        </button>
        <button
          aria-pressed={view === "contacts"}
          onClick={() => setView("contacts")}
        >
          {t("settings.heading")}
        </button>
        <button
          aria-pressed={view === "probes"}
          onClick={() => setView("probes")}
        >
          {t("probes.heading")}
        </button>
        <button
          aria-pressed={view === "sources"}
          onClick={() => setView("sources")}
        >
          {t("sources.heading")}
        </button>
        <button
          aria-pressed={view === "heartbeats"}
          onClick={() => setView("heartbeats")}
        >
          {t("heartbeats.heading")}
        </button>
        <button
          aria-pressed={view === "metrics"}
          onClick={() => setView("metrics")}
        >
          {t("metrics.heading")}
        </button>
        <button
          aria-pressed={view === "deployments"}
          onClick={() => setView("deployments")}
        >
          {t("deployments.heading")}
        </button>
        <button
          aria-pressed={view === "retention"}
          onClick={() => setView("retention")}
        >
          {t("retention.heading")}
        </button>
      </nav>
      {view === "services" ? (
        <ServicesRoute client={client} user={user} />
      ) : view === "sources" ? (
        <SourcesRoute client={client} user={user} />
      ) : view === "heartbeats" ? (
        <HeartbeatsRoute client={client} user={user} />
      ) : view === "deployments" ? (
        <DeploymentsRoute client={client} user={user} />
      ) : view === "retention" ? (
        <RetentionRoute client={client} user={user} />
      ) : view === "metrics" ? (
        <MetricsRoute client={client} user={user} />
      ) : view === "probes" ? (
        <ProbesRoute client={client} user={user} />
      ) : view === "contacts" ? (
        <SettingsRoute client={client} user={user} />
      ) : view === "oncall" ? (
        <OnCallRoute client={client} user={user} />
      ) : (
        <IncidentsRoute client={client} user={user} />
      )}
    </>
  );
}
