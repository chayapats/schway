import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** A numeric connection destination returned by the trusted resolver. */
export interface WebFetchAddress { readonly address: string; readonly family: 4 | 6 }

/** Resolve all connection candidates without making an HTTP request. */
export type WebFetchResolver = (hostname: string, signal: AbortSignal) => Promise<readonly WebFetchAddress[]>;

/** Additional destination restrictions; only the named development opt-in permits nonpublic addresses. */
export interface WebFetchAddressPolicy {
  /** Exact normalized hostnames; an empty list denies every host, and never overrides the baseline. */
  allowHosts?: readonly string[];
  /** Permit private/local destinations for deliberate local development; never enabled by the CLI. */
  dangerouslyAllowPrivateAddressesForDevelopment?: boolean;
}

/** Resolve names through the OS once; the transport must use only the selected numeric address. */
export const resolveWebAddresses: WebFetchResolver = async hostname => (await lookup(hostname, { all: true, verbatim: true })) as WebFetchAddress[];

/** Stable sanitized refusal shared by address and application URL policies. */
export class BlockedWebAddress extends Error {
  constructor() { super("This destination is blocked. Use a public web address."); }
}

/** Validate every DNS candidate and select one pinned destination before application policy or connection. */
export async function checkedWebAddress(url: URL, policy: WebFetchAddressPolicy, resolve: WebFetchResolver, signal: AbortSignal): Promise<WebFetchAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const development = policy.dangerouslyAllowPrivateAddressesForDevelopment === true;
  if (policy.allowHosts && !policy.allowHosts.includes(host)) throw new BlockedWebAddress();
  if (!development && (host === "localhost" || host.endsWith(".localhost") || host === "metadata" ||
      host === "metadata.google.internal" || host.endsWith(".metadata.google.internal") ||
      host === "instance-data" || host === "instance-data.ec2.internal" || host === "metadata.goog")) throw new BlockedWebAddress();
  const family = isIP(host);
  const addresses = family ? [{ address: host, family: family as 4 | 6 }] : await resolve(host, signal);
  if (!addresses.length) throw Object.assign(new Error("DNS returned no addresses"), { code: "ENOTFOUND" });
  // Fail closed on mixed public/private answers and invalid fixture/custom resolver output.
  for (const candidate of addresses) {
    if (!isIP(candidate.address) || isIP(candidate.address) !== candidate.family || (!development && !publicAddress(candidate.address))) throw new BlockedWebAddress();
  }
  return { ...addresses[0]! };
}

/** Recognize globally routable addresses, refusing translation and tunnel ranges as well as local ranges. */
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number];
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) || a >= 224);
  }
  // URL parsing canonicalizes IPv6, including dotted/mapped representations. Only global unicast
  // is admitted. This excludes ::/96, mapped IPv4, NAT64, ULA, link-local, multicast and scoped forms.
  let canonical: string;
  try { canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1); } catch { return false; }
  const words = canonical.split(":");
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const expanded = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  // ISATAP can embed an IPv4 destination inside an otherwise global unicast prefix.
  if ((Number.parseInt(expanded[4]!, 16) === 0 || Number.parseInt(expanded[4]!, 16) === 0x200) && Number.parseInt(expanded[5]!, 16) === 0x5efe) return false;
  const first = Number.parseInt(words[0]!, 16);
  const second = Number.parseInt(words[1] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}
