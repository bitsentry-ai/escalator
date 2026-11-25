import type { FormEvent } from "react";
export type CredentialField =
  | "login"
  | "password"
  | "factor"
  | "token"
  | "displayName"
  | "timeZone";
const MAX_LENGTHS: Record<CredentialField, number> = {
  token: 43,
  password: 1024,
  factor: 64,
  login: 200,
  displayName: 200,
  timeZone: 200,
};
function autoCompleteFor(name: CredentialField, newPassword?: boolean): string {
  switch (name) {
    case "password":
      return newPassword ? "new-password" : "current-password";
    case "login":
      return "username";
    case "factor":
      return "one-time-code";
    default:
      return "off";
  }
}
interface Props {
  fields: CredentialField[];
  action: string;
  pending: boolean;
  newPassword?: boolean;
  t: (key: string) => string;
  submit: (values: Record<CredentialField, string>) => void;
}
export function CredentialForm({
  fields,
  action,
  pending,
  newPassword = false,
  t,
  submit,
}: Props) {
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    submit(
      Object.fromEntries(
        fields.map((name) => [name, String(data.get(name) ?? "")]),
      ) as Record<CredentialField, string>,
    );
  }
  return (
    <form onSubmit={send} className="credential-form">
      {fields.map((name) => (
        <label key={name}>
          {t(`auth.${name}`)}
          <input
            name={name}
            type={name === "password" || name === "token" ? "password" : "text"}
            disabled={pending}
            required={name !== "factor"}
            autoComplete={autoCompleteFor(name, newPassword)}
            autoCapitalize="none"
            spellCheck={false}
            maxLength={MAX_LENGTHS[name]}
            minLength={name === "password" && newPassword ? 12 : undefined}
            defaultValue={
              name === "timeZone"
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : undefined
            }
          />
        </label>
      ))}
      {newPassword && <p>{t("auth.passwordHelp")}</p>}
      <button disabled={pending} type="submit">
        {t(action)}
      </button>
    </form>
  );
}
