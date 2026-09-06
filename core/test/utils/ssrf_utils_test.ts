/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  isBlockedAddress,
  isBlockedHostname,
} from '../../src/utils/ssrf_utils.js';

describe('isBlockedHostname', () => {
  it.each([
    'localhost',
    'LocalHost',
    'localhost.',
    'api.localhost',
    'a.b.LOCALHOST.',
  ])('blocks %s', (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  it.each(['notlocalhost', 'localhost.example.com', 'example.com', ''])(
    'allows %s',
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(false);
    },
  );
});

describe('isBlockedAddress', () => {
  it.each([
    ['this host on this network', '0.0.0.1'],
    ['private class A', '10.255.255.254'],
    ['shared address space', '100.64.0.1'],
    ['loopback', '127.0.0.1'],
    ['link-local metadata', '169.254.169.254'],
    ['private class B', '172.16.5.4'],
    ['IETF protocol assignments', '192.0.0.8'],
    ['TEST-NET-1', '192.0.2.5'],
    ['6to4 relay anycast', '192.88.99.1'],
    ['private class C', '192.168.1.1'],
    ['benchmarking', '198.18.0.1'],
    ['TEST-NET-2', '198.51.100.7'],
    ['TEST-NET-3', '203.0.113.7'],
    ['multicast', '224.0.0.1'],
    ['reserved', '240.0.0.1'],
  ])('blocks the %s IPv4 range (%s)', (_range, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1'])(
    'allows the public IPv4 address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each([
    ['unspecified', '::'],
    ['loopback', '::1'],
    ['local NAT64', '64:ff9b:1::1'],
    ['discard-only', '100::1'],
    ['Teredo', '2001::1'],
    ['IETF protocol assignments', '2001:1ff::1'],
    ['documentation', '2001:db8::1'],
    ['unique-local', 'fc00::1'],
    ['link-local', 'fe80::1'],
    ['multicast', 'ff02::1'],
  ])('blocks the %s IPv6 range (%s)', (_range, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '2606:4700:4700::1111',
    '2606:4700:4700:0:0:0:0:1111',
    '2001:4860:4860::8888',
  ])('allows the public IPv6 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    ['IPv4-mapped', '::ffff:127.0.0.1'],
    ['6to4', '2002:7f00:1::'],
    ['NAT64 well-known', '64:ff9b::a9fe:a9fe'],
    ['IPv4-compatible', '::a9fe:a9fe'],
  ])('blocks a %s address wrapping a private IPv4 (%s)', (_form, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ['IPv4-mapped', '::ffff:93.184.216.34'],
    ['6to4', '2002:5db8:d822::'],
    ['NAT64 well-known', '64:ff9b::808:808'],
    ['IPv4-compatible', '::5db8:d822'],
  ])('allows a %s address wrapping a public IPv4 (%s)', (_form, address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('blocks an IPv4-mapped address whose own range is blocked', () => {
    // `::ffff:0:0/96` embeds 0.0.0.0, which is not globally routable.
    expect(isBlockedAddress('::ffff:0.0.0.0')).toBe(true);
  });

  it.each(['not-an-ip', '1.2.3.999', '', '999.999.999.999', '12345'])(
    'fails closed on the unparseable address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );
});
