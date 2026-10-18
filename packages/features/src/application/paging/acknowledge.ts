import { createHash } from "node:crypto";
import type { OperationalPage, WorkspaceId } from "../../contracts/index.js";
import { cancelPageWork } from "./cancel.js";
import type { PagingRepository } from "./persistence.js";
import { pagingWorkId } from "./work-ids.js";

export type AcknowledgementResult =
  | { state: "invalid" }
  | { state: "open"; pageId: string; title: string }
  | {
      state: "acknowledged" | "resolved";
      pageId: string;
      ownerId: string | null;
    };

/** The raw credential is transient. Only its SHA-256 digest enters persistence. */
export function acknowledgementDigest(token: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== token)
    return undefined;
  return createHash("sha256").update(bytes).digest("hex");
}
function result(page: OperationalPage): AcknowledgementResult {
  return {
    state: page.state === "resolved" ? "resolved" : "acknowledged",
    pageId: page.id,
    ownerId: page.acknowledgedBy,
  };
}

export class PageAcknowledgements {
  constructor(private readonly repository: PagingRepository) {}
  /** GET-safe preview: no acknowledgement, delivery or audit mutation. */
  async preview(
    scope: WorkspaceId,
    token: string,
  ): Promise<AcknowledgementResult> {
    const digest = acknowledgementDigest(token);
    if (!digest) return { state: "invalid" };
    return this.repository.transaction(scope, async (tx) => {
      const grant = await tx.grants.findValid(digest);
      if (!grant) return { state: "invalid" };
      const page = await tx.pages.get(grant.pageId);
      if (!page) return { state: "invalid" };
      if (page.acknowledgedBy || page.state === "resolved") return result(page);
      const incident = await tx.incidents.get(page.incidentId);
      return incident
        ? { state: "open", pageId: page.id, title: incident.title }
        : { state: "invalid" };
    });
  }
  /** POST only. Page ownership, cancellation intents and audit commit together. */
  async acknowledge(
    scope: WorkspaceId,
    token: string,
  ): Promise<AcknowledgementResult> {
    const digest = acknowledgementDigest(token);
    if (!digest) return { state: "invalid" };
    return this.repository.transaction(scope, async (tx) => {
      const initial = await tx.grants.findValid(digest);
      if (!initial) return { state: "invalid" };
      const page = await tx.pages.lock(initial.pageId);
      // Recheck against live database time after any page-lock wait.
      const grant = await tx.grants.findValid(digest);
      if (!page || !grant) return { state: "invalid" };
      if (page.acknowledgedBy || page.state === "resolved") return result(page);
      const responder = await tx.responders.get(grant.recipientId);
      if (!responder?.enabled) return { state: "invalid" };
      const updated: OperationalPage = {
        ...page,
        state: "acknowledged",
        revision: page.revision + 1,
        acknowledgedBy: grant.recipientId,
        acknowledgedAt: new Date(
          Math.max(Date.parse(tx.now), Date.parse(page.createdAt)),
        ).toISOString(),
      };
      if (!(await tx.pages.replace(updated, page.revision)))
        throw new Error("Locked page revision changed");
      await cancelPageWork(tx, updated);
      await tx.audit.append({
        id: pagingWorkId(scope, "ack-audit", page.id),
        workspaceId: scope,
        actor: { kind: "recipient-token", responderId: grant.recipientId },
        action: "page.acknowledged",
        subjectType: "page",
        subjectId: page.id,
        recordedAt: updated.acknowledgedAt!,
        metadata: {},
      });
      return result(updated);
    });
  }
}
