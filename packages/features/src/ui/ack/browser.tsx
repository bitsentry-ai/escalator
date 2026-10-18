import { createRoot } from "react-dom/client";
import { escalatorResources } from "../../locales/index.js";
import { captureAcknowledgement } from "./client.js";
import { acknowledgementHttpClient } from "./transport.js";
import { AcknowledgementScreen } from "./AcknowledgementScreen.js";
const capability = captureAcknowledgement(window.location, window.history);
const locales = Object.keys(
  escalatorResources,
) as (keyof typeof escalatorResources)[];
const preferred = navigator.languages ?? [navigator.language];
const locale =
  preferred
    .map(
      (language) =>
        locales.find(
          (value) => value.toLowerCase() === language.toLowerCase(),
        ) ??
        locales.find((value) => value.split("-")[0] === language.split("-")[0]),
    )
    .find(Boolean) ?? "en-US";
const labels = escalatorResources[locale].escalator.ack;
document.documentElement.lang = locale;
const element = document.getElementById("root");
if (element)
  createRoot(element).render(
    <AcknowledgementScreen
      client={
        capability
          ? acknowledgementHttpClient(
              window.location.pathname.replace(/\/$/, "") + "/state",
              capability.token,
            )
          : undefined
      }
      t={(key) => labels[key.slice(4) as keyof typeof labels] ?? key}
    />,
  );
