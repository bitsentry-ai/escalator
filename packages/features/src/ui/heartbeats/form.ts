import {
  createHeartbeatSchema,
  updateHeartbeatSchema,
  type Heartbeat,
} from "../../contracts/index.js";
export function readHeartbeatForm(form: FormData, initial?: Heartbeat) {
  const text = (name: string) => String(form.get(name) ?? "");
  const editable = {
    name: text("name"),
    enabled: form.get("enabled") === "on",
    intervalSeconds: Number(text("interval")),
    graceSeconds: Number(text("grace")),
  };
  return initial
    ? {
        kind: "update" as const,
        input: updateHeartbeatSchema.parse({
          ...editable,
          id: initial.id,
          expectedVersion: initial.version,
        }),
      }
    : {
        kind: "create" as const,
        input: createHeartbeatSchema.parse({
          ...editable,
          serviceId: text("service"),
          environmentId: text("environment"),
        }),
      };
}
