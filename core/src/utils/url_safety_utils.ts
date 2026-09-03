/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

/** URL schemes that may be requested (WHATWG `URL.protocol` form). */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * IPv4 ranges that are not globally routable and therefore blocked to defeat
 * SSRF. Mirrors the non-global ranges rejected by Python's
 * `ipaddress.is_global`.
 */
const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8', // "this host on this network"
  '10.0.0.0/8', // private
  '100.64.0.0/10', // shared address space / CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local (includes GCP metadata 169.254.169.254)
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1 (documentation)
  '192.88.99.0/24', // 6to4 relay anycast (deprecated)
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2 (documentation)
  '203.0.113.0/24', // TEST-NET-3 (documentation)
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved / future use (includes 255.255.255.255)
].map(parseIpv4Cidr);

/**
 * IPv6 ranges that are not globally routable and therefore blocked. The
 * IPv4-mapped range `::ffff:0:0/96` is handled separately by extracting the
 * embedded IPv4 address and re-checking it with the IPv4 rules.
 */
const BLOCKED_IPV6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b:1::/48', // local NAT64
  '100::/64', // discard-only
  '2001:db8::/32', // documentation
  'fc00::/7', // unique-local (ULA, private)
  'fe80::/10', // link-local
  'ff00::/8', // multicast
].map(parseIpv6Cidr);

/** Matches the scheme and the `//` that introduce a url's authority. */
const SCHEME_PREFIX = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * Checks the shape of `url` and returns its host: it must be a well-formed
 * `http`/`https` url. The WHATWG parser this uses rejects an `http` url that
 * carries no hostname or an out-of-range port, so those need no separate check.
 *
 * Performs no network access. Says nothing about where the host points; pass
 * the result to {@link isBlockedHostname} and {@link assertPubliclyRoutable}
 * for that.
 *
 * @param url The url to check.
 * @return The host, with the brackets of an IPv6 literal removed.
 * @throws If the url is malformed or uses another scheme.
 */
export function parseTargetHostname(url: string): string {
  const parsed = new URL(url);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Unsupported url scheme: ${url}`);
  }
  return normalizeHost(parsed.hostname);
}

/**
 * Whether the authority of `url` as written contains a backslash.
 *
 * Url parsers disagree on it: in `http://169.254.169.254\@example.com/` a
 * browser and the WHATWG parser read the host as `169.254.169.254`, while
 * Python's `urlparse` reads it as `example.com`. A caller that hands the url
 * to a second parser cannot know which host it will reach, so it should refuse
 * the url rather than vet either answer.
 *
 * @param url The url as the caller received it, before parsing.
 * @return Whether the authority contains a backslash.
 */
export function hasBackslashInAuthority(url: string): boolean {
  const afterScheme = url.replace(SCHEME_PREFIX, '');
  const [authority] = afterScheme.split(/[/?#]/, 1);
  return authority.includes('\\');
}

/**
 * Returns `true` for `localhost` and any `*.localhost` name (case-insensitive,
 * ignoring a trailing dot), matching the Python `_is_blocked_hostname` helper.
 */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.+$/, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

/**
 * Resolves `hostname` and throws unless every address it resolves to is
 * globally routable. An IP literal is checked directly, without a lookup.
 *
 * Known limitation: a caller that connects afterwards performs its own DNS
 * resolution, so a time-of-check/time-of-use (DNS-rebinding) window remains
 * between this lookup and the caller's. Closing it needs the connection to be
 * pinned to the address checked here.
 *
 * @param hostname The host to check, without IPv6 brackets.
 * @throws If the host does not resolve, or resolves to a blocked address.
 */
export async function assertPubliclyRoutable(hostname: string): Promise<void> {
  const addresses = await resolveHostAddresses(hostname);
  if (addresses.some(isBlockedAddress)) {
    throw new Error(`Blocked host: ${hostname}`);
  }
}

/** Strips the surrounding brackets from an IPv6 URL hostname (`[::1]` → `::1`). */
function normalizeHost(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

/** Parses a dotted-quad IPv4 string into its four octets, or `null`. */
function parseIpv4(address: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  return octets;
}

/** Expands a valid IPv6 address string into its eight 16-bit hextets, or `null`. */
function parseIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) {
    return null;
  }
  const [head, tail] = address.split('::');
  const highGroups = head ? expandHextets(head) : [];
  const lowGroups = tail ? expandHextets(tail) : [];
  const compressed = address.includes('::')
    ? new Array(8 - highGroups.length - lowGroups.length).fill(0)
    : [];
  return [...highGroups, ...compressed, ...lowGroups];
}

/**
 * Converts a colon-separated IPv6 fragment into hextets, expanding a trailing
 * embedded IPv4 group (e.g. the `1.2.3.4` in `::ffff:1.2.3.4`) into two hextets.
 */
function expandHextets(fragment: string): number[] {
  const hextets: number[] = [];
  for (const group of fragment.split(':')) {
    if (group.includes('.')) {
      const octets = parseIpv4(group)!;
      hextets.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    } else {
      hextets.push(parseInt(group, 16));
    }
  }
  return hextets;
}

/** Packs four IPv4 octets into an unsigned 32-bit integer. */
function ipv4ToInt(octets: number[]): number {
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
}

/** Packs eight IPv6 hextets into a 128-bit BigInt. */
function hextetsToBigInt(hextets: number[]): bigint {
  let value = 0n;
  for (const hextet of hextets) {
    value = (value << 16n) | BigInt(hextet);
  }
  return value;
}

/** Precomputes the network address and mask for an IPv4 CIDR string. */
function parseIpv4Cidr(cidr: string): {base: number; mask: number} {
  const [address, prefix] = cidr.split('/');
  const mask = (0xffffffff << (32 - Number(prefix))) >>> 0;
  return {base: (ipv4ToInt(parseIpv4(address)!) & mask) >>> 0, mask};
}

/** Precomputes the network address and prefix length for an IPv6 CIDR string. */
function parseIpv6Cidr(cidr: string): {base: bigint; prefix: number} {
  const [address, prefix] = cidr.split('/');
  return {base: hextetsToBigInt(parseIpv6(address)!), prefix: Number(prefix)};
}

/** Returns `true` if the IPv4 octets fall within any blocked range. */
function isBlockedIpv4(octets: number[]): boolean {
  const value = ipv4ToInt(octets);
  return BLOCKED_IPV4_CIDRS.some(
    ({base, mask}) => (value & mask) >>> 0 === base,
  );
}

/** Returns `true` if the IPv6 hextets fall within any blocked range. */
function isBlockedIpv6(hextets: number[]): boolean {
  const value = hextetsToBigInt(hextets);
  // IPv4-mapped (::ffff:0:0/96): re-check the embedded IPv4 address.
  if (value >> 32n === 0xffffn) {
    return isBlockedIpv4([
      Number((value >> 24n) & 0xffn),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    ]);
  }
  return BLOCKED_IPV6_CIDRS.some(
    ({base, prefix}) =>
      value >> BigInt(128 - prefix) === base >> BigInt(128 - prefix),
  );
}

/**
 * Returns `true` when `address` is not globally routable (private, loopback,
 * link-local, shared, reserved, multicast, ...). Unparseable input fails
 * closed (blocked).
 */
function isBlockedAddress(address: string): boolean {
  const octets = parseIpv4(address);
  if (octets) {
    return isBlockedIpv4(octets);
  }
  const hextets = parseIpv6(address);
  if (hextets) {
    return isBlockedIpv6(hextets);
  }
  return true;
}

/**
 * Resolves `hostname` to a de-duplicated list of IP addresses. IP literals are
 * returned as-is; hostnames are resolved via DNS. Throws when resolution
 * yields no address.
 */
async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname) !== 0) {
    return [hostname];
  }
  const records = await lookup(hostname, {all: true});
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve host: ${hostname}`);
  }
  return addresses;
}
