import { createRoot } from "react-dom/client";
import { i18nReady } from "./i18n/index.js";
import { AuthShell } from "./auth/AuthShell.js";
import { LocalAuthClient } from "./auth/auth-client.js";
import "./style.css";
const client = new LocalAuthClient();
void i18nReady.then(() => {
  const element = document.getElementById("root");
  if (element) createRoot(element).render(<AuthShell client={client} />);
});
