import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { InvestigationSettingsScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { investigationSettingsClient } from "./investigation-settings-client.js";
export function InvestigationSettingsRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const settings = useMemo(
    () =>
      investigationSettingsClient(
        client,
        hasCapability(user.role, "secret:manage"),
      ),
    [client, user.role],
  );
  return (
    <InvestigationSettingsScreen
      key={user.id}
      client={settings}
      canManage={hasCapability(user.role, "service:manage")}
      t={(key) => t(key)}
    />
  );
}
