import { useState, type FormEvent } from "react";
import type { Role } from "@bitsentry-escalator/features/contracts";
import type { LocalAuthClient, LocalUser } from "../../auth/auth-client.js";
interface Props {
  client: LocalAuthClient;
  user: LocalUser;
  pending: boolean;
  t: (key: string) => string;
  run: (job: () => Promise<void>) => void;
  refresh: () => Promise<void>;
}
export function AccountSecurity({
  client,
  user,
  pending,
  t,
  run,
  refresh,
}: Props) {
  const [uri, setUri] = useState<string>();
  const [codes, setCodes] = useState<string[]>();
  const [invitation, setInvitation] = useState<string>();
  function submit(
    event: FormEvent<HTMLFormElement>,
    work: (data: FormData) => Promise<void>,
  ) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    run(async () => {
      await work(data);
      form.reset();
    });
  }
  return (
    <section className="account-security">
      <h2>{t("auth.security")}</h2>
      {codes && (
        <div role="status">
          <p>{t("auth.saveCodes")}</p>
          <textarea
            aria-label={t("auth.recoveryCodes")}
            readOnly
            rows={10}
            value={codes.join("\n")}
          />
          <button type="button" onClick={() => setCodes(undefined)}>
            {t("auth.savedCodes")}
          </button>
        </div>
      )}
      {!user.totpEnabled && !uri && (
        <form
          onSubmit={(event) =>
            submit(event, async (data) => {
              setUri(
                (await client.beginTotp(String(data.get("password") ?? "")))
                  .uri,
              );
            })
          }
        >
          <label>
            {t("auth.password")}
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={pending}
            />
          </label>
          <button disabled={pending}>{t("auth.enableMfa")}</button>
        </form>
      )}
      {!user.totpEnabled && uri && (
        <div>
          <p>{t("auth.enrollHelp")}</p>
          <button
            disabled={pending}
            type="button"
            onClick={() => setUri(undefined)}
          >
            {t("auth.retry")}
          </button>
          <a href={uri}>{t("auth.openAuthenticator")}</a>
          <code>{new URL(uri).searchParams.get("secret")}</code>
          <form
            onSubmit={(event) =>
              submit(event, async (data) => {
                const result = await client.enableTotp(
                  String(data.get("token") ?? ""),
                );
                setCodes(result.recoveryCodes);
                setUri(undefined);
                await refresh();
              })
            }
          >
            <label>
              {t("auth.factor")}
              <input
                name="token"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                disabled={pending}
              />
            </label>
            <button disabled={pending}>{t("auth.confirmMfa")}</button>
          </form>
        </div>
      )}
      {user.totpEnabled && (
        <form
          onSubmit={(event) =>
            submit(event, async (data) => {
              await client.disableTotp(
                String(data.get("password") ?? ""),
                String(data.get("factor") ?? ""),
              );
              setCodes(undefined);
              await refresh();
            })
          }
        >
          <p>{t("auth.mfaEnabled")}</p>
          <label>
            {t("auth.password")}
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={pending}
            />
          </label>
          <label>
            {t("auth.factor")}
            <input
              name="factor"
              autoComplete="one-time-code"
              required
              disabled={pending}
            />
          </label>
          <button disabled={pending}>{t("auth.disableMfa")}</button>
        </form>
      )}
      {user.role === "administrator" && (
        <section>
          <h3>{t("auth.invite")}</h3>
          <form
            onSubmit={(event) =>
              submit(event, async (data) => {
                setInvitation(
                  (await client.invite(String(data.get("role")) as Role)).token,
                );
              })
            }
          >
            <label>
              {t("auth.role")}
              <select name="role" defaultValue="viewer" disabled={pending}>
                <option value="viewer">{t("auth.viewer")}</option>
                <option value="responder">{t("auth.responder")}</option>
                <option value="administrator">{t("auth.administrator")}</option>
              </select>
            </label>
            <button disabled={pending}>{t("auth.createInvite")}</button>
          </form>
          {invitation && (
            <div>
              <p>{t("auth.inviteHelp")}</p>
              <textarea
                aria-label={t("auth.token")}
                readOnly
                value={invitation}
              />
            </div>
          )}
        </section>
      )}
    </section>
  );
}
