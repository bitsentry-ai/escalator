# Investigation configuration contract

Each service/environment selects one model profile. Both hosts use the shared
settings use cases and transaction wrapper. A profile contains the displayed
provider, model, local/remote destination and endpoint, an opaque secret ID,
budgets and evidence source selections. It contains no credentials or fallback.
Creating settings requires an explicit enabled value; host forms should default
to disabled until the operator configures the destination and sources.

The host constructs the actor from its session. Administrators manage settings;
responders and viewers can read them. Creation assigns identity and revision;
each edit uses compare-and-swap and increments the revision, including disabling
or changing source links. That revision invalidates captured queued/running
configuration through the existing investigation authorization policy.

## Adapter obligations

Use a scoped database transaction and the shared transaction guard. Lock the
service/environment before reading the selected profile, including when there
is no profile yet, so simultaneous creation cannot select two models. Persist a
unique selection, immutable service/environment identity and normalized source
link rows atomically with the profile and audit event. Every read must filter by
the trusted workspace; Dashboard uses the WorkOS organization ID.

Source authorization must check the selected service/environment, ownership,
current source generation and actor access, locking mutable metadata in a
consistent order. Ambiguous legacy ownership denies linking. Secret authorization
must check ownership, model purpose and destination using metadata only; neither
Vault nor provider network calls belong in the transaction. Secretless Ollama
needs no secret authorization callback. Runtime authorization is separate and
must recheck a live claim and current bindings before each evidence/model read.

Disabling an otherwise unchanged profile is permitted after source or secret
revocation. Enabling it, changing its bindings or creating even a disabled
profile requires authorization. Disabled services cannot enable investigations.
Audit metadata contains revision, enabled state and source count; it does not
contain credentials, provider endpoints or evidence content.

Source selections specify kind, opaque ID, relative lookback (at most 24 hours)
and count (at most 100). Hosts derive absolute windows from trusted incident and
database time at enqueue. They must never interpret these IDs as arbitrary URLs,
SQL, shell commands or model-generated queries. Scope validation in this contract
does not itself prove a source's ownership; the host store supplies that proof.

## Model credentials

The dedicated model-secret input encodes a strict JSON bearer bundle with a
single `token` field, compatible with the Dashboard broker's credential format.
The writer owns and must erase the encoded bytes. `modelCredentialSecrets`
projects that bundle to raw SDK bytes only inside the host-approved secret
callback, forwards the claim unchanged and wipes its temporary byte buffer on
success, failure or cancellation. Malformed data and provider exceptions receive
a fixed error. JavaScript strings cannot be reliably zeroed; never log parsed
credentials or retain them outside the bounded callback.

This projection adds no authorization and does not alter generic source/channel
secret formats. D3 still requires integration with the separate Dashboard broker
stack, including purpose/destination and generation/revocation enforcement.
