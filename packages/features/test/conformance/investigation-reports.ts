import assert from "node:assert/strict";
import type { InvestigationPersistenceFixture } from "./investigations.js";
import type { InvestigationReportRepository } from "../../src/application/investigation-report/reader.js";
import { projectInvestigationView } from "../../src/application/investigation-report/project.js";
import { responderIdSchema } from "../../src/contracts/index.js";
export interface InvestigationReportFixture extends InvestigationPersistenceFixture {
  reports: InvestigationReportRepository;
  disableResponder(): Promise<void>;
}
export function investigationReportConformance(
  name: string,
  create: () => Promise<InvestigationReportFixture>,
  register: (name: string, run: () => Promise<void>) => void,
) {
  const scenario = (
    title: string,
    run: (f: InvestigationReportFixture) => Promise<void>,
  ) =>
    register(`${name}: ${title}`, async () => {
      const f = await create();
      try {
        await run(f);
      } finally {
        await f.dispose();
      }
    });
  const actor = (f: InvestigationReportFixture) => ({
    workspaceId: f.intent.scope.workspaceId,
    responderId: responderIdSchema.parse("primary"),
  });
  const read = async (f: InvestigationReportFixture) => {
    const snapshot = await f.reports.read(actor(f), f.intent.scope.incidentId);
    assert.ok(snapshot);
    return projectInvestigationView(
      snapshot.scope,
      "disabled",
      snapshot.observedAt,
      snapshot.row,
    );
  };
  const claim = (f: InvestigationReportFixture) =>
    f.repository.claim({
      workspaceId: f.intent.scope.workspaceId,
      runtimeId: "runtime_a",
      claimToken: "report_claim",
      leaseMs: 30000,
    });
  scenario(
    "incident without retained work has no fabricated report",
    async (f) => {
      const view = await read(f);
      assert.equal(view.run, null);
      assert.equal(view.execution, "disabled");
    },
  );
  scenario(
    "pending, live and expired leases come from the database snapshot",
    async (f) => {
      await f.writer.enqueue(f.intent);
      assert.equal((await read(f)).run?.state, "queued");
      const current = await claim(f);
      assert.ok(current);
      assert.equal((await read(f)).run?.state, "running");
      await f.expire(current);
      assert.equal((await read(f)).run?.state, "awaiting_reclaim");
    },
  );
  scenario(
    "published evidence and citations remain readable when execution is disabled",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const current = await claim(f);
      assert.ok(current);
      assert.equal(await f.repository.publish(current, f.result), true);
      const view = await read(f);
      assert.equal(view.execution, "disabled");
      assert.equal(view.run?.state, "reported");
      assert.deepEqual(view.run?.report, f.result.report);
      assert.deepEqual(view.run?.evidence, f.result.evidence);
      assert.deepEqual(view.run?.missingEvidenceIds, []);
    },
  );
  scenario(
    "same incident ID in another tenant cannot reveal the report",
    async (f) => {
      await f.writer.enqueue(f.intent);
      const current = await claim(f);
      assert.ok(current);
      assert.equal(await f.repository.publish(current, f.result), true);
      const snapshot = await f.reports.read(
        { ...actor(f), workspaceId: f.otherScope.workspaceId },
        f.intent.scope.incidentId,
      );
      assert.ok(snapshot);
      assert.equal(snapshot.scope.workspaceId, f.otherScope.workspaceId);
      assert.equal(snapshot.row, null);
    },
  );
  scenario(
    "missing incidents and missing or disabled responders are denied",
    async (f) => {
      assert.equal(
        await f.reports.read(actor(f), "missing_incident"),
        undefined,
      );
      assert.equal(
        await f.reports.read(
          {
            ...actor(f),
            responderId: responderIdSchema.parse("missing_responder"),
          },
          f.intent.scope.incidentId,
        ),
        undefined,
      );
      await f.disableResponder();
      assert.equal(
        await f.reports.read(actor(f), f.intent.scope.incidentId),
        undefined,
      );
    },
  );
}
