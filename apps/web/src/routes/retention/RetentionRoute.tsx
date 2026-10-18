import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { RetentionScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { retentionClient } from "./retention-client.js";
export function RetentionRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const retention = useMemo(() => retentionClient(client), [client]);
  return (
    <RetentionScreen
      key={user.id}
      client={retention}
      canManage={hasCapability(user.role, "service:manage")}
      t={(key) => t(key)}
    />
  );
}
