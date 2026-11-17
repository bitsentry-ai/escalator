import { RulesRoute } from "./rules/RulesRoute.js";
import { LabelsRoute } from "./labels/LabelsRoute.js";
import { InvestigationSettingsRoute } from "./investigation/InvestigationSettingsRoute.js";
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
type ShellView =
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
  | "investigation"
  | "labels"
  | "rules";
function ShellRoute({
  view,
  client,
  user,
}: {
  view: ShellView;
  client: LocalAuthClient;
  user: LocalUser;
}) {
  switch (view) {
    case "services":
      return <ServicesRoute client={client} user={user} />;
    case "sources":
      return <SourcesRoute client={client} user={user} />;
    case "heartbeats":
      return <HeartbeatsRoute client={client} user={user} />;
    case "rules":
      return <RulesRoute client={client} user={user} />;
    case "labels":
      return <LabelsRoute client={client} user={user} />;
    case "investigation":
      return <InvestigationSettingsRoute client={client} user={user} />;
    case "deployments":
      return <DeploymentsRoute client={client} user={user} />;
    case "retention":
      return <RetentionRoute client={client} user={user} />;
    case "metrics":
      return <MetricsRoute client={client} user={user} />;
    case "probes":
      return <ProbesRoute client={client} user={user} />;
    case "contacts":
      return <SettingsRoute client={client} user={user} />;
    case "oncall":
      return <OnCallRoute client={client} user={user} />;
    default:
      return <IncidentsRoute client={client} user={user} />;
  }
}
export function EscalatorShell({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const [view, setView] = useState<ShellView>("services");
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
        <button
          aria-pressed={view === "investigation"}
          onClick={() => setView("investigation")}
        >
          {t("investigationSettings.heading")}
        </button>
        <button
          aria-pressed={view === "labels"}
          onClick={() => setView("labels")}
        >
          {t("labels.heading")}
        </button>
        <button
          aria-pressed={view === "rules"}
          onClick={() => setView("rules")}
        >
          {t("rules.heading")}
        </button>
      </nav>
      <ShellRoute view={view} client={client} user={user} />
    </>
  );
}
