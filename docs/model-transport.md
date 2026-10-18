# Model network boundary

Operational model calls use an administrator-approved endpoint and a dedicated
bounded transport. Probe policy is unchanged. Model profiles cannot grant their
own network access: the deployment supplies an exact hostname/port allowlist,
private CIDRs and explicit permission for local loopback.

A `local` destination permits approved private addresses, plus loopback only when
that permission is enabled. It rejects public addresses, including mixed DNS
answers. A `remote` destination requires HTTPS and public addresses. Both reject
cloud metadata/platform addresses, link-local, multicast, mapped/translated IPv6
and other special-use peers. This is a network classification, not a guarantee
about a proxy's downstream behavior; administrators must know where their chosen
model server sends data.

Each request must remain within the configured origin and base path. The
transport resolves and validates every DNS answer, pins the connection to one
validated address, verifies TLS, disables connection reuse and follows no
redirect. It uses direct Node HTTP(S), without an ambient proxy agent. Changing
DNS cannot redirect an already validated connection. Local failure never causes
a remote request.

Requests are non-streaming JSON POSTs with bounded, allowlisted headers. Request
and response limits cannot exceed 1 MiB each. The caller supplies a timeout of at
most 120 seconds, further bounded by its remaining workflow budget. Both parent
and SDK cancellation are honored, including DNS waits. Compressed responses are
rejected and response bytes are bounded before SDK JSON parsing. Exceptions
contain fixed reason codes, not credentials, prompts, destination URLs or raw
provider error bodies.

## Verification and remaining integration

Unit tests inject DNS and request doubles; they do not start an HTTP server.
They cover local loopback approval, private CIDRs, mixed answers, metadata,
pinned peers, TLS options, origin/path escapes, redirects, unsafe request
shapes, byte limits, truncated/compressed bodies, timeouts and cancellation.

This part supplies transport primitives for T5.2/T5.4. It does not authorize a
profile, acquire a secret, invoke Ollama, schedule an investigation or establish
host parity. The scoped resolver must validate the live work claim and captured
profile binding before each call, resolve an opaque secret through the existing
host secret adapter, disable SDK retries/tools, validate provider output and
publish the explicit model destination. Host activation follows those adapters.
Live model calls and final container/Encore inclusion remain runtime-unverified.
