import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { MetricsScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { metricsClient } from "./metrics-client.js";
export function MetricsRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const metrics = useMemo(() => metricsClient(client), [client]);
  return (
    <MetricsScreen
      key={user.id}
      client={metrics}
      canManage={hasCapability(user.role, "service:manage")}
      t={(key) => t(key)}
    />
  );
}
