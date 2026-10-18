import type { ResponderId, WorkspaceId } from "../../contracts/index.js";
import type { Page, PageRequest } from "./persistence.js";
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type AuditActor =
  | { kind: "responder"; responderId: ResponderId }
  | { kind: "recipient-token"; responderId: ResponderId }
  | { kind: "system"; component: string };
export interface AuditEvent {
  id: string;
  workspaceId: WorkspaceId;
  actor: AuditActor;
  action: string;
  subjectType: string;
  subjectId: string;
  recordedAt: string;
  /** Allowlisted mutation metadata only; never resolved secrets or raw tokens. */
  metadata: { [key: string]: JsonValue };
}
export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  list(page: PageRequest): Promise<Page<AuditEvent>>;
}
