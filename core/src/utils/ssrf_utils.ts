/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Address classification helpers used to refuse a request to a host that is
 * not globally routable, which is the defence against server-side request
 * forgery (SSRF).
 */

import {isIP} from 'node:net';

/** An IPv4 CIDR range, pre-parsed into a network address and a mask. */
interface Ipv4Cidr {
  base: number;
  mask: number;
}

/** An IPv6 CIDR range, pre-parsed into a network address and a prefix length. */
interface Ipv6Cidr {
  base: bigint;
  prefix: number;
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

/**
 * Converts a colon-separated IPv6 fragment into hextets, expanding a trailing
 * embedded IPv4 group (e.g. the `1.2.3.4` in `::ffff:1.2.3.4`) into two hextets.
 */
function expandHextets(fragment: string): number[] {
  const hextets: number[] = [];
  for (const group of fragment.split(':')) {
    if (group.includes('.')) {
      // The caller has already accepted the address, so an embedded IPv4 group
      // is four decimal octets.
      const octets = group.split('.').map(Number);
      hextets.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    } else {
      hextets.push(parseInt(group, 16));
    }
  }
  return hextets;
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
  const octets = parseIpv4(address);
  if (!octets) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  const mask = (0xffffffff << (32 - Number(prefix))) >>> 0;
  return {base: (ipv4ToInt(octets) & mask) >>> 0, mask};
}

/** Precomputes the network address and prefix length for an IPv6 CIDR string. */
function parseIpv6Cidr(cidr: string): Ipv6Cidr {
  const [address, prefix] = cidr.split('/');
  const hextets = parseIpv6(address);
  if (!hextets) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  return {base: hextetsToBigInt(hextets), prefix: Number(prefix)};
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
 * IPv6 ranges that are not globally routable and therefore blocked. Ranges
 * that wrap an IPv4 address are handled by {@link embeddedIpv4} instead, which
 * re-checks the address they carry.
 *
 * Python's `ipaddress` carves a few globally-routable blocks out of
 * `2001::/23` (`2001:1::1`, `2001:20::/28`, ...). This port blocks the whole
 * range, so it refuses a handful of addresses Python would fetch.
 */
const BLOCKED_IPV6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  '64:ff9b:1::/48', // local NAT64
  '100::/64', // discard-only
  '2001::/23', // Teredo and IETF protocol assignments
  '2001:db8::/32', // documentation
  'fc00::/7', // unique-local (ULA, private)
  'fe80::/10', // link-local
  'ff00::/8', // multicast
].map(parseIpv6Cidr);

/** The well-known NAT64 translation prefix, RFC 6052. */
const NAT64_WELL_KNOWN_PREFIX = parseIpv6Cidr('64:ff9b::/96');

/** The 6to4 prefix, RFC 3056, which carries the IPv4 address in bits 16-47. */
const SIXTOFOUR_PREFIX = parseIpv6Cidr('2002::/16');

/** Splits an unsigned 32-bit IPv4 value into its four octets. */
function intToIpv4(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/** Returns `true` when the 128-bit `value` falls inside `cidr`. */
function inIpv6Cidr(value: bigint, cidr: Ipv6Cidr): boolean {
  const shift = BigInt(128 - cidr.prefix);
  return value >> shift === cidr.base >> shift;
}

/**
 * Returns the IPv4 address embedded in a 128-bit IPv6 value, or `null`.
 *
 * Whether the outer IPv6 address is globally routable says nothing about the
 * reachability of the IPv4 address it wraps. `64:ff9b::169.254.169.254` looks
 * global, but on a network with NAT64 it routes to the `169.254.169.254`
 * metadata endpoint, so the embedded address has to be vetted on its own.
 */
function embeddedIpv4(value: bigint): number[] | null {
  const low = Number(value & 0xffffffffn);
  // IPv4-mapped, ::ffff:a.b.c.d.
  if (value >> 32n === 0xffffn) {
    return intToIpv4(low);
  }
  if (inIpv6Cidr(value, SIXTOFOUR_PREFIX)) {
    return intToIpv4(Number((value >> 80n) & 0xffffffffn));
  }
  if (inIpv6Cidr(value, NAT64_WELL_KNOWN_PREFIX)) {
    return intToIpv4(low);
  }
  // IPv4-compatible ::a.b.c.d (deprecated). `::` and `::1` are ordinary IPv6
  // addresses that the CIDR table already covers, not wrapped IPv4.
  if (value >> 32n === 0n && low !== 0 && low !== 1) {
    return intToIpv4(low);
  }
  return null;
}

/** Returns `true` if the IPv4 octets fall within any blocked range. */
function isBlockedIpv4(octets: number[]): boolean {
  const value = ipv4ToInt(octets);
  return BLOCKED_IPV4_CIDRS.some(
    ({base, mask}) => (value & mask) >>> 0 === base,
  );
}

/** Returns `true` if the IPv6 hextets are blocked, directly or by what they wrap. */
function isBlockedIpv6(hextets: number[]): boolean {
  const value = hextetsToBigInt(hextets);
  if (BLOCKED_IPV6_CIDRS.some((cidr) => inIpv6Cidr(value, cidr))) {
    return true;
  }
  const embedded = embeddedIpv4(value);
  return embedded !== null && isBlockedIpv4(embedded);
}

/**
 * Returns `true` for `localhost` and any `*.localhost` name (case-insensitive,
 * ignoring a trailing dot), matching Python's `_is_blocked_hostname`.
 */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.+$/, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost');
}

/**
 * Returns `true` when `address` is not globally routable (private, loopback,
 * link-local, shared, reserved, multicast, ...) or embeds an IPv4 address that
 * is not. `address` is an IP literal with any surrounding brackets already
 * stripped. Unparseable input fails closed (blocked).
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
