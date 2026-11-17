import { useState } from "react";
import type { DeploymentTarget } from "../../contracts/index.js";
import type { DeploymentSettingsClient } from "../deployment-settings-client.js";
import { TargetEditor } from "./TargetEditor.js";
import { GrantPanel } from "./GrantPanel.js";
import { styles } from "../incidents/styles.js";
export function TargetSetup({
  client,
  target,
  canActivate,
  onSaved,
  t,
}: {
  client: DeploymentSettingsClient;
  target?: DeploymentTarget;
  canActivate: boolean;
  onSaved: () => void;
  t: (key: string) => string;
}) {
  const [mode, setMode] = useState<"new" | "edit" | null>(null),
    [grants, setGrants] = useState(false);
  return (
    <section aria-label={t("deploymentSetup.heading")}>
      <h2>{t("deploymentSetup.heading")}</h2>
      <button
        type="button"
        style={styles.button}
        onClick={() => setMode("new")}
      >
        {t("deploymentSetup.create")}
      </button>
      {target && (
        <>
          <button
            type="button"
            style={styles.button}
            onClick={() => setMode("edit")}
          >
            {t("deploymentSetup.edit")}
          </button>
          <button
            type="button"
            style={styles.button}
            aria-expanded={grants}
            onClick={() => setGrants((value) => !value)}
          >
            {t("deploymentSetup.grants")}
          </button>
        </>
      )}
      {(mode === "new" || (mode === "edit" && target)) && (
        <TargetEditor
          key={
            mode === "edit" && target
              ? `${target.id}:${target.revision}`
              : "new"
          }
          client={client}
          initial={mode === "edit" ? target : undefined}
          canActivate={canActivate}
          onSaved={() => {
            setMode(null);
            onSaved();
          }}
          onCancel={() => setMode(null)}
          t={t}
        />
      )}
      {grants && target && (
        <GrantPanel
          key={`${target.id}:${target.revision}`}
          client={client}
          target={target}
          canActivate={canActivate}
          t={t}
        />
      )}
    </section>
  );
}
