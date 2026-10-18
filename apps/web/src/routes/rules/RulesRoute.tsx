import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RulesScreen } from "@bitsentry-escalator/features/ui";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
import { rulesClient } from "./rules-client.js";
export function RulesRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator"),
    rules = useMemo(() => rulesClient(client), [client]);
  return (
    <RulesScreen
      key={`${user.id}:${user.role}`}
      client={rules}
      t={(key) => t(key)}
    />
  );
}
