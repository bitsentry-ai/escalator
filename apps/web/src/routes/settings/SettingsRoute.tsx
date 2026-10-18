import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { SettingsScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { settingsClient } from "./settings-client.js";
export function SettingsRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const settings = useMemo(() => settingsClient(client), [client]);
  return (
    <SettingsScreen
      key={user.id}
      client={settings}
      canManage={hasCapability(user.role, "schedule:manage")}
      t={(key) => t(key)}
    />
  );
}
