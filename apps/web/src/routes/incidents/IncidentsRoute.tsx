import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { IncidentsScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { incidentsClient } from "./incidents-client.js";
export function IncidentsRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const incidents = useMemo(() => incidentsClient(client), [client]);
  return (
    <IncidentsScreen
      key={user.id}
      client={incidents}
      canCreate={hasCapability(user.role, "incident:create")}
      canResolve={hasCapability(user.role, "incident:resolve")}
      canManageEnvironment={hasCapability(user.role, "service:manage")}
      t={(key) => t(key)}
    />
  );
}
