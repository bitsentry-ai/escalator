import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { hasCapability } from "@bitsentry-escalator/features/contracts";
import {
  ServicesScreen,
  type ServicesClient,
} from "@bitsentry-escalator/features/ui";
import { LocalAuthClient, type LocalUser } from "../../auth/auth-client.js";
export function ServicesRoute({
  client,
  user,
}: {
  client: LocalAuthClient;
  user: LocalUser;
}) {
  const { t } = useTranslation("escalator");
  const services = useMemo<ServicesClient>(
    () => ({
      listServices: (input) => client.query("services.list", input),
      createService: (input) => client.mutate("services.create", input),
      getService: (id) => client.query("services.get", id),
    }),
    [client],
  );
  return (
    <ServicesScreen
      key={user.id}
      client={services}
      canCreate={hasCapability(user.role, "service:manage")}
      t={(key) => t(key)}
    />
  );
}
