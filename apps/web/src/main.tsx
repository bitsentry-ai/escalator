import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { i18nReady } from "./i18n/index.js";
function App() {
  const { t } = useTranslation("escalator");
  return (
    <main>
      <h1>{t("title")}</h1>
      <p>{t("description")}</p>
    </main>
  );
}
void i18nReady.then(() => {
  const element = document.getElementById("root");
  if (element) createRoot(element).render(<App />);
});
