import { useCallback, useState } from "react";
import {
  portableRuleSchema,
  importRuleDraftSchema,
  investigationSourceOptionsInputSchema,
  type PortableRule,
  type IncidentPageInput,
} from "../../contracts/index.js";
import { Choice } from "../labels/Choice.js";
import { styles } from "../incidents/styles.js";
import type { RulesProps } from "./types.js";
import { useRuleAction } from "./useRuleAction.js";
export function RuleImport({
  client,
  scope,
  t,
  onSaved,
}: RulesProps & { onSaved: (id: string) => void }) {
  const [document, setDocument] = useState<PortableRule | null>(null),
    [source, setSource] = useState("");
  const action = useRuleAction(),
    kind = document?.rule.selector.kind;
  const sources = useCallback(
    async (page: IncidentPageInput) => {
      if (!kind) return { items: [], next: null };
      const result = await client.sources(
        investigationSourceOptionsInputSchema.parse({
          ...scope,
          ...page,
          kind: kind === "signal" ? "alert" : kind,
        }),
      );
      return {
        items: result.items.map((row) => ({
          id: row.sourceId,
          name: row.name,
          enabled: row.enabled,
        })),
        next: result.next,
      };
    },
    [client, scope.serviceId, scope.environmentId, kind],
  );
  return (
    <details>
      <summary>{t("rules.import")}</summary>
      <p>{t("rules.importHelp")}</p>
      <label style={styles.label}>
        {t("rules.file")}
        <input
          type="file"
          accept="application/json,.json"
          disabled={action.pending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            setDocument(null);
            setSource("");
            if (!file) return;
            void action.run(async () => {
              if (file.size > 65536) throw new Error("Rule file too large");
              return portableRuleSchema.parse(JSON.parse(await file.text()));
            }, setDocument);
          }}
        />
      </label>
      {document && (
        <>
          <p>{document.title}</p>
          <Choice
            key={document.rule.selector.kind}
            fetch={sources}
            label={t("rules.localSource")}
            value={source}
            onChange={setSource}
            t={t}
          />
          <button
            type="button"
            disabled={!source || action.pending}
            onClick={() =>
              void action.run(
                () =>
                  client.import(
                    importRuleDraftSchema.parse({
                      document,
                      mapping: { ...scope, streamId: source },
                    }),
                  ),
                (row) => {
                  setDocument(null);
                  setSource("");
                  onSaved(row.id);
                },
              )
            }
          >
            {t("rules.importDraft")}
          </button>
        </>
      )}
      {action.error && <p role="alert">{t("rules.importError")}</p>}
    </details>
  );
}
