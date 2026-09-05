/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  assertSchemeAllowed,
  assertUrlAllowed,
  isBlockedHostname,
  normalizeHost,
  validateResolvedAddresses,
} from '../../src/utils/url_safety_utils.js';

// Hoisted so the mock factory and the assertions share one spy, rather than
// casting the overloaded `lookup` signature back to a Mock.
const {lookupMock} = vi.hoisted(() => ({lookupMock: vi.fn()}));

vi.mock('node:dns/promises', () => ({lookup: lookupMock}));

/** Resolves any hostname to the given IP list for the DNS `lookup` mock. */
function resolveTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}

beforeEach(() => {
  lookupMock.mockReset();
});

describe('assertSchemeAllowed', () => {
  it.each(['https://example.com/', 'http://example.com/'])(
    'accepts %s',
    (url) => {
      expect(assertSchemeAllowed(url).hostname).toBe('example.com');
    },
  );

  it('rejects a non-http(s) scheme', () => {
    expect(() => assertSchemeAllowed('file:///etc/passwd')).toThrow(
      'Unsupported url scheme',
    );
  });

  it('rejects a malformed url', () => {
    expect(() => assertSchemeAllowed('not a url')).toThrow();
  });

  // The hostname check is separate so a caller that opts into private network
  // access can skip it without also skipping the scheme check.
  it('accepts localhost, leaving the host to the caller', () => {
    expect(assertSchemeAllowed('http://localhost:8080/').hostname).toBe(
      'localhost',
    );
  });
});

describe('assertUrlAllowed', () => {
  it('accepts a public http(s) url', () => {
    expect(assertUrlAllowed('https://example.com/a').hostname).toBe(
      'example.com',
    );
  });

  it.each([
    ['a non-http(s) scheme', 'file:///etc/passwd'],
    ['a malformed url', 'not a url'],
    ['the localhost hostname', 'http://localhost:8080/'],
    ['a *.localhost hostname', 'http://api.localhost./'],
  ])('rejects %s', (_case, url) => {
    expect(() => assertUrlAllowed(url)).toThrow();
  });
});

describe('isBlockedHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'api.localhost', 'api.localhost.'])(
    'blocks %s',
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(true);
    },
  );

  it.each(['example.com', 'localhost.example.com'])('allows %s', (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(false);
  });
});

describe('normalizeHost', () => {
  it('strips the brackets from an IPv6 url hostname', () => {
    expect(normalizeHost('[::1]')).toBe('::1');
  });

  it('leaves a plain hostname alone', () => {
    expect(normalizeHost('example.com')).toBe('example.com');
  });
});

describe('validateResolvedAddresses', () => {
  it('accepts a public IPv4 literal without a DNS lookup', async () => {
    await expect(
      validateResolvedAddresses('93.184.216.34'),
    ).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('accepts a hostname that resolves to a public address', async () => {
    resolveTo('93.184.216.34');

    await expect(
      validateResolvedAddresses('example.com'),
    ).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledWith('example.com', {all: true});
  });

  it('rejects a loopback IPv4 literal without a DNS lookup', async () => {
    await expect(validateResolvedAddresses('127.0.0.1')).rejects.toThrow(
      'Blocked host: 127.0.0.1',
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects shared address space (CGNAT)', async () => {
    await expect(validateResolvedAddresses('100.64.0.1')).rejects.toThrow(
      'Blocked host',
    );
  });

  it.each([
    '10.1.2.3',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '192.0.2.5',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
  ])('rejects the non-global IPv4 literal %s', async (address) => {
    await expect(validateResolvedAddresses(address)).rejects.toThrow(
      'Blocked host',
    );
  });

  it.each(['::1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '::'])(
    'rejects the non-global IPv6 literal %s',
    async (address) => {
      await expect(validateResolvedAddresses(address)).rejects.toThrow(
        'Blocked host',
      );
      expect(lookupMock).not.toHaveBeenCalled();
    },
  );

  it('rejects an IPv4-mapped IPv6 address pointing at a private IP', async () => {
    resolveTo('::ffff:127.0.0.1');

    await expect(validateResolvedAddresses('mapped.example')).rejects.toThrow(
      'Blocked host',
    );
  });

  it('rejects a private address discovered via DNS', async () => {
    resolveTo('169.254.169.254');

    await expect(
      validateResolvedAddresses('metadata.google.internal'),
    ).rejects.toThrow('Blocked host: metadata.google.internal');
  });

  it('rejects when any one of several resolved addresses is non-global', async () => {
    resolveTo('93.184.216.34', '10.0.0.5');

    await expect(validateResolvedAddresses('mixed.example')).rejects.toThrow(
      'Blocked host',
    );
  });

  it.each([
    ['an unparseable address', 'not-an-ip'],
    ['an out-of-range IPv4', '1.2.3.999'],
  ])('fails closed when DNS resolves to %s', async (_case, address) => {
    resolveTo(address);

    await expect(validateResolvedAddresses('weird.example')).rejects.toThrow(
      'Blocked host',
    );
  });

  it('fails when DNS resolution returns no address', async () => {
    lookupMock.mockResolvedValue([]);

    await expect(validateResolvedAddresses('empty.example')).rejects.toThrow(
      'Unable to resolve host: empty.example',
    );
  });

  it('propagates a DNS resolution failure', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(validateResolvedAddresses('missing.example')).rejects.toThrow(
      'ENOTFOUND',
    );
  });
});
