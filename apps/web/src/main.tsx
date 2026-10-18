import { createRoot } from "react-dom/client";
import { i18nReady } from "./i18n/index.js";
import { AuthShell } from "./auth/AuthShell.js";
import { LocalAuthClient } from "./auth/auth-client.js";
import "./style.css";
import { EscalatorShell } from "./routes/EscalatorShell.js";
const client = new LocalAuthClient();
void i18nReady.then(() => {
  const element = document.getElementById("root");
  if (element)
    createRoot(element).render(
      <AuthShell client={client}>
        {(user) => <EscalatorShell key={user.id} client={client} user={user} />}
      </AuthShell>,
    );
});
