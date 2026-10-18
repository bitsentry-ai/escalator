# Operational evidence validation

`ValidatedEvidenceReader` wraps a host's read-only evidence adapter. It captures
scope and query snapshots, applies one bounded deadline and cancellation signal,
and validates source/kind, incident scope, query window, timestamps, unique IDs
and row limits on the result. Empty success becomes unavailable. Malformed
provenance fails closed; provider exception details are not returned.

The byte allowance covers serialized evidence metadata and UTF-8 text, before
and after redaction. A response that exceeds its allowance is unavailable with
`budget_exhausted`; the wrapper does not silently cut a credential in half before
redaction. Host adapters still must enforce limits while fetching/materializing
rows or response bodies. Post-fetch validation cannot undo an unbounded read. Depth, node and entry limits
used during redaction set explicit item/batch truncation flags; secret masking
alone does not claim a size-based omission. Cancellation is checked again after
redaction before returning usable evidence.

The default redactor removes common structured credential fields, credential
assignments, authorization tokens, private-key blocks and URLs with credentials,
queries or fragments. Known secret values may be supplied by a host-bound
redactor and are matched as literal data, including URL/JSON-escaped forms, in one
case-insensitive pass. Conservative case masking also covers URL escape hex case. It keeps no global cache and rejects oversized inputs/configuration.

Redaction is defense in depth, not proof that arbitrary prose is safe. Each host
must project approved evidence fields and omit credential objects before this
boundary. Unstructured logs and repository content are untrusted input and must
never grant additional tools or credentials. This redactor does not alter the
legacy Dashboard diagnosis compactor.

The wrapper is not an authorization adapter. The inner reader must validate the
live claim, persisted incident scope and current source binding before every
read. Scoped database readers, worker Wazuh access and host activation remain
separate integration work; this component alone does not enable investigations.
