/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isBlockedAddress,
  isBlockedHostname,
  normalizeHost,
} from '../../src/utils/ssrf_utils.js';

describe('isBlockedAddress', () => {
  it.each([
    '64:ff9b::169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::10.0.0.1',
  ])('blocks the NAT64 wrapper %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['64:ff9b::8.8.8.8', '64:ff9b::808:808'])(
    'allows the NAT64 wrapper %s around a public address',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each(['::169.254.169.254', '::a9fe:a9fe', '::10.0.0.1'])(
    'blocks the IPv4-compatible address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );

  it.each(['2002:7f00:1::', '2002:5db8:d822::', '2002::1'])(
    'blocks the 6to4 address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );

  it.each([
    '0.0.0.1',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.5.4',
    '192.0.0.1',
    '192.0.2.5',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
  ])('blocks the non-global IPv4 address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1'])(
    'blocks the non-global IPv6 address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );

  it('blocks an IPv4-mapped address pointing at loopback', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8'])(
    'allows the public IPv4 address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each(['2606:4700:4700::1111', '::ffff:93.184.216.34'])(
    'allows the public IPv6 address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it.each(['not-an-ip', '1.2.3.999', '', '::ffff:1.2.3.999'])(
    'fails closed for the unparseable address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );
});

describe('isBlockedHostname', () => {
  it.each(['localhost', 'LOCALHOST.', 'api.localhost', 'api.localhost.'])(
    'blocks %s',
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(true);
    },
  );

  it.each(['localhostx.example', 'example.com', 'my-localhost.example'])(
    'allows %s',
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(false);
    },
  );
});

describe('normalizeHost', () => {
  it('strips the brackets from an IPv6 hostname', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
  });

  it('leaves a plain hostname unchanged', () => {
    expect(normalizeHost('example.com')).toBe('example.com');
  });
});
