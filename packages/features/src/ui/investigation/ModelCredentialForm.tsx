import { useEffect, useRef, useState } from "react";
import {
  createModelSecretSchema,
  type CreateModelSecretInput,
} from "../../contracts/index.js";
/** Secret input is cleared before transport; only the returned opaque reference reaches settings. */
export function ModelCredentialForm({
  create,
  onCreated,
  t,
}: {
  create: (
    input: CreateModelSecretInput,
  ) => Promise<{ id: string; name: string }>;
  onCreated: (id: string) => void;
  t: (key: string) => string;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  const busy = useRef(false),
    generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [create],
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy.current) return;
        const element = event.currentTarget;
        const key = element.elements.namedItem("model-key") as HTMLInputElement;
        const name = element.elements.namedItem(
          "model-key-name",
        ) as HTMLInputElement;
        const raw = { name: name.value, credentials: { key: key.value } };
        key.value = "";
        busy.current = true;
        setPending(true);
        setError(false);
        const current = generation.current;
        void Promise.resolve()
          .then(() => create(createModelSecretSchema.parse(raw)))
          .then((result) => {
            if (current === generation.current) {
              onCreated(result.id);
              name.value = "";
            }
          })
          .catch(() => {
            if (current === generation.current) setError(true);
          })
          .finally(() => {
            raw.credentials.key = "";
            if (current === generation.current) {
              busy.current = false;
              setPending(false);
            }
          });
      }}
    >
      <fieldset disabled={pending}>
        <legend>{t("investigationSettings.newCredential")}</legend>
        <label>
          {t("investigationSettings.credentialName")}{" "}
          <input
            name="model-key-name"
            required
            maxLength={120}
            autoComplete="off"
          />
        </label>
        <label>
          {t("investigationSettings.apiKey")}{" "}
          <input
            name="model-key"
            type="password"
            required
            maxLength={8192}
            autoComplete="off"
          />
        </label>
        <button type="submit">
          {t("investigationSettings.storeCredential")}
        </button>
      </fieldset>
      {error && (
        <p role="alert">{t("investigationSettings.credentialError")}</p>
      )}
    </form>
  );
}
