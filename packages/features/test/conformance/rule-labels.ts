import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workspaceSchema,
  workspaceIdSchema,
  serviceSchema,
  environmentSchema,
  responderSchema,
  operationalIncidentSchema,
  incidentLabelInputSchema,
  type Actor,
  type IncidentLabel,
  type WorkspaceId,
} from "@bitsentry-escalator/features/contracts";
import type {
  FoundationRepository,
  IncidentLabelRepository,
  IncidentLabelTransaction,
  LabelStream,
} from "@bitsentry-escalator/features/application";
import type { OperationalIncident } from "@bitsentry-escalator/features/contracts";

export interface RuleLabelFixture {
  repository: IncidentLabelRepository;
  foundation: FoundationRepository;
  seedStream(stream: LabelStream): Promise<void>;
  seedIncident(incident: OperationalIncident): Promise<void>;
  dispose(): Promise<void>;
}
const at = "2026-10-05T00:00:00.000Z";
const dates = { createdAt: at, updatedAt: at };

/** Run these same ownership, CAS and atomicity assertions against both host adapters. */
export function ruleLabelConformance(
  name: string,
  factory: () => Promise<RuleLabelFixture>,
  options: {
    skip?: string;
    register?: (name: string, run: () => Promise<void>) => unknown;
  } = {},
): void {
  const register =
    options.register ??
    ((title: string, run: () => Promise<void>) =>
      test(title, { skip: options.skip }, run));
  function scenario(
    title: string,
    run: (
      f: RuleLabelFixture,
      a: Awaited<ReturnType<typeof seed>>,
      b: Awaited<ReturnType<typeof seed>>,
    ) => Promise<void>,
  ) {
    register(`${name}: ${title}`, async () => {
      const f = await factory();
      try {
        await run(f, await seed(f), await seed(f));
      } finally {
        await f.dispose();
      }
    });
  }
  async function seed(f: RuleLabelFixture) {
    const scope = workspaceIdSchema.parse(`label_${randomUUID()}`);
    const service = serviceSchema.parse({
      id: randomUUID(),
      workspaceId: scope,
      name: "API",
      key: "api",
      owningTeam: "Platform",
      enabled: true,
      ...dates,
    });
    const environment = environmentSchema.parse({
      id: randomUUID(),
      workspaceId: scope,
      name: "Production",
      key: "production",
      isProduction: true,
      ...dates,
    });
    const responder = responderSchema.parse({
      id: randomUUID(),
      workspaceId: scope,
      hostUserId: randomUUID(),
      displayName: "On call",
      timeZone: "UTC",
      role: "responder",
      enabled: true,
      ...dates,
    });
    const viewer = responderSchema.parse({
      ...responder,
      id: randomUUID(),
      hostUserId: randomUUID(),
      role: "viewer",
    });
    const disabled = responderSchema.parse({
      ...responder,
      id: randomUUID(),
      hostUserId: randomUUID(),
      enabled: false,
    });
    await f.foundation.transaction(scope, async (tx) => {
      await tx.workspace.insert(
        workspaceSchema.parse({ id: scope, name: "Test", ...dates }),
      );
      await tx.services.insert(service);
      await tx.environments.insert(environment);
      for (const value of [responder, viewer, disabled])
        await tx.responders.insert(value);
    });
    const stream = { kind: "probe" as const, id: randomUUID() };
    await f.seedStream({
      ...stream,
      workspaceId: scope,
      serviceId: service.id,
      environmentId: environment.id,
    });
    const incident = operationalIncidentSchema.parse({
      id: randomUUID(),
      workspaceId: scope,
      serviceId: service.id,
      environmentId: environment.id,
      title: "API unavailable",
      severity: "high",
      openedAt: at,
      resolvedAt: "2026-10-05T00:10:00.000Z",
    });
    await f.seedIncident(incident);
    const actor: Actor = {
      workspaceId: scope,
      responderId: responder.id,
      role: responder.role,
    };
    const input = incidentLabelInputSchema.parse({
      serviceId: service.id,
      environmentId: environment.id,
      stream,
      origin: "missed_incident",
      incidentId: null,
      outcome: "actionable",
      startedAt: at,
      endedAt: "2026-10-05T00:10:00.000Z",
      summary: "Users could not sign in",
    });
    return { scope, actor, input, incident, viewer, disabled };
  }
  const audit = (f: RuleLabelFixture, scope: WorkspaceId) =>
    f.foundation.transaction(scope, (tx) => tx.audit.list({ limit: 100 }));
  scenario(
    "create, edit and review append human audits without copying narrative text",
    async (f, a) => {
      const draft = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.create(a.actor, a.input),
      );
      const edited = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.edit(a.actor, draft.id, 1, {
          ...a.input,
          summary: "Corrected impact",
        }),
      );
      const reviewed = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.review(a.actor, draft.id, 2),
      );
      assert.equal(edited.revision, 2);
      assert.equal(reviewed.revision, 3);
      assert.equal(reviewed.status, "reviewed");
      assert.equal(reviewed.reviewedBy, a.actor.responderId);
      assert.deepEqual(
        await f.repository.transaction(a.scope, (tx) =>
          tx.labels.get(a.actor, draft.id),
        ),
        reviewed,
      );
      const events = (await audit(f, a.scope)).items;
      assert.equal(events.length, 3);
      assert.deepEqual(
        new Set(events.map((e) => e.action)),
        new Set([
          "rule.label_created",
          "rule.label_edited",
          "rule.label_reviewed",
        ]),
      );
      for (const event of events) {
        assert.equal(event.subjectId, draft.id);
        assert.deepEqual(event.actor, {
          kind: "responder",
          responderId: a.actor.responderId,
        });
        assert.equal("summary" in event.metadata, false);
      }
    },
  );
  scenario(
    "foreign IDs and foreign references cannot cross tenant boundaries",
    async (f, a, b) => {
      const label = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.create(a.actor, a.input),
      );
      assert.equal(
        await f.repository.transaction(b.scope, (tx) =>
          tx.labels.get(b.actor, label.id),
        ),
        undefined,
      );
      await assert.rejects(
        f.repository.transaction(b.scope, (tx) =>
          tx.labels.review(b.actor, label.id, 1),
        ),
        { code: "not_found" },
      );
      await assert.rejects(
        f.repository.transaction(a.scope, (tx) =>
          tx.labels.create(b.actor, b.input),
        ),
        { code: "scope_violation" },
      );
      await assert.rejects(
        f.repository.transaction(a.scope, (tx) =>
          tx.labels.create(a.actor, { ...a.input, stream: b.input.stream }),
        ),
        { code: "not_found" },
      );
      await assert.rejects(
        f.repository.transaction(a.scope, (tx) =>
          tx.labels.create(a.actor, {
            ...a.input,
            origin: "incident_review",
            incidentId: b.incident.id,
          }),
        ),
        { code: "not_found" },
      );
      assert.equal((await audit(f, a.scope)).items.length, 1);
    },
  );
  scenario(
    "current responder status and role prevent stale or forged write authority",
    async (f, a) => {
      for (const actor of [
        { ...a.actor, role: "administrator" as const },
        { ...a.actor, responderId: a.disabled.id },
        { ...a.actor, responderId: a.viewer.id },
        { ...a.actor, responderId: a.viewer.id, role: "viewer" as const },
      ])
        await assert.rejects(
          f.repository.transaction(a.scope, (tx) =>
            tx.labels.create(actor, a.input),
          ),
          { code: "forbidden" },
        );
      assert.equal((await audit(f, a.scope)).items.length, 0);
    },
  );
  scenario(
    "stale edits and reviewed immutability leave the label and audits unchanged",
    async (f, a) => {
      const draft = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.create(a.actor, a.input),
      );
      await assert.rejects(
        f.repository.transaction(a.scope, (tx) =>
          tx.labels.edit(a.actor, draft.id, 2, a.input),
        ),
        { code: "conflict" },
      );
      const reviewed = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.review(a.actor, draft.id, 1),
      );
      await assert.rejects(
        f.repository.transaction(a.scope, (tx) =>
          tx.labels.edit(a.actor, draft.id, 2, a.input),
        ),
        { code: "immutable" },
      );
      assert.deepEqual(
        await f.repository.transaction(a.scope, (tx) =>
          tx.labels.get(a.actor, draft.id),
        ),
        reviewed,
      );
      assert.equal((await audit(f, a.scope)).items.length, 2);
    },
  );
  scenario(
    "callback failure rolls back labels and audits together",
    async (f, a) => {
      await assert.rejects(
        f.repository.transaction(a.scope, async (tx) => {
          await tx.labels.create(a.actor, a.input);
          throw new Error("rollback");
        }),
        /rollback/,
      );
      assert.equal(
        (
          await f.repository.transaction(a.scope, (tx) =>
            tx.labels.list(
              a.actor,
              {
                serviceId: a.input.serviceId,
                environmentId: a.input.environmentId,
              },
              { limit: 100 },
            ),
          )
        ).items.length,
        0,
      );
      assert.equal((await audit(f, a.scope)).items.length, 0);
    },
  );
  scenario(
    "audit append failure rolls back a preceding label write",
    async (f, a) => {
      await assert.rejects(
        f.repository.transaction(a.scope, async (tx) => {
          const label = await tx.labels.create(a.actor, a.input);
          const events = (await tx.audit.list({ limit: 100 })).items;
          const event = events.find((e) => e.subjectId === label.id);
          assert.ok(event);
          await assert.rejects(tx.audit.append(event), {
            code: "already_exists",
          });
        }),
        { code: "already_exists" },
      );
      assert.equal((await audit(f, a.scope)).items.length, 0);
      assert.equal(
        (
          await f.repository.transaction(a.scope, (tx) =>
            tx.labels.list(
              a.actor,
              {
                serviceId: a.input.serviceId,
                environmentId: a.input.environmentId,
              },
              { limit: 100 },
            ),
          )
        ).items.length,
        0,
      );
    },
  );
  scenario(
    "same-tenant streams cannot be relabeled under another service",
    async (f, a) => {
      const other = serviceSchema.parse({
        id: randomUUID(),
        workspaceId: a.scope,
        name: "Other",
        key: "other",
        owningTeam: "Platform",
        enabled: true,
        ...dates,
      });
      await f.foundation.transaction(a.scope, (tx) =>
        tx.services.insert(other),
      );
      await assert.rejects(
        f.repository.transaction(a.scope, (tx) =>
          tx.labels.create(a.actor, { ...a.input, serviceId: other.id }),
        ),
        { code: "scope_violation" },
      );
      assert.equal((await audit(f, a.scope)).items.length, 0);
    },
  );
  scenario(
    "caught label errors still poison and roll back the transaction",
    async (f, a) => {
      await assert.rejects(
        f.repository.transaction(a.scope, async (tx) => {
          const draft = await tx.labels.create(a.actor, a.input);
          await assert.rejects(tx.labels.review(a.actor, draft.id, 99), {
            code: "conflict",
          });
        }),
        { code: "conflict" },
      );
      assert.equal((await audit(f, a.scope)).items.length, 0);
    },
  );
  scenario("only one concurrent editor wins a revision", async (f, a) => {
    const draft = await f.repository.transaction(a.scope, (tx) =>
      tx.labels.create(a.actor, a.input),
    );
    const results = await Promise.allSettled(
      ["first", "second"].map((summary) =>
        f.repository.transaction(a.scope, (tx) =>
          tx.labels.edit(a.actor, draft.id, 1, { ...a.input, summary }),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failed = results.find((r) => r.status === "rejected");
    assert.ok(failed?.status === "rejected");
    assert.equal(failed.reason.code, "conflict");
    assert.equal((await audit(f, a.scope)).items.length, 2);
  });
  scenario(
    "keyset listing filters reviewed labels and permits viewer reads",
    async (f, a) => {
      const labels: IncidentLabel[] = [];
      for (let i = 0; i < 3; i++)
        labels.push(
          await f.repository.transaction(a.scope, (tx) =>
            tx.labels.create(a.actor, a.input),
          ),
        );
      const viewer: Actor = {
        ...a.actor,
        responderId: a.viewer.id,
        role: "viewer",
      };
      const selection = {
        serviceId: a.input.serviceId,
        environmentId: a.input.environmentId,
      };
      const first = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.list(viewer, selection, { limit: 2 }),
      );
      assert.equal(first.items.length, 2);
      assert.ok(first.next);
      const last = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.list(viewer, selection, { limit: 2, after: first.next! }),
      );
      assert.equal(last.items.length, 1);
      assert.equal(last.next, null);
      assert.equal(
        new Set([...first.items, ...last.items].map((r) => r.id)).size,
        3,
      );
      await f.repository.transaction(a.scope, (tx) =>
        tx.labels.review(a.actor, labels[0].id, 1),
      );
      const reviewed = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.list(
          viewer,
          { ...selection, status: "reviewed" },
          { limit: 100 },
        ),
      );
      assert.deepEqual(
        reviewed.items.map((r) => r.id),
        [labels[0].id],
      );
    },
  );
  scenario("transaction handles close on callback return", async (f, a) => {
    let saved: IncidentLabelTransaction | undefined;
    await f.repository.transaction(a.scope, async (tx) => {
      saved = tx;
    });
    assert.ok(saved);
    await assert.rejects(saved.labels.create(a.actor, a.input), {
      code: "closed_transaction",
    });
  });
  scenario(
    "metric, probe and signal labels retain distinct stream identities",
    async (f, a) => {
      for (const kind of ["metric", "probe", "signal"] as const) {
        const stream = { kind, id: randomUUID() };
        await f.seedStream({
          ...stream,
          workspaceId: a.scope,
          serviceId: a.input.serviceId,
          environmentId: a.input.environmentId,
        });
        await f.repository.transaction(a.scope, (tx) =>
          tx.labels.create(a.actor, { ...a.input, stream }),
        );
        const found = await f.repository.transaction(a.scope, (tx) =>
          tx.labels.list(
            a.actor,
            {
              serviceId: a.input.serviceId,
              environmentId: a.input.environmentId,
              stream,
            },
            { limit: 100 },
          ),
        );
        assert.equal(found.items.length, 1);
        assert.deepEqual(found.items[0].stream, stream);
      }
    },
  );
  scenario(
    "noise labels bind to the configured incident scope",
    async (f, a) => {
      const label = await f.repository.transaction(a.scope, (tx) =>
        tx.labels.create(a.actor, {
          ...a.input,
          origin: "incident_review",
          incidentId: a.incident.id,
          outcome: "noise",
        }),
      );
      assert.equal(label.incidentId, a.incident.id);
      assert.equal(label.outcome, "noise");
    },
  );
}
