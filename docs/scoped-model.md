# Scoped model resolution

Operational workflows resolve a configured model profile by trusted workspace,
service and environment. The profile reader is a host port bound to the live work
claim: it must reject missing, disabled, unauthorized or unbound profiles on every
read, including credential-less local models.

Resolution captures the profile and its revision. Every generation reloads that
profile and rejects any change to its destination, endpoint, model, secret or
scope. The caller cannot override provider/model/URL through the generation
request. Destination metadata describes the configured provider and origin; it
does not attest to a model proxy's downstream routing.

The resolver checks endpoint policy before secret acquisition. SDK profiles
require an opaque secret ID; no environment credential fallback is used. Secrets
are acquired through the existing claim-bound `SecretStore` callback for each
call, with no persistent key or SDK model cache. A callback released after
cancellation cannot start a new provider request. Dashboard activation depends on
the existing secret broker stack and its claim/binding checks.

Generation separates fixed instructions from untrusted input, allows no automatic
tools, sets SDK retries to zero, disables SDK telemetry/input/output recording
and bounds output tokens to 16,384. Instructions
are limited to 16 KiB and input to 256 KiB of UTF-8. The transport also bounds the
serialized request and response. A deadline of at most 120 seconds covers profile
lookup, secret resolution and the model response; caller cancellation is carried
through every operation. Exceptions expose fixed reasons, without raw provider
errors, prompt bodies, credentials or private endpoint details.

Local Ollama uses the configured endpoint's `/api/generate` route with separate
`system`/`prompt`, `stream: false` and a positive `options.num_predict` ceiling.
The response must be complete and nonempty. Missing token usage remains `null`;
the workflow must charge its reserved output budget. Completion also distinguishes
normal stop, token limit and unavailable metadata. A token-limited answer must
remain a partial workflow outcome even if its JSON happens to parse. Neither local failure nor a
provider error selects another model or retries silently.

References: [Ollama generation API](https://docs.ollama.com/api/generate) and
[official request options example](https://github.com/ollama/ollama/blob/main/docs/api.md#generate-request-with-options).
The hosted implementation uses the installed AI SDK 6 declarations; current SDK
7 documentation is not a compatible API reference for this pinned implementation.

## Verification and host integration

Unit tests use configured profile/secret/transport doubles and actual SDK response
parsing, without live model calls or server startup. They exercise scope checks,
profile revision changes, revocation, secret callback lifetime, cancellation,
timeouts, provider errors, local failure without fallback and output validation.
The unchanged worker diagnosis suite remains the compatibility gate.

T5.2 supplies the shared resolver and Ollama path. Host profile CRUD/persistence,
claim authorization, runners and visible destination/report screens follow in
T5.5–T5.7. This part does not activate an investigation or prove broker, database,
container, Encore or live provider behavior. Local/remote host integration must
implement the profile-reader live-claim contract before activation.
