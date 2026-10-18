import { BlockList, isIP } from "node:net";
import { isPublicChannelAddress } from "../channels/public-address.js";
export interface ProbeEgressRules {
  /** Exact hostnames/IP literals and ports supplied by the deployment administrator, never a probe form. */
  hosts: readonly { hostname: string; ports: readonly number[] }[];
  privateCidrs: readonly string[];
}
export class ProbeDestinationError extends Error {
  constructor() {
    super("Probe destination denied");
  }
}
const privateAddresses = new BlockList();
for (const [address, bits] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
] as const)
  privateAddresses.addSubnet(address, bits, "ipv4");
const privateV6 = new BlockList();
privateV6.addSubnet("fc00::", 7, "ipv6");
const platformAddresses = new BlockList();
platformAddresses.addAddress("168.63.129.16", "ipv4");
platformAddresses.addAddress("100.100.100.200", "ipv4");
platformAddresses.addAddress("fd00:ec2::254", "ipv6");
function hostname(value: string): string {
  const raw = value.replace(/^\[|\]$/g, "");
  if (isIP(raw))
    return new URL(
      `http://${isIP(raw) === 6 ? `[${raw}]` : raw}`,
    ).hostname.replace(/^\[|\]$/g, "");
  const url = new URL(`http://${value}`);
  if (
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    throw new ProbeDestinationError();
  return url.hostname.toLowerCase().replace(/\.$/, "");
}
/** Public destinations still require a host/port entry; private ranges require additional approval. */
export class ProbeDestinationPolicy {
  private readonly hosts = new Map<string, Set<number>>();
  private readonly approved = new BlockList();
  constructor(rules: ProbeEgressRules) {
    if (rules.hosts.length > 1000 || rules.privateCidrs.length > 1000)
      throw new ProbeDestinationError();
    try {
      for (const entry of rules.hosts) {
        if (
          !entry.ports.length ||
          entry.ports.length > 100 ||
          entry.ports.some(
            (port) => !Number.isInteger(port) || port < 1 || port > 65535,
          )
        )
          throw new ProbeDestinationError();
        const key = hostname(entry.hostname);
        if (this.hosts.has(key) || key.includes("*"))
          throw new ProbeDestinationError();
        this.hosts.set(key, new Set(entry.ports));
      }
      for (const cidr of rules.privateCidrs) {
        const pieces = cidr.split("/");
        const address = pieces[0];
        const bits = Number(pieces[1]);
        const family = isIP(address);
        if (
          pieces.length !== 2 ||
          !/^\d+$/.test(pieces[1]) ||
          !family ||
          !Number.isInteger(bits) ||
          bits < 0 ||
          bits > (family === 4 ? 32 : 128) ||
          address.includes("%")
        )
          throw new ProbeDestinationError();
        this.approved.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
      }
    } catch {
      throw new ProbeDestinationError();
    }
  }
  target(value: string): URL {
    try {
      const url = new URL(value);
      if (
        value.length > 4096 ||
        url.href.length > 4096 ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new ProbeDestinationError();
      const key = hostname(url.hostname);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      if (!this.hosts.get(key)?.has(port)) throw new ProbeDestinationError();
      return url;
    } catch {
      throw new ProbeDestinationError();
    }
  }
  address(value: string): boolean {
    const family = isIP(value);
    if (!family || value.includes("%")) return false;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (platformAddresses.check(value, type)) return false;
    if (isPublicChannelAddress(value)) return true;
    // Loopback, link-local, mapped/translated IPv6, multicast and other special-use addresses never qualify.
    return (
      (family === 4
        ? privateAddresses.check(value, "ipv4")
        : privateV6.check(value, "ipv6")) && this.approved.check(value, type)
    );
  }
}
