# Automatic paging configuration

Selected probes and sources expose the same service/environment automatic paging editor in both hosts. It reads the existing versioned binding and lists policies explicitly; it never chooses the first policy as a default.

Create and review schedules, coverage previews, contacts and an enabled policy in On-call settings first. Select the matching service policy, enable automatic paging and save. The binding applies to every source in that service/environment, not only the currently selected probe. Disabled policies cannot be newly selected. A saved reference absent from a paginated list remains visible; saving still relies on server-side policy validation.

Readers see configuration without write actions. Administrators save with the binding's expected version, or null for first creation. Concurrent edits and incomplete host delivery configuration fail rather than silently activating another policy. Refresh after a failed or uncertain response. Disabling the binding is audited and does not resolve existing incidents or cancel their escalation.

Dashboard continues to require the separate delivery/secret broker integration for activation. UI availability does not bypass that server prerequisite. Standalone uses its own session and persistence.

Rendering and transport unit checks complement the existing binding-management authorization, version and audit tests. Both host builds verify typed routing. No live browser, database or provider was used. In an authorized disposable environment, configure two services with different policies, inspect the same binding from multiple sources, exercise stale-version updates, switch scope during a request, and verify that a signal pages only after its binding is enabled.
