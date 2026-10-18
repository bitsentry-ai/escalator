# On-call configuration

Both hosts use the shared configuration application service. Standalone exposes
`configuration.*` tRPC procedures; Dashboard exposes the corresponding guarded
Escalator procedures. Authentication supplies the workspace. Request bodies
cannot change it.

Administrators manage schedules, contacts, availability and escalation policies.
Responders and viewers can read on-call configuration. Every successful mutation
records an audit event in the same transaction. An audit failure rolls back the
configuration change.

## Editing and previewing

Create a record with `expectedVersion: null`. Updates must supply the version
last read. A conflicting edit returns a conflict rather than replacing another
administrator's work. Refresh and review the current record before retrying.

A schedule contains timezone-aware rotations and approved overrides. Anyone with
on-call read access can inspect coverage for a bounded interval of at most 31 days.
This read-only query does not create a reviewed preview or change configuration.
Administrators can persist a preview for policy review. Stored previews include uncovered intervals,
the schedule revision and database creation time. Review gaps before activating
a policy. Activation requires previews of the current enabled primary and peer
schedules; editing either schedule invalidates its prior activation preview.

Existing pages retain their frozen escalation policy. Configuration edits affect
future paging decisions and do not rewrite an incident's history.

## Channel credentials

Contacts contain opaque secret identifiers, never plaintext tokens or destinations.
The persistence adapter verifies secret ownership before accepting a contact.
Standalone credentials use its encrypted PostgreSQL store. Dashboard credential
resolution depends on integration of the separate secret broker stack; no fallback
credential store is provided in the Dashboard adapter.

Working-hour availability helps choose scheduled peers. It does not suppress a
primary responder's assigned on-call shift.
