import { useState } from "react";
import type { PagingSettingsClient } from "../settings-client.js";
import { ContactsScreen } from "./ContactsScreen.js";
import { ManagementScreen } from "./ManagementScreen.js";
import { styles } from "../incidents/styles.js";
export function SettingsScreen({
  client,
  canManage,
  t,
}: {
  client: PagingSettingsClient;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const [view, setView] = useState<"contacts" | "policies" | "availability">(
    "contacts",
  );
  return (
    <section>
      <nav aria-label={t("settings.heading")}>
        {(["contacts", "policies", "availability"] as const).map((tab) => (
          <button
            key={tab}
            style={styles.button}
            aria-pressed={view === tab}
            onClick={() => setView(tab)}
          >
            {t(
              tab === "contacts"
                ? "settings.contacts"
                : tab === "policies"
                  ? "policy.heading"
                  : "availability.heading",
            )}
          </button>
        ))}
      </nav>
      {view === "contacts" ? (
        <ContactsScreen client={client} canManage={canManage} t={t} />
      ) : (
        <ManagementScreen
          key={view}
          mode={view}
          client={client}
          canManage={canManage}
          t={t}
        />
      )}
    </section>
  );
}
