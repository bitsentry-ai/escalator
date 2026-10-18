import { useCallback, useEffect, useState } from "react";
import type { IncidentPageInput } from "../../contracts/index.js";
import { ruleCatalogListSchema } from "../../contracts/index.js";
import { Choice } from "../labels/Choice.js";
import { useIncidentCollection } from "../incidents/useIncidentCollection.js";
import { styles } from "../incidents/styles.js";
import type { RulesClient } from "./client.js";
import type { RuleText, RulesProps } from "./types.js";
import { RuleDetail } from "./RuleDetail.js";
import { RuleEditor } from "./RuleEditor.js";
import { RuleImport } from "./RuleImport.js";
export function RulesScreen({
  client,
  t,
}: {
  client: RulesClient;
  t: RuleText;
}) {
  const [service, setService] = useState(""),
    [environment, setEnvironment] = useState("");
  const services = useCallback(
      (input: IncidentPageInput) => client.services(input),
      [client],
    ),
    environments = useCallback(
      (input: IncidentPageInput) => client.environments(input),
      [client],
    );
  return (
    <section style={styles.card}>
      <h1>{t("rules.heading")}</h1>
      <p>{t("rules.guidance")}</p>
      <Choice
        fetch={services}
        label={t("deploymentSetup.service")}
        value={service}
        onChange={setService}
        t={t}
      />
      <Choice
        fetch={environments}
        label={t("deploymentSetup.environment")}
        value={environment}
        onChange={setEnvironment}
        t={t}
      />
      {service && environment && (
        <Catalog
          key={`${service}:${environment}`}
          client={client}
          scope={{ serviceId: service, environmentId: environment }}
          t={t}
        />
      )}
    </section>
  );
}
function Catalog({ client, scope, t }: RulesProps) {
  const [selected, setSelected] = useState(""),
    [creating, setCreating] = useState(false),
    [access, setAccess] = useState<{
      canPropose: boolean;
      canApprove: boolean;
    } | null>(null),
    [accessError, setAccessError] = useState(false),
    [accessReload, setAccessReload] = useState(0);
  const fetch = useCallback(
    (page: IncidentPageInput) =>
      client.list(ruleCatalogListSchema.parse({ ...scope, ...page })),
    [client, scope.serviceId, scope.environmentId],
  );
  const list = useIncidentCollection(fetch);
  useEffect(() => {
    let current = true;
    setAccess(null);
    setAccessError(false);
    void client
      .access()
      .then((value) => {
        if (current) setAccess(value);
      })
      .catch(() => {
        if (current) setAccessError(true);
      });
    return () => {
      current = false;
    };
  }, [client, accessReload]);
  const changed = (id: string) => {
    list.refresh();
    setCreating(false);
    setSelected(id);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => {
          list.refresh();
          setAccessReload((n) => n + 1);
        }}
      >
        {t("sources.refresh")}
      </button>
      {accessError && <p role="alert">{t("rules.accessError")}</p>}
      {list.loading && <p role="status">{t("sources.loading")}</p>}
      {list.error && <p role="alert">{t("rules.loadError")}</p>}
      {!list.loading && !list.error && !list.items.length && (
        <p>{t("rules.empty")}</p>
      )}
      <ul>
        {list.items.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => {
                setSelected(row.id);
                setCreating(false);
              }}
            >
              {row.title}
            </button>{" "}
            — {t(`rules.states.${row.status}`)}
          </li>
        ))}
      </ul>
      {list.next && (
        <button
          type="button"
          disabled={list.loading}
          onClick={() => void list.more()}
        >
          {t("deployments.more")}
        </button>
      )}
      {access?.canPropose && (
        <>
          <button
            type="button"
            onClick={() => {
              setSelected("");
              setCreating(true);
            }}
          >
            {t("rules.new")}
          </button>
          <RuleImport client={client} scope={scope} t={t} onSaved={changed} />
        </>
      )}
      {creating && access?.canPropose && (
        <RuleEditor client={client} scope={scope} t={t} onSaved={changed} />
      )}
      {selected && access && (
        <RuleDetail
          key={selected}
          client={client}
          scope={scope}
          t={t}
          id={selected}
          access={access}
          onChanged={() => list.refresh()}
          onAdopt={changed}
        />
      )}
    </>
  );
}
