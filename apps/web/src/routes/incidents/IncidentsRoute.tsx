import { rulesClient } from "../rules/rules-client.js";
import { labelsClient } from "../labels/labels-client.js";
import { investigationReportsClient } from "../investigation/investigation-reports-client.js";
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
  const rules = useMemo(() => rulesClient(client), [client]);
  const labels = useMemo(() => labelsClient(client), [client]);
  const reports = useMemo(() => investigationReportsClient(client), [client]);
  return (
    <IncidentsScreen
      key={user.id}
      client={incidents}
      reports={reports}
      labels={labels}
      rules={rules}
      canCreate={hasCapability(user.role, "incident:create")}
      canResolve={hasCapability(user.role, "incident:resolve")}
      canManageEnvironment={hasCapability(user.role, "service:manage")}
      t={(key) => t(key)}
    />
  );
}
