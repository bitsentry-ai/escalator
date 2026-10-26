import type { Clock, WorkspaceId } from "../../src/contracts/index.js";
import type {
  CoverageRepository,
  CoverageTransaction,
  CoverageRecord,
  CoverageRecordStore,
} from "../../src/application/deploy/coverage-ports.js";
import { coverageTransaction } from "../../src/application/deploy/coverage-transaction.js";
import { PersistenceError } from "../../src/application/ports/persistence.js";
import { MemoryDeploymentRepository } from "./memory-deployments.js";
const copy = <T>(value: T): T => structuredClone(value);
/** Test-only serializable storage sharing the deployment transaction's rollback boundary. */
function addScheduleResponders(
  candidates: Set<string>,
  schedule: {
    rotations: { responders: string[] }[];
    overrides: { responderId: string }[];
  },
): void {
  for (const rotation of schedule.rotations)
    for (const id of rotation.responders) candidates.add(id);
  for (const override of schedule.overrides)
    candidates.add(override.responderId);
}
/** Iterates the serializable test snapshot only; production adapters use a bounded SQL statement. */
async function contactsOf<C extends { responderId: string }>(
  list: (page: {
    limit: number;
    after?: string;
  }) => Promise<{ items: C[]; next: string | null }>,
  responders: readonly { id: string }[],
): Promise<C[]> {
  const contacts: C[] = [];
  let after: string | undefined;
  do {
    const page = await list({ limit: 100, after });
    for (const contact of page.items)
      if (responders.some((row) => row.id === contact.responderId))
        contacts.push(contact);
    after = page.next ?? undefined;
  } while (after && contacts.length <= 2060);
  return contacts;
}
export class MemoryCoverageRepository implements CoverageRepository {
  readonly deployments: MemoryDeploymentRepository;
  constructor(clock?: Clock) {
    this.deployments = new MemoryDeploymentRepository(clock);
  }
  get configuration() {
    return this.deployments.configuration;
  }
  get work() {
    return this.deployments.work;
  }
  findTokenContext(hash: string) {
    return this.deployments.findTokenContext(hash);
  }
  transaction<T>(
    scope: WorkspaceId,
    run: (tx: CoverageTransaction) => Promise<T>,
  ): Promise<T> {
    return this.deployments.withExtensions(
      scope,
      (base, configuration, extensions, guard) => {
        const data = (extensions.coverage ??= []) as CoverageRecord[];
        const rows = (targetId: string) =>
          data.filter(
            (row) =>
              row.decision.binding.workspaceId === scope &&
              row.decision.binding.targetId === targetId,
          );
        const store: CoverageRecordStore = {
          async snapshot(target, mappedDeployerId) {
            const policy =
              (await configuration.configuration.policies.get(
                target.policyId,
              )) ?? null;
            const schedules = [];
            const candidates = new Set(policy?.fallbackResponderIds ?? []);
            if (mappedDeployerId) candidates.add(mappedDeployerId);
            for (const id of new Set(
              policy ? [policy.primaryScheduleId, policy.peerScheduleId] : [],
            )) {
              const schedule =
                await configuration.configuration.schedules.get(id);
              if (!schedule) continue;
              schedules.push(schedule);
              addScheduleResponders(candidates, schedule);
            }
            const responders = [],
              availability = [];
            let complete = candidates.size <= 103;
            for (const id of [...candidates].sort().slice(0, 103)) {
              const responder = await base.responders.get(id);
              if (responder) responders.push(responder);
              const hours =
                await configuration.configuration.availability.get(id);
              if (hours) availability.push(hours);
            }
            const contacts = await contactsOf(
              (page) => configuration.configuration.contacts.list(page),
              responders,
            );
            if (contacts.length > 2060) complete = false;
            return {
              complete,
              policy,
              schedules,
              responders,
              availability,
              contacts: contacts.slice(0, 2060),
            };
          },
          async get(targetId, id) {
            return copy(rows(targetId).find((row) => row.decision.id === id));
          },
          async find(targetId, key) {
            return copy(rows(targetId).find((row) => row.key === key));
          },
          async insert(value) {
            if (
              data.some(
                (row) =>
                  row.decision.binding.workspaceId === scope &&
                  (row.decision.id === value.decision.id ||
                    (row.decision.binding.targetId ===
                      value.decision.binding.targetId &&
                      row.key === value.key)),
              )
            )
              throw new PersistenceError("already_exists");
            data.push(copy(value));
          },
        };
        return run(coverageTransaction(base, store, guard));
      },
    );
  }
}
