import type { Responder, Rotation } from "../../contracts/index.js";
import { styles } from "../incidents/styles.js";
export function RotationEditor({
  value,
  responders,
  disabled,
  onChange,
  onRemove,
  t,
}: {
  value: Rotation;
  responders: Responder[];
  disabled: boolean;
  onChange: (value: Rotation) => void;
  onRemove: () => void;
  t: (key: string) => string;
}) {
  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= value.responders.length) return;
    const next = [...value.responders];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange({ ...value, responders: next });
  }
  return (
    <fieldset disabled={disabled} style={styles.card}>
      <legend>{t("oncall.rotation")}</legend>
      <label>
        {t("oncall.timeZone")}
        <input
          required
          value={value.timeZone}
          onChange={(e) => onChange({ ...value, timeZone: e.target.value })}
        />
      </label>
      <label>
        {t("oncall.anchorLocal")}
        <input
          required
          type="datetime-local"
          value={value.anchorLocal}
          onChange={(e) => onChange({ ...value, anchorLocal: e.target.value })}
        />
      </label>
      <label>
        {t("oncall.shiftDays")}
        <input
          required
          type="number"
          min={1}
          max={28}
          value={value.shiftDays}
          onChange={(e) =>
            onChange({ ...value, shiftDays: Number(e.target.value) })
          }
        />
      </label>
      <label>
        {t("oncall.priority")}
        <input
          required
          type="number"
          min={0}
          max={100}
          value={value.priority}
          onChange={(e) =>
            onChange({ ...value, priority: Number(e.target.value) })
          }
        />
      </label>
      <label>
        {t("oncall.dstChoice")}
        <select
          value={value.disambiguation}
          onChange={(e) => {
            const choice = e.target.value;
            if (
              choice === "compatible" ||
              choice === "earlier" ||
              choice === "later"
            )
              onChange({ ...value, disambiguation: choice });
          }}
        >
          {["compatible", "earlier", "later"].map((choice) => (
            <option key={choice} value={choice}>
              {t(`oncall.dst.${choice}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("oncall.untilUtc")}
        <input
          type="datetime-local"
          value={value.until?.slice(0, 16) ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              until: e.target.value
                ? new Date(e.target.value + "Z").toISOString()
                : null,
            })
          }
        />
      </label>
      <p>{t("oncall.rotationOrder")}</p>
      <ol>
        {value.responders.map((id, index) => (
          <li key={id}>
            <span>
              {responders.find((person) => person.id === id)?.displayName ?? id}
            </span>{" "}
            <button
              type="button"
              style={styles.button}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              {t("oncall.moveUp")}
            </button>{" "}
            <button
              type="button"
              style={styles.button}
              disabled={index === value.responders.length - 1}
              onClick={() => move(index, 1)}
            >
              {t("oncall.moveDown")}
            </button>{" "}
            <button
              type="button"
              style={styles.button}
              onClick={() =>
                onChange({
                  ...value,
                  responders: value.responders.filter(
                    (member) => member !== id,
                  ),
                })
              }
            >
              {t("oncall.removeResponder")}
            </button>
          </li>
        ))}
      </ol>
      <label>
        {t("oncall.addResponder")}
        <select
          value=""
          onChange={(e) => {
            const person = responders.find(
              (person) => person.id === e.target.value && person.enabled,
            );
            if (person && !value.responders.includes(person.id))
              onChange({
                ...value,
                responders: [...value.responders, person.id],
              });
          }}
        >
          <option value="">{t("oncall.chooseResponder")}</option>
          {responders
            .filter(
              (person) =>
                person.enabled && !value.responders.includes(person.id),
            )
            .map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
        </select>
      </label>
      <button type="button" style={styles.button} onClick={onRemove}>
        {t("oncall.removeRotation")}
      </button>
    </fieldset>
  );
}
