/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {lookup} from 'node:dns/promises';

import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {
  assertHostnameAllowed,
  assertResolvedAddressesAllowed,
  normalizeHost,
  parseAllowedUrl,
} from '../../src/utils/url_safety_utils.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

// `lookup` is overloaded; treat the mock as a plain Mock so `mockResolvedValue`
// accepts the `{all: true}` array-return shape used by the implementation.
const lookupMock = lookup as unknown as Mock;

/** Resolves any hostname to the given IP list for the DNS `lookup` mock. */
function resolveTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}

describe('parseAllowedUrl', () => {
  it('returns the parsed URL for http and https', () => {
    expect(parseAllowedUrl('http://example.com/a?b=c').hostname).toBe(
      'example.com',
    );
    expect(parseAllowedUrl('https://example.com/').protocol).toBe('https:');
  });

  it('rejects a file: url', () => {
    expect(() => parseAllowedUrl('file:///etc/passwd')).toThrow(
      'Unsupported url scheme: file:///etc/passwd',
    );
  });

  it('rejects an ftp: url', () => {
    expect(() => parseAllowedUrl('ftp://example.com/x')).toThrow(
      'Unsupported url scheme: ftp://example.com/x',
    );
  });

  it('rejects a malformed url', () => {
    expect(() => parseAllowedUrl('not a url')).toThrow();
  });

  it('ends the authority at a backslash, as a browser does', () => {
    // Python needs a special case here because `urlparse` reads the host as
    // `example.com`. WHATWG `URL` reads it as the link-local literal, so the
    // address check sees the address a browser would connect to.
    expect(
      parseAllowedUrl('http://169.254.169.254\\@example.com/').hostname,
    ).toBe('169.254.169.254');
  });
});

describe('assertHostnameAllowed', () => {
  it('accepts a public hostname', () => {
    expect(() => assertHostnameAllowed('example.com')).not.toThrow();
  });

  it('rejects localhost', () => {
    expect(() => assertHostnameAllowed('localhost')).toThrow(
      'Blocked host: localhost',
    );
  });

  it('rejects a *.localhost name with a trailing dot, case-insensitively', () => {
    expect(() => assertHostnameAllowed('SUB.LocalHost.')).toThrow(
      'Blocked host: SUB.LocalHost.',
    );
  });
});

describe('normalizeHost', () => {
  it('strips the brackets from an IPv6 url hostname', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
  });

  it('leaves a plain hostname untouched', () => {
    expect(normalizeHost('example.com')).toBe('example.com');
  });
});

describe('assertResolvedAddressesAllowed', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('accepts a public IPv4 literal without a DNS lookup', async () => {
    await expect(
      assertResolvedAddressesAllowed('93.184.216.34'),
    ).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a private IPv4 literal without a DNS lookup', async () => {
    await expect(assertResolvedAddressesAllowed('10.0.0.5')).rejects.toThrow(
      'Blocked host: 10.0.0.5',
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects the link-local metadata address', async () => {
    await expect(
      assertResolvedAddressesAllowed('169.254.169.254'),
    ).rejects.toThrow('Blocked host: 169.254.169.254');
  });

  it('rejects an IPv4-mapped IPv6 loopback address', async () => {
    await expect(
      assertResolvedAddressesAllowed('::ffff:127.0.0.1'),
    ).rejects.toThrow('Blocked host: ::ffff:127.0.0.1');
  });

  it('accepts a hostname that resolves to a public address', async () => {
    resolveTo('93.184.216.34');

    await expect(
      assertResolvedAddressesAllowed('example.com'),
    ).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledWith('example.com', {all: true});
  });

  it('rejects a hostname when any resolved address is not globally routable', async () => {
    resolveTo('93.184.216.34', '127.0.0.1');

    await expect(
      assertResolvedAddressesAllowed('rebind.example.com'),
    ).rejects.toThrow('Blocked host: rebind.example.com');
  });

  it('fails closed when DNS resolves to an unparseable address', async () => {
    resolveTo('not-an-ip');

    await expect(assertResolvedAddressesAllowed('example.com')).rejects.toThrow(
      'Blocked host: example.com',
    );
  });

  it('throws when DNS resolution yields no address', async () => {
    lookupMock.mockResolvedValue([]);

    await expect(assertResolvedAddressesAllowed('example.com')).rejects.toThrow(
      'Unable to resolve host: example.com',
    );
  });
});
