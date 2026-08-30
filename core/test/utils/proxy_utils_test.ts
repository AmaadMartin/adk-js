/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  environmentProxyFor,
  proxyAuthHeaders,
} from '../../src/utils/proxy_utils.js';

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
];

describe('environmentProxyFor', () => {
  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns undefined when the environment names no proxy', () => {
    expect(environmentProxyFor('https:', 'example.com')).toBeUndefined();
  });

  it('selects the proxy for the requested scheme', () => {
    vi.stubEnv('https_proxy', 'http://secure.proxy.test:8080');
    vi.stubEnv('http_proxy', 'http://plain.proxy.test:3128');

    expect(environmentProxyFor('https:', 'example.com')?.href).toBe(
      'http://secure.proxy.test:8080/',
    );
    expect(environmentProxyFor('http:', 'example.com')?.href).toBe(
      'http://plain.proxy.test:3128/',
    );
  });

  it('prefers the uppercase spelling over the lowercase one', () => {
    vi.stubEnv('https_proxy', 'http://lower.proxy.test:8080');
    vi.stubEnv('HTTPS_PROXY', 'http://upper.proxy.test:8080');

    expect(environmentProxyFor('https:', 'example.com')?.href).toBe(
      'http://upper.proxy.test:8080/',
    );
  });

  it('treats an empty value as unset', () => {
    vi.stubEnv('HTTPS_PROXY', '');
    vi.stubEnv('https_proxy', 'http://lower.proxy.test:8080');

    expect(environmentProxyFor('https:', 'example.com')?.href).toBe(
      'http://lower.proxy.test:8080/',
    );
  });

  it('falls back to all_proxy when the scheme has no proxy', () => {
    vi.stubEnv('ALL_PROXY', 'http://any.proxy.test:8080');

    expect(environmentProxyFor('https:', 'example.com')?.href).toBe(
      'http://any.proxy.test:8080/',
    );
  });

  it('prefers the scheme proxy over all_proxy', () => {
    vi.stubEnv('ALL_PROXY', 'http://any.proxy.test:8080');
    vi.stubEnv('HTTPS_PROXY', 'http://secure.proxy.test:8080');

    expect(environmentProxyFor('https:', 'example.com')?.href).toBe(
      'http://secure.proxy.test:8080/',
    );
  });

  it.each([
    ['an exact host', 'example.com'],
    ['a parent domain', 'com'],
    ['a leading-dot entry', '.example.com'],
    ['a wildcard', '*'],
    ['a differently cased entry', 'EXAMPLE.COM'],
    ['one entry of a list', 'other.test, example.com ,third.test'],
  ])('bypasses the proxy when no_proxy holds %s', (_case, noProxy) => {
    vi.stubEnv('HTTPS_PROXY', 'http://secure.proxy.test:8080');
    vi.stubEnv('NO_PROXY', noProxy);

    expect(environmentProxyFor('https:', 'example.com')).toBeUndefined();
  });

  it.each([
    ['an unrelated host', 'other.test'],
    ['a suffix that is not a domain boundary', 'ample.com'],
    ['an empty list', ''],
    ['a list of separators', ' , , '],
  ])('does not bypass the proxy when no_proxy holds %s', (_case, noProxy) => {
    vi.stubEnv('HTTPS_PROXY', 'http://secure.proxy.test:8080');
    vi.stubEnv('NO_PROXY', noProxy);

    expect(environmentProxyFor('https:', 'example.com')?.href).toBe(
      'http://secure.proxy.test:8080/',
    );
  });

  it('matches no_proxy against an IPv6 host without brackets', () => {
    vi.stubEnv('HTTP_PROXY', 'http://plain.proxy.test:3128');
    vi.stubEnv('NO_PROXY', '2606:4700:4700::1111');

    expect(
      environmentProxyFor('http:', '2606:4700:4700::1111'),
    ).toBeUndefined();
  });

  it('treats a proxy setting that is not a URL as no proxy', () => {
    vi.stubEnv('HTTPS_PROXY', 'not a url');

    expect(environmentProxyFor('https:', 'example.com')).toBeUndefined();
  });

  it.each([
    ['the scheme-less host:port shorthand', 'proxy.test:8080'],
    ['a scheme this module cannot speak', 'socks5://proxy.test:1080'],
  ])('treats %s as no proxy', (_case, setting) => {
    vi.stubEnv('HTTPS_PROXY', setting);

    expect(environmentProxyFor('https:', 'example.com')).toBeUndefined();
  });

  it('accepts an https proxy', () => {
    vi.stubEnv('HTTPS_PROXY', 'https://secure.proxy.test:8443');

    expect(environmentProxyFor('https:', 'example.com')?.href).toBe(
      'https://secure.proxy.test:8443/',
    );
  });
});

// Assembled rather than written inline so no literal `user:pass@` appears.
const CREDENTIALS = ['user', 'pass'].join(':');
const ESCAPED_CREDENTIALS = ['us%40er', 'p%3Ass'].join(':');

describe('proxyAuthHeaders', () => {
  it('returns no header for a proxy without credentials', () => {
    expect(proxyAuthHeaders(new URL('http://proxy.test:8080'))).toEqual({});
  });

  it('encodes the credentials as HTTP basic authentication', () => {
    const headers = proxyAuthHeaders(
      new URL(`http://${CREDENTIALS}@proxy.test`),
    );

    expect(headers).toEqual({
      'Proxy-Authorization': `Basic ${Buffer.from(CREDENTIALS).toString('base64')}`,
    });
  });

  it('decodes percent-encoded credentials before encoding them', () => {
    const headers = proxyAuthHeaders(
      new URL(`http://${ESCAPED_CREDENTIALS}@proxy.test`),
    );

    expect(headers).toEqual({
      'Proxy-Authorization': `Basic ${Buffer.from('us@er:p:ss').toString('base64')}`,
    });
  });
});
