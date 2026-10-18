import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  LocalAuthClient,
  type LocalSession,
  type LocalUser,
} from "./auth-client.js";
import { CredentialForm } from "../routes/login/CredentialForm.js";
import { SetupForm } from "../routes/setup/SetupForm.js";
import { AccountSecurity } from "../routes/account/AccountSecurity.js";
interface Props {
  client: LocalAuthClient;
  children?: (user: LocalUser) => ReactNode;
}
export function AuthShell({ client, children }: Props) {
  const { t } = useTranslation("escalator");
  const [session, setSession] = useState<LocalSession>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState(false);
  const [view, setView] = useState<"login" | "setup" | "recover">("login");
  const busy = useRef(false);
  useEffect(() => {
    let active = true;
    void client
      .session()
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client]);
  async function refresh() {
    setSession(await client.session());
  }
  function run(job: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    setNotice(false);
    void job()
      .catch(() => setFailed(true))
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  }
  return (
    <main className="escalator-shell">
      <header>
        <h1>{t("title")}</h1>
        {session?.user && (
          <div>
            <span>{session.user.displayName}</span>
            <button
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await client.logout();
                  await refresh();
                })
              }
            >
              {t("auth.logout")}
            </button>
          </div>
        )}
      </header>
      {failed && (
        <div role="alert">
          <p>{t("auth.failed")}</p>
          <button disabled={pending} onClick={() => run(refresh)}>
            {t("auth.retry")}
          </button>
        </div>
      )}
      {!session && !failed && <p role="status">{t("auth.loading")}</p>}
      {notice && <p role="status">{t("auth.readyToLogin")}</p>}
      {session && !session.user && (
        <section className="auth-card">
          <nav aria-label={t("auth.navigation")}>
            <button
              disabled={pending}
              aria-pressed={view === "login"}
              onClick={() => setView("login")}
            >
              {t("auth.signIn")}
            </button>
            <button
              disabled={pending}
              aria-pressed={view === "setup"}
              onClick={() => setView("setup")}
            >
              {t("auth.setup")}
            </button>
            <button
              disabled={pending}
              aria-pressed={view === "recover"}
              onClick={() => setView("recover")}
            >
              {t("auth.recover")}
            </button>
          </nav>
          {view === "login" && (
            <CredentialForm
              fields={["login", "password", "factor"]}
              action="auth.signIn"
              pending={pending}
              t={t}
              submit={(values) =>
                run(async () => {
                  await client.login({
                    login: values.login,
                    password: values.password,
                    factor: values.factor || undefined,
                  });
                  await refresh();
                })
              }
            />
          )}
          {view === "setup" && <p>{t("auth.setupHelp")}</p>}
          {view === "recover" && <p>{t("auth.recoverHelp")}</p>}
          {view === "setup" && (
            <SetupForm
              pending={pending}
              t={t}
              submit={(values) =>
                run(async () => {
                  await client.register(values);
                  setView("login");
                  setNotice(true);
                })
              }
            />
          )}
          {view === "recover" && (
            <CredentialForm
              fields={["token", "password"]}
              action="auth.resetPassword"
              newPassword
              pending={pending}
              t={t}
              submit={(values) =>
                run(async () => {
                  await client.recover(values.token, values.password);
                  await refresh();
                  setView("login");
                  setNotice(true);
                })
              }
            />
          )}
        </section>
      )}
      {session?.user && (
        <>
          <section>{children?.(session.user)}</section>
          <AccountSecurity
            key={session.user.id}
            client={client}
            user={session.user}
            pending={pending}
            t={t}
            run={run}
            refresh={refresh}
          />
        </>
      )}
    </main>
  );
}
