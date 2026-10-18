import {
  createSignalSourceSchema,
  createProviderSourceSchema,
  updateSignalSourceSchema,
  updateProviderSourceSchema,
  usesProviderSignature,
  type SignalSource,
} from "../../contracts/index.js";
const text = (form: FormData, key: string) => String(form.get(key) ?? "");
export function readSourceForm(form: FormData, initial?: SignalSource) {
  const common = {
    name: text(form, "name"),
    grouping: text(form, "grouping"),
    recoveryHoldSeconds: Number(text(form, "hold")),
  };
  if (initial)
    return {
      kind: "update" as const,
      input: updateSignalSourceSchema.parse({
        ...common,
        id: initial.id,
        expectedVersion: initial.version,
        enabled: form.get("enabled") === "on",
        recovery: text(form, "recovery"),
      }),
    };
  const mode = text(form, "mode");
  const shared = {
    ...common,
    serviceId: text(form, "service"),
    environmentId: text(form, "environment"),
  };
  if (mode === "generic")
    return {
      kind: "generic" as const,
      input: createSignalSourceSchema.parse({
        ...shared,
        kind: "generic",
        recovery: text(form, "recovery"),
      }),
    };
  const intake =
    mode === "glitchtip"
      ? { mode, trackerOrigin: text(form, "origin") }
      : { mode };
  return {
    kind: "provider" as const,
    input: createProviderSourceSchema.parse({
      ...shared,
      intake,
      authSecretId:
        mode === "sentry-hmac" || mode === "grafana-hmac"
          ? text(form, "authSecretId")
          : null,
    }),
  };
}
export function readProviderForm(form: FormData, initial: SignalSource) {
  if (!initial.intake) throw new Error("Provider configuration required");
  const intake =
    initial.intake.mode === "glitchtip"
      ? { mode: "glitchtip" as const, trackerOrigin: text(form, "origin") }
      : initial.intake;
  return updateProviderSourceSchema.parse({
    id: initial.id,
    expectedVersion: initial.version,
    intake,
    authSecretId: usesProviderSignature(intake)
      ? text(form, "authSecretId")
      : null,
  });
}
