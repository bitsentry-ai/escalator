import test from "node:test";
import assert from "node:assert/strict";
import {
  incidentLabelInputSchema,
  incidentLabelSchema,
} from "../src/contracts/rule-label.js";
import {
  workspaceIdSchema,
  responderIdSchema,
  type Actor,
} from "../src/contracts/identity.js";
import {
  createIncidentLabel,
  editIncidentLabel,
  reviewIncidentLabel,
  IncidentLabelError,
} from "../src/application/rules/labels.js";

const actor: Actor = {
  workspaceId: workspaceIdSchema.parse("org-a"),
  responderId: responderIdSchema.parse("alice"),
  role: "responder",
};
const at = (minute: number) =>
  new Date(Date.parse("2026-10-06T00:00:00Z") + minute * 60000).toISOString();
function content() {
  return incidentLabelInputSchema.parse({
    serviceId: "service",
    environmentId: "prod",
    stream: { kind: "probe", id: "probe" },
    origin: "missed_incident",
    incidentId: null,
    outcome: "actionable",
    startedAt: at(1),
    endedAt: at(3),
    summary: "Users could not log in",
  });
}
const code = (value: string) => (error: unknown) =>
  error instanceof IncidentLabelError && error.code === value;
test("labels begin as drafts and gain immutable human review attribution", () => {
  const input = content(),
    draft = createIncidentLabel(actor, "label-1", input, at(4));
  assert.equal(draft.status, "draft");
  assert.equal(draft.reviewedBy, null);
  const updated = editIncidentLabel(
    actor,
    draft,
    1,
    { ...input, summary: "Login failed for six users" },
    at(5),
  );
  assert.equal(updated.revision, 2);
  const reviewed = reviewIncidentLabel(actor, updated, 2, at(6));
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.revision, 3);
  assert.equal(reviewed.reviewedBy, actor.responderId);
  assert.equal(reviewed.reviewedAt, at(6));
  assert.throws(
    () => editIncidentLabel(actor, reviewed, 3, input, at(7)),
    code("immutable"),
  );
  assert.throws(
    () => reviewIncidentLabel(actor, reviewed, 3, at(7)),
    code("immutable"),
  );
  assert.equal(draft.summary, input.summary);
  assert.equal(draft.revision, 1);
});
test("noise labels require an actual reviewed-incident reference", () => {
  const input = content();
  assert.equal(
    incidentLabelInputSchema.safeParse({ ...input, outcome: "noise" }).success,
    false,
  );
  assert.equal(
    incidentLabelInputSchema.safeParse({ ...input, origin: "incident_review" })
      .success,
    false,
  );
  assert.equal(
    incidentLabelInputSchema.safeParse({ ...input, incidentId: "incident" })
      .success,
    false,
  );
  const noise = incidentLabelInputSchema.parse({
    ...input,
    origin: "incident_review",
    incidentId: "incident",
    outcome: "noise",
  });
  assert.equal(
    createIncidentLabel(actor, "label", noise, at(4)).outcome,
    "noise",
  );
});
test("stale revisions and backwards database time cannot overwrite a draft", () => {
  const input = content(),
    draft = createIncidentLabel(actor, "label", input, at(5));
  assert.throws(
    () => editIncidentLabel(actor, draft, 2, input, at(6)),
    code("conflict"),
  );
  assert.throws(
    () => reviewIncidentLabel(actor, draft, 2, at(6)),
    code("conflict"),
  );
  assert.throws(
    () => reviewIncidentLabel(actor, draft, 1, at(4)),
    code("conflict"),
  );
});
test("viewers and foreign organizations cannot label or review incidents", () => {
  const input = content(),
    draft = createIncidentLabel(actor, "label", input, at(5));
  assert.throws(
    () =>
      createIncidentLabel({ ...actor, role: "viewer" }, "label", input, at(5)),
    code("forbidden"),
  );
  assert.throws(
    () => reviewIncidentLabel({ ...actor, role: "viewer" }, draft, 1, at(6)),
    code("forbidden"),
  );
  assert.throws(
    () =>
      reviewIncidentLabel(
        { ...actor, workspaceId: workspaceIdSchema.parse("org-b") },
        draft,
        1,
        at(6),
      ),
    code("scope_violation"),
  );
});
test("draft edits cannot change linked identities or label origin", () => {
  const input = content(),
    draft = createIncidentLabel(actor, "label", input, at(5));
  for (const patch of [
    { stream: { kind: "metric" as const, id: "another" } },
    { origin: "incident_review" as const, incidentId: "incident" },
  ])
    assert.throws(
      () => editIncidentLabel(actor, draft, 1, { ...input, ...patch }, at(6)),
      code("scope_violation"),
    );
});
test("caller-supplied review authority and future or empty intervals are rejected", () => {
  const input = content();
  assert.equal(
    incidentLabelInputSchema.safeParse({ ...input, reviewedBy: "admin" })
      .success,
    false,
  );
  assert.equal(
    incidentLabelInputSchema.safeParse({ ...input, endedAt: input.startedAt })
      .success,
    false,
  );
  assert.throws(() => createIncidentLabel(actor, "label", input, at(2)));
  const draft = createIncidentLabel(actor, "label", input, at(5));
  assert.equal(
    incidentLabelSchema.safeParse({ ...draft, status: "reviewed" }).success,
    false,
  );
  assert.equal(
    incidentLabelSchema.safeParse({
      ...draft,
      reviewedBy: actor.responderId,
      reviewedAt: at(5),
    }).success,
    false,
  );
});
