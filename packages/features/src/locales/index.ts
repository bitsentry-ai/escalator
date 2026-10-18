import l0 from "./en-US/escalator.json";
import l1 from "./en-GB/escalator.json";
import l2 from "./en-AU/escalator.json";
import l3 from "./fr-FR/escalator.json";
import l4 from "./zh-CN/escalator.json";
import l5 from "./id-ID/escalator.json";
export const escalatorNamespace = "escalator" as const;
export const escalatorResources = {
  "en-US": { escalator: l0 },
  "en-GB": { escalator: l1 },
  "en-AU": { escalator: l2 },
  "fr-FR": { escalator: l3 },
  "zh-CN": { escalator: l4 },
  "id-ID": { escalator: l5 },
} as const;
