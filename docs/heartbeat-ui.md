# Heartbeat administration

The shared Heartbeats screen in both hosts manages periodic-signal monitors and their stored deadline state. New monitors start disabled. Administrators choose the service/environment, expected interval and grace period, provision a scoped sender token, select a paging policy, then enable monitoring.

Service/environment identity is fixed after creation. Configuration saves and disable requests use the selected record's version. Reader views offer inspection only. All writes use the existing host-authorized, transactional audit path.

Grant inventory contains IDs and validity/revocation metadata, never bearer values or hashes. Tokens appear once after issuance, remain only in component memory and are cleared on dismissal or navigation. There are no browser-storage writes. Rotate by issuing a replacement before revocation. An uncertain response may have committed; refresh inventory before retrying. Expiry uses an absolute UTC instant validated against database time. Browser clock errors can cause rejection.

The state panel shows last acceptance, persisted deadline and recorded miss timestamps. These are snapshots, not a live health verdict. Absence of a miss is not proof that the monitor or scheduler is healthy. An external watchdog must monitor the application separately. Disabling a monitor does not resolve an existing incident.

Configure the sender using the [heartbeat ingress procedure](heartbeat-protocol.md) and the deployment's actual external origin/API prefix. The browser does not send synthetic pings on the user's behalf. Dashboard activation still requires the configured paging/broker runtime; inspection and disabling remain available according to server authorization.

Form, rendering and transport unit cases cover timing bounds, selection-owned versions, read-only controls and scoped grant operations. In an authorized disposable environment, create a disabled monitor, provision a sender, enable it, miss a deadline, send a recovery ping, rotate/revoke the token, and inspect audit/incident history. Browser, database and sender execution remain runtime verification gaps; no infrastructure was started here.
