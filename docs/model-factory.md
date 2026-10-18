# Shared provider construction

The server-only investigation export creates the same six SDK model types as
Dashboard diagnosis: Gemini, Groq, OpenAI, KiloCode, OpenRouter and Anthropic.
The worker compatibility adapter retains provider lookup, model defaults,
configuration errors and its existing OpenRouter attribution headers. The shared
factory sets no attribution headers unless its caller supplies them.

Construction does no network I/O. Credentials are ephemeral inputs, not profile
metadata. This low-level factory is not an authorization or network policy
boundary. Operational investigations must call it through the scoped
`ModelResolver`, with the approved destination, secret callback and bounded
transport. A caller-supplied fetch allows that transport to enforce policy.
Do not pass model output or evidence text as a provider configuration.

This extraction is part of T5.2. The scoped resolver, local Ollama adapter and
bounded generation are delivered in subsequent parts. No investigation runner or
local-to-remote fallback is activated here. The existing Dashboard workflow keeps
its current behavior; this factory alone does not impose new runtime guarantees.

## Dependency review

The standalone workspace pins the existing worker's SDK API versions to avoid
changing provider selection during extraction. Its override upgrades
`@ai-sdk/provider-utils` 4.0.15 to 4.0.45, which includes the response-size fix for
[GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8).
The root lockfile still contains the affected 4.0.15 dependency used by other
worker SDK imports. Follow-up: update and regression-test those existing worker
dependencies separately. This is a targeted dependency review, not an exhaustive
audit or a claim that arbitrary model responses are safe to materialize.

The worker staging helper already collects production dependencies with
`pnpm deploy`. Verify that staged CommonJS and ESM investigation exports load
without the standalone source tree, including the provider SDK dependencies.
An Encore/Docker-equipped environment must still verify the final image; staged
artifact imports do not prove image inclusion.
