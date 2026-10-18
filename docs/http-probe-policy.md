# HTTP probe execution policy

This layer provides configuration, assertion evaluation, failure/recovery thresholds and a bounded HTTP runner. Durable scheduling, probe persistence and host activation follow in subsequent stack layers; it does not start a scheduler or expose a probe configuration endpoint by itself.

## Deployment authorization

The deployment administrator supplies `ProbeEgressRules`: exact hostnames or IP literals and allowed ports. The default is deny all. Probe authors cannot grant network access by changing a probe's URL. A private destination additionally requires an approved CIDR. Public destinations still require an exact host/port entry.

Only HTTP and HTTPS are supported. Userinfo and fragments are rejected. Every DNS answer must pass the address policy before a connection is made. The request pins one validated address and keeps certificate verification enabled. Redirects undergo a new host, port and DNS check, including redirects to the same hostname. There are at most three redirects, and POST never follows a redirect. Authenticated probes require HTTPS and cannot redirect credentials outside the original origin.

Loopback, link-local, multicast, mapped/translated IPv6 and other reserved address ranges remain denied even with broad private CIDR approval. Additional fixed cloud addresses are denied:

- [Azure platform virtual IP](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16): `168.63.129.16`.
- [Alibaba instance metadata](https://www.alibabacloud.com/help/en/ecs/user-guide/view-instance-metadata/): `100.100.100.200`.
- [AWS IPv6 instance metadata](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html): `fd00:ec2::254`.

An allowed public service can itself proxy requests. Administrators must therefore approve destinations they trust and apply deployment firewall restrictions as an additional boundary. The runner does not use an environment proxy or pooled connection that could bypass its validated peer.

## Requests and results

GET and HEAD have no request body. HEAD supports status assertions only. A POST is always a deliberate synthetic write: configuration must include a JSON test marker present in the body, an idempotency header and cleanup guidance. The runner derives a stable idempotency key from the workspace and durable run ID. Operators must configure a target that honors that key and follow the cleanup guidance; the runner cannot enforce target-side idempotency or delete test records.

Credentials are opaque secret IDs. The authorized job resolves a secret through the host's secret port. Its JSON value contains only `header` (`authorization` or `x-api-key`) and `value`. Tokens belong in the secret store, never in a URL or request body. Credential headers are removed after use. Persisted observations contain verdict, static reason, status and duration; they contain no response bodies, URLs or credentials.

Execution bounds:

| Resource                                     | Limit                                                      |
| -------------------------------------------- | ---------------------------------------------------------- |
| Request timeout, including DNS and redirects | 100–10,000 ms                                              |
| Response body                                | Configurable 1–262,144 bytes                               |
| Response headers                             | 16,384 bytes                                               |
| POST body                                    | 16,384 characters; transport also caps 65,536 bytes        |
| DNS answers                                  | 64, all validated                                          |
| JSON assertions                              | 16; each path at most 8 segments                           |
| Parsed JSON                                  | 10,000 nodes, depth 16                                     |
| Probe interval                               | 60–3,600 seconds                                           |
| Consecutive failure/recovery threshold       | 1–10; critical probes fail on the first failed observation |

Assertions compare expected status, literal text and bounded own-property JSON paths with equality or numeric bounds. No regular expressions, scripts or JSONPath evaluation run. Network failure, timeout or assertion failure is a failed observation. Denied destinations, secret errors, oversized responses, invalid configuration and cancellations are unknown observations. Unknown data resets consecutive counters and never clears an active failure. Recovery requires successful observations; an edit or silence cannot manufacture recovery. Stale versions and non-increasing timestamps do not change state.
