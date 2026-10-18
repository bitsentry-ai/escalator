import { deploymentSettingsClient } from "./deployment-settings-client.js";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { DeploymentsScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { deploymentsClient } from "./deployments-client.js";
import { incidentsClient } from "../incidents/incidents-client.js";
export function DeploymentsRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const deployments = useMemo(() => deploymentsClient(client), [client]);
  const settings = useMemo(() => deploymentSettingsClient(client), [client]);
  const incidents = useMemo(() => incidentsClient(client), [client]);
  return (
    <DeploymentsScreen
      key={user.id}
      client={deployments}
      settings={settings}
      canManage={hasCapability(user.role, "service:manage")}
      pagingAvailable={true}
      incidents={incidents}
      canResolve={hasCapability(user.role, "incident:resolve")}
      t={(key) => t(key)}
    />
  );
}
