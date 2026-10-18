import type { FormEvent } from "react";
export type CredentialField =
  | "login"
  | "password"
  | "factor"
  | "token"
  | "displayName"
  | "timeZone";
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
            autoComplete={
              name === "password"
                ? newPassword
                  ? "new-password"
                  : "current-password"
                : name === "login"
                  ? "username"
                  : name === "factor"
                    ? "one-time-code"
                    : "off"
            }
            autoCapitalize="none"
            spellCheck={false}
            maxLength={
              name === "token"
                ? 43
                : name === "password"
                  ? 1024
                  : name === "factor"
                    ? 64
                    : 200
            }
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
