import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import {
  escalatorNamespace,
  escalatorResources,
} from "@bitsentry-escalator/features/locales";
export const i18nReady = i18n.use(initReactI18next).init({
  resources: escalatorResources,
  lng: "en-US",
  fallbackLng: "en-US",
  ns: [escalatorNamespace],
  defaultNS: escalatorNamespace,
  interpolation: { escapeValue: false },
});
