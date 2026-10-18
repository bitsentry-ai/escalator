import { CredentialForm } from "../login/CredentialForm.js";
import type { Registration } from "../../auth/auth-client.js";
interface Props {
  pending: boolean;
  t: (key: string) => string;
  submit: (input: Registration) => void;
}
export function SetupForm({ pending, t, submit }: Props) {
  return (
    <CredentialForm
      fields={["token", "login", "displayName", "timeZone", "password"]}
      action="auth.createAccount"
      newPassword
      pending={pending}
      t={t}
      submit={(values) =>
        submit({
          token: values.token,
          login: values.login,
          password: values.password,
          displayName: values.displayName,
          timeZone: values.timeZone,
        })
      }
    />
  );
}
