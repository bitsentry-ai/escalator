import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import { HeartbeatsScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { heartbeatsClient } from "./heartbeats-client.js";
export function HeartbeatsRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const heartbeats = useMemo(() => heartbeatsClient(client), [client]);
  return (
    <HeartbeatsScreen
      key={user.id}
      client={heartbeats}
      canManage={hasCapability(user.role, "service:manage")}
      t={(key) => t(key)}
    />
  );
}
