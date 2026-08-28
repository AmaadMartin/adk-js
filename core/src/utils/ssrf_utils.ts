/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isIP} from 'node:net';

/** An IPv4 CIDR block, precomputed as a network address and a bit mask. */
interface Ipv4Cidr {
  readonly base: number;
  readonly mask: number;
}

/** An IPv6 CIDR block, precomputed as a network address and a prefix length. */
interface Ipv6Cidr {
  readonly base: bigint;
  readonly prefix: number;
}

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
 * IPv6 ranges that are not globally routable and therefore blocked. Ranges that
 * wrap an IPv4 target (`::ffff:0:0/96`, `64:ff9b::/96`, `::a.b.c.d`) are handled
 * separately by extracting the embedded IPv4 address and re-checking it with
 * the IPv4 rules.
 */
const BLOCKED_IPV6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b:1::/48', // local NAT64
  '100::/64', // discard-only
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4 (deprecated, RFC 7526); non-global in Python's ipaddress
  'fc00::/7', // unique-local (ULA, private)
  'fe80::/10', // link-local
  'ff00::/8', // multicast
].map(parseIpv6Cidr);

/** IPv4-mapped IPv6 range: `::ffff:a.b.c.d`. */
const IPV4_MAPPED_PREFIX = parseIpv6Cidr('::ffff:0:0/96');

/** The NAT64 well-known prefix: `64:ff9b::a.b.c.d` routes to `a.b.c.d`. */
const NAT64_WELL_KNOWN_PREFIX = parseIpv6Cidr('64:ff9b::/96');

/**
 * Returns `true` for `localhost` and any `*.localhost` name (case-insensitive,
 * ignoring a trailing dot), matching the Python `_is_blocked_hostname` helper.
 */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.+$/, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

/** Strips the surrounding brackets from an IPv6 URL hostname (`[::1]` → `::1`). */
export function normalizeHost(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

/**
 * Returns `true` when `address` is not globally routable (private, loopback,
 * link-local, shared, reserved, multicast, ...), including IPv6 addresses that
 * embed a non-global IPv4 target. Unparseable input fails closed (blocked).
 */
export function isBlockedAddress(address: string): boolean {
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
function parseIpv4Cidr(cidr: string): Ipv4Cidr {
  const [address, prefix] = cidr.split('/');
  const mask = (0xffffffff << (32 - Number(prefix))) >>> 0;
  return {base: (ipv4ToInt(parseIpv4(address)!) & mask) >>> 0, mask};
}

/** Precomputes the network address and prefix length for an IPv6 CIDR string. */
function parseIpv6Cidr(cidr: string): Ipv6Cidr {
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

/** Returns `true` if the IPv6 address falls within the given block. */
function isInIpv6Cidr(value: bigint, {base, prefix}: Ipv6Cidr): boolean {
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

/**
 * Returns the IPv4 address embedded in an IPv6 address, or `null`.
 *
 * An IPv6 address can be globally routable while the IPv4 target it wraps is
 * not: on a network with NAT64, `64:ff9b::169.254.169.254` reaches the internal
 * `169.254.169.254` metadata endpoint. Extracting the embedded address lets the
 * caller vet the address that traffic actually reaches. 6to4 (`2002::/16`)
 * needs no extraction because the whole range is blocked.
 */
function embeddedIpv4(value: bigint): number[] | null {
  const low32 = value & 0xffffffffn;
  const mapped =
    isInIpv6Cidr(value, IPV4_MAPPED_PREFIX) ||
    isInIpv6Cidr(value, NAT64_WELL_KNOWN_PREFIX);
  // IPv4-compatible `::a.b.c.d` (deprecated), excluding `::` and `::1`.
  if (!mapped && !(value >> 32n === 0n && low32 > 1n)) {
    return null;
  }
  return [
    Number((low32 >> 24n) & 0xffn),
    Number((low32 >> 16n) & 0xffn),
    Number((low32 >> 8n) & 0xffn),
    Number(low32 & 0xffn),
  ];
}

/** Returns `true` if the IPv6 hextets fall within any blocked range. */
function isBlockedIpv6(hextets: number[]): boolean {
  const value = hextetsToBigInt(hextets);
  if (BLOCKED_IPV6_CIDRS.some((cidr) => isInIpv6Cidr(value, cidr))) {
    return true;
  }
  const embedded = embeddedIpv4(value);
  return embedded !== null && isBlockedIpv4(embedded);
}
