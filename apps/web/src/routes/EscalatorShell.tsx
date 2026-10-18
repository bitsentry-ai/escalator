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
    "services" | "incidents" | "oncall" | "contacts"
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
      </nav>
      {view === "services" ? (
        <ServicesRoute client={client} user={user} />
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
