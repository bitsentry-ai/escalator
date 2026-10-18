import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { LabelsScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { labelsClient } from "./labels-client.js";
export function LabelsRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const labels = useMemo(() => labelsClient(client), [client]);
  return (
    <LabelsScreen
      key={user.id}
      client={labels}
      canLabel={hasCapability(user.role, "incident:resolve")}
      t={(key) => t(key)}
    />
  );
}
