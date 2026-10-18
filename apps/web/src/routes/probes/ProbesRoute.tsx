import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { ProbesScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { probesClient } from "./probes-client.js";
export function ProbesRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const probes = useMemo(() => probesClient(client), [client]);
  return (
    <ProbesScreen
      key={user.id}
      client={probes}
      canManage={hasCapability(user.role, "service:manage")}
      t={(key) => t(key)}
    />
  );
}
