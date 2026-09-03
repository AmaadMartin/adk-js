/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {lookup} from 'node:dns/promises';

import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {
  assertPubliclyRoutable,
  hasBackslashInAuthority,
  isBlockedHostname,
  parseRequestTarget,
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

describe('url_safety_utils', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  describe('parseRequestTarget', () => {
    it('returns the parsed url and hostname for an http(s) target', () => {
      const target = parseRequestTarget('https://example.com/search?q=adk');

      expect(target.hostname).toBe('example.com');
      expect(target.url.pathname).toBe('/search');
      expect(target.url.search).toBe('?q=adk');
    });

    it('strips the brackets from an IPv6 literal host', () => {
      expect(
        parseRequestTarget('http://[2001:4860:4860::8888]/').hostname,
      ).toBe('2001:4860:4860::8888');
    });

    it('rejects a scheme other than http(s)', () => {
      expect(() => parseRequestTarget('file:///etc/passwd')).toThrow(
        'Unsupported url scheme: file:///etc/passwd',
      );
      expect(() => parseRequestTarget('ftp://example.com/x')).toThrow(
        'Unsupported url scheme',
      );
    });

    it('rejects a malformed url', () => {
      expect(() => parseRequestTarget('not a url')).toThrow();
      expect(() => parseRequestTarget('http://')).toThrow();
    });

    it('rejects a url whose port is out of range', () => {
      expect(() => parseRequestTarget('http://example.com:99999/')).toThrow(
        'Invalid URL',
      );
    });

    it('rejects a url with no hostname', () => {
      expect(() => parseRequestTarget('http://:8080/')).toThrow('Invalid URL');
      expect(() => parseRequestTarget('http://@/')).toThrow('Invalid URL');
    });
  });

  describe('hasBackslashInAuthority', () => {
    it('detects a backslash before the path starts', () => {
      expect(
        hasBackslashInAuthority('http://169.254.169.254\\@example.com/'),
      ).toBe(true);
      expect(hasBackslashInAuthority('http://example.com\\evil.com/')).toBe(
        true,
      );
    });

    it('ignores a backslash in the path, query or fragment', () => {
      expect(hasBackslashInAuthority('https://example.com/a\\b')).toBe(false);
      expect(hasBackslashInAuthority('https://example.com/?a=\\')).toBe(false);
      expect(hasBackslashInAuthority('https://example.com/#\\')).toBe(false);
    });

    it('returns false for a plain url', () => {
      expect(hasBackslashInAuthority('https://example.com:8443/x')).toBe(false);
    });
  });

  describe('isBlockedHostname', () => {
    it('blocks localhost and its subdomains, case- and dot-insensitively', () => {
      expect(isBlockedHostname('localhost')).toBe(true);
      expect(isBlockedHostname('LOCALHOST.')).toBe(true);
      expect(isBlockedHostname('api.localhost')).toBe(true);
      expect(isBlockedHostname('api.LocalHost..')).toBe(true);
    });

    it('allows a public hostname', () => {
      expect(isBlockedHostname('example.com')).toBe(false);
      expect(isBlockedHostname('localhost.example.com')).toBe(false);
    });
  });

  describe('assertPubliclyRoutable', () => {
    it('accepts a host that resolves to a public address', async () => {
      resolveTo('93.184.216.34');

      await expect(
        assertPubliclyRoutable('example.com'),
      ).resolves.toBeUndefined();
      expect(lookupMock).toHaveBeenCalledOnce();
    });

    it('rejects a host that resolves to a private address', async () => {
      resolveTo('10.1.2.3');

      await expect(
        assertPubliclyRoutable('internal.example.com'),
      ).rejects.toThrow('Blocked host: internal.example.com');
    });

    it('rejects when any one of several resolved addresses is blocked', async () => {
      resolveTo('93.184.216.34', '169.254.169.254');

      await expect(assertPubliclyRoutable('split.example.com')).rejects.toThrow(
        'Blocked host',
      );
    });

    it('rejects when the host resolves to no address', async () => {
      lookupMock.mockResolvedValue([]);

      await expect(assertPubliclyRoutable('void.example.com')).rejects.toThrow(
        'Unable to resolve host: void.example.com',
      );
    });

    it('fails closed when a resolved address is unparseable', async () => {
      resolveTo('not-an-ip');

      await expect(assertPubliclyRoutable('weird.example.com')).rejects.toThrow(
        'Blocked host',
      );
    });

    it('fails closed when a resolved IPv4 address is out of range', async () => {
      resolveTo('999.1.2.3');

      await expect(assertPubliclyRoutable('weird.example.com')).rejects.toThrow(
        'Blocked host',
      );
    });

    it.each([
      ['169.254.169.254', 'link-local metadata'],
      ['127.0.0.1', 'loopback'],
      ['10.0.0.1', 'private'],
      ['172.16.0.1', 'private'],
      ['192.168.1.1', 'private'],
      ['100.64.0.1', 'shared address space'],
      ['0.0.0.0', 'this host'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'reserved'],
    ])('blocks the %s IPv4 literal without a lookup (%s)', async (address) => {
      await expect(assertPubliclyRoutable(address)).rejects.toThrow(
        `Blocked host: ${address}`,
      );
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it.each([
      ['::1', 'loopback'],
      ['fe80::1', 'link-local'],
      ['fd00::1', 'unique-local'],
      ['ff02::1', 'multicast'],
      ['64:ff9b:1::a9fe:a9fe', 'local NAT64 embedding link-local IPv4'],
      ['::ffff:169.254.169.254', 'IPv4-mapped link-local'],
      ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ])('blocks the %s IPv6 literal (%s)', async (address) => {
      await expect(assertPubliclyRoutable(address)).rejects.toThrow(
        'Blocked host',
      );
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it.each([
      ['93.184.216.34', 'public IPv4'],
      ['2001:4860:4860::8888', 'public IPv6'],
      ['::ffff:93.184.216.34', 'IPv4-mapped public IPv4'],
    ])('accepts the %s literal (%s)', async (address) => {
      await expect(assertPubliclyRoutable(address)).resolves.toBeUndefined();
      expect(lookupMock).not.toHaveBeenCalled();
    });
  });
});
