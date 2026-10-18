import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { OnCallScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { oncallClient } from "./oncall-client.js";
export function OnCallRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const oncall = useMemo(() => oncallClient(client), [client]);
  return (
    <OnCallScreen
      key={user.id}
      client={oncall}
      canManage={hasCapability(user.role, "schedule:manage")}
      t={(key) => t(key)}
    />
  );
}
