import type { Responder } from "../../contracts/index.js";
import { styles } from "../incidents/styles.js";
export function RecipientPicker({
  label,
  responders,
  selected,
  onChange,
  t,
}: {
  label: string;
  responders: Responder[];
  selected: string[];
  onChange: (values: string[]) => void;
  t: (key: string) => string;
}) {
  return (
    <fieldset style={styles.card}>
      <legend>{label}</legend>
      {responders.map((person) => (
        <label key={person.id} style={styles.label}>
          <span>
            <input
              type="checkbox"
              disabled={!person.enabled && !selected.includes(person.id)}
              checked={selected.includes(person.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, person.id]
                    : selected.filter((id) => id !== person.id),
                )
              }
            />
            {person.displayName}{" "}
            {!person.enabled && `(${t("settings.disabled")})`}
          </span>
        </label>
      ))}
      {selected
        .filter((id) => !responders.some((person) => person.id === id))
        .map((id) => (
          <p key={id}>
            {id}{" "}
            <button
              type="button"
              style={styles.button}
              onClick={() => onChange(selected.filter((value) => value !== id))}
            >
              {t("policy.removeRecipient")}
            </button>
          </p>
        ))}
    </fieldset>
  );
}
