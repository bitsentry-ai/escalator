import { randomUUID } from "node:crypto";
import type {
  IncidentLabel,
  OperationalIncident,
  WorkspaceId,
} from "../../src/contracts/index.js";
import type {
  IncidentLabelRepository,
  IncidentLabelTransaction,
  LabelStream,
} from "../../src/application/rules/label-ports.js";
import { withIncidentLabels } from "../../src/application/rules/label-transaction.js";
import { MemoryFoundationRepository } from "./memory.js";
import { compareCodeUnits } from "../../src/contracts/ordering.js";

export class MemoryRuleLabels implements IncidentLabelRepository {
  readonly foundation = new MemoryFoundationRepository({
    now: () => new Date("2026-10-06T12:00:00.000Z"),
  });
  async seedStream(stream: LabelStream): Promise<void> {
    await this.foundation.withExtensions(
      stream.workspaceId,
      async (_, extensions) => {
        ((extensions.labelStreams ??= []) as LabelStream[]).push(
          structuredClone(stream),
        );
      },
    );
  }
  async seedIncident(incident: OperationalIncident): Promise<void> {
    await this.foundation.withExtensions(
      incident.workspaceId,
      async (_, extensions) => {
        ((extensions.labelIncidents ??= []) as OperationalIncident[]).push(
          structuredClone(incident),
        );
      },
    );
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: IncidentLabelTransaction) => Promise<T>,
  ): Promise<T> {
    return this.foundation.withExtensions(
      scope,
      async (base, extensions, guard) => {
        const rows = (extensions.ruleLabels ??= []) as IncidentLabel[];
        const streams = (extensions.labelStreams ??= []) as LabelStream[];
        const incidents = (extensions.labelIncidents ??=
          []) as OperationalIncident[];
        const scoped = () => rows.filter((row) => row.workspaceId === scope);
        return run(
          withIncidentLabels(
            base,
            {
              currentTime: async () => base.now,
              lockStream: async (stream) =>
                structuredClone(
                  streams.find(
                    (row) =>
                      row.workspaceId === scope &&
                      row.kind === stream.kind &&
                      row.id === stream.id,
                  ),
                ),
              incident: async (id) =>
                structuredClone(
                  incidents.find(
                    (row) => row.workspaceId === scope && row.id === id,
                  ),
                ),
              get: async (id) =>
                structuredClone(scoped().find((row) => row.id === id)),
              list: async (selection, query) => {
                const found = scoped()
                  .filter(
                    (row) =>
                      row.serviceId === selection.serviceId &&
                      row.environmentId === selection.environmentId &&
                      (!selection.status || row.status === selection.status) &&
                      (!selection.incidentId ||
                        row.incidentId === selection.incidentId) &&
                      (!selection.stream ||
                        (row.stream.kind === selection.stream.kind &&
                          row.stream.id === selection.stream.id)) &&
                      (!query.after || row.id > query.after),
                  )
                  .sort((a, b) => compareCodeUnits(a.id, b.id));
                const items = found.slice(0, query.limit);
                return structuredClone({
                  items,
                  next: found.length > query.limit ? items.at(-1)!.id : null,
                });
              },
              put: async (value, expected) => {
                const index = rows.findIndex(
                  (row) => row.workspaceId === scope && row.id === value.id,
                );
                if (expected === null) {
                  if (index >= 0) return false;
                  rows.push(structuredClone(value));
                  return true;
                }
                if (
                  index < 0 ||
                  rows[index].revision !== expected ||
                  rows[index].status !== "draft"
                )
                  return false;
                rows[index] = structuredClone(value);
                return true;
              },
            },
            guard,
            randomUUID,
          ),
        );
      },
    );
  }
}
