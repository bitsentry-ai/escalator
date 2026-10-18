import test from "node:test";
import assert from "node:assert/strict";
import { ProbeDestinationPolicy } from "../src/adapters/probes/policy.js";
test("probe destinations require exact host and port approval", () => {
  const policy = new ProbeDestinationPolicy({
    hosts: [
      { hostname: "example.test", ports: [443] },
      { hostname: "api.internal", ports: [8080] },
    ],
    privateCidrs: [],
  });
  assert.equal(
    policy.target("https://example.test/health").hostname,
    "example.test",
  );
  for (const url of [
    "https://evil.example.test",
    "https://example.test:8443",
    "http://example.test",
    "https://user:pass@example.test",
    "https://example.test/#x",
    "file:///etc/passwd",
  ])
    assert.throws(() => policy.target(url));
  assert.equal(policy.address("93.184.216.34"), true);
  assert.equal(policy.address("10.1.2.3"), false);
});
test("approved private subnets never authorize cloud platform or special-use endpoints", () => {
  const policy = new ProbeDestinationPolicy({
    hosts: [],
    privateCidrs: ["0.0.0.0/0", "::/0"],
  });
  for (const address of [
    "10.1.2.3",
    "192.168.1.2",
    "172.16.5.6",
    "100.64.1.2",
    "fd12::1",
  ])
    assert.equal(policy.address(address), true, address);
  for (const address of [
    "169.254.169.254",
    "169.254.170.2",
    "168.63.129.16",
    "100.100.100.200",
    "fd00:ec2::254",
    "127.0.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "::ffff:169.254.169.254",
    "::ffff:10.1.2.3",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "not-an-ip",
  ])
    assert.equal(policy.address(address), false, address);
});
test("private approval is CIDR-specific and malformed policies fail closed", () => {
  const policy = new ProbeDestinationPolicy({
    hosts: [],
    privateCidrs: ["10.4.0.0/16", "fd12::/32"],
  });
  assert.equal(policy.address("10.4.1.2"), true);
  assert.equal(policy.address("10.5.1.2"), false);
  assert.equal(policy.address("fd12::2"), true);
  assert.equal(policy.address("fd13::2"), false);
  for (const cidr of ["10.0.0.0", "10.0.0.0/33", "::/129", "::/", "bad/8"])
    assert.throws(
      () => new ProbeDestinationPolicy({ hosts: [], privateCidrs: [cidr] }),
    );
  for (const name of [
    "*.example.test",
    "user:pass@example.test",
    "example.test/path",
  ])
    assert.throws(
      () =>
        new ProbeDestinationPolicy({
          hosts: [{ hostname: name, ports: [443] }],
          privateCidrs: [],
        }),
    );
});
