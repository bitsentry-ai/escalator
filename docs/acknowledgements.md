# Capability acknowledgement surface

Both hosts serve the same compiled acknowledgement screen directly from their
acknowledgement controller. It has no login, telemetry, external scripts or
persistent browser storage. The browser asset includes React; server controllers
only read and serve its bytes and never import React or the UI export.

Configure paging links with the public API base URL. Standalone uses
`ESCALATOR_PUBLIC_URL` (an origin). The Dashboard broker binding must use the
backend public URL including its configured API prefix, for example
`https://api.example.test/api/`. Do not point this binding at the Dashboard SPA:
its ordinary entry loads telemetry and does not serve this isolated surface.

- `GET <base>/ack/<workspace>` returns the screen without reading or changing a page.
- `GET <base>/ack/assets/client.js` returns the compiled browser asset; the workspace-relative alias also supports a trailing slash on the screen URL.
- `GET <base>/ack/<workspace>/state` previews the grant using a bearer header.
- `POST <base>/ack/<workspace>/state` acknowledges using the same bearer capability.

Delivery links place the random token in the URL fragment. The screen captures
it in memory and immediately removes the fragment from browser history. It sends
no cookies and puts no token in query parameters or request bodies. A refresh
after that removal requires reopening the original notification link.
Acknowledgement happens only after the recipient clicks the button. Unknown,
expired, malformed and foreign capabilities yield the same invalid state.
The existing shared transaction owns acknowledgement, work cancellation and audit.

These endpoints are the plan's explicit acknowledgement HTTP exception to
Dashboard application tRPC. Standalone checks its configured workspace;
Dashboard checks its rollout allowlist before database access. Capability checks
remain required regardless of cookies or any WorkOS session. Responses disable
caching and referrers; the screen has a restrictive same-origin content policy.

## Verification and deployment procedure

Unit tests cover GET/POST separation, scope rejection, fragment removal, request
transport, explicit button activation and both controller adapters. Existing
paging conformance covers expired/foreign grants and atomic ownership. The
shared screen uses a fluid border-box layout and full-width acknowledgement
button; check it at 360px width on the target device before rollout.

After applying migrations in an authorized environment, create a configured
page, open its notification link, confirm that merely opening it does not
acknowledge, then press the button and verify persisted ownership and cancellation.
Repeat with an expired link, a different workspace and a concurrent recipient.
Verify the reverse proxy forwards the acknowledgement paths to the API and
redacts authorization headers. Never put the token into access logs.

No HTTP server, PostgreSQL or browser runtime was started during implementation.
Live mobile rendering and deployment routing are not runtime-verified. Dashboard
paging activation still depends on integrating the separate secret-broker stack.
