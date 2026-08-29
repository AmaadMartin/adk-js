/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {selectProxy} from '../../src/utils/proxy_utils.js';

const HTTP_PROXY = 'http://http-proxy.example.test:8080';
const HTTPS_PROXY = 'http://https-proxy.example.test:8080';
const ALL_PROXY = 'http://all-proxy.example.test:8080';

describe('selectProxy', () => {
  it('returns undefined when the environment names no proxy', () => {
    expect(selectProxy(new URL('https://example.com/'), {})).toBeUndefined();
  });

  it('prefers https_proxy for an https url', () => {
    const env = {https_proxy: HTTPS_PROXY, http_proxy: HTTP_PROXY};

    expect(selectProxy(new URL('https://example.com/'), env)).toBe(HTTPS_PROXY);
  });

  it('prefers http_proxy for an http url', () => {
    const env = {https_proxy: HTTPS_PROXY, http_proxy: HTTP_PROXY};

    expect(selectProxy(new URL('http://example.com/'), env)).toBe(HTTP_PROXY);
  });

  it('falls back to all_proxy when the scheme has no proxy', () => {
    const env = {all_proxy: ALL_PROXY, http_proxy: HTTP_PROXY};

    expect(selectProxy(new URL('https://example.com/'), env)).toBe(ALL_PROXY);
  });

  it.each([
    ['HTTPS_PROXY', {HTTPS_PROXY: HTTPS_PROXY}, HTTPS_PROXY],
    ['ALL_PROXY', {ALL_PROXY: ALL_PROXY}, ALL_PROXY],
  ])('reads the uppercase name %s', (_name, env, expected) => {
    expect(selectProxy(new URL('https://example.com/'), env)).toBe(expected);
  });

  it('treats an empty value as unset', () => {
    const env = {https_proxy: '', all_proxy: ALL_PROXY};

    expect(selectProxy(new URL('https://example.com/'), env)).toBe(ALL_PROXY);
  });

  describe('no_proxy', () => {
    it('bypasses every host for *', () => {
      const env = {https_proxy: HTTPS_PROXY, no_proxy: '*'};

      expect(selectProxy(new URL('https://example.com/'), env)).toBeUndefined();
    });

    it('bypasses the named host and leaves another proxied', () => {
      const env = {https_proxy: HTTPS_PROXY, no_proxy: 'example.com'};

      expect(selectProxy(new URL('https://example.com/'), env)).toBeUndefined();
      expect(selectProxy(new URL('https://other.test/'), env)).toBe(
        HTTPS_PROXY,
      );
    });

    it.each(['.example.com', 'example.com'])(
      'matches the subdomain of the entry %s',
      (entry) => {
        const env = {https_proxy: HTTPS_PROXY, no_proxy: entry};

        expect(
          selectProxy(new URL('https://api.example.com/'), env),
        ).toBeUndefined();
      },
    );

    it('matches a host:port entry only on that port', () => {
      const env = {https_proxy: HTTPS_PROXY, no_proxy: 'example.com:8443'};

      expect(
        selectProxy(new URL('https://example.com:8443/'), env),
      ).toBeUndefined();
      expect(selectProxy(new URL('https://example.com:9443/'), env)).toBe(
        HTTPS_PROXY,
      );
    });

    it('ignores whitespace and empty entries in the list', () => {
      const env = {https_proxy: HTTPS_PROXY, no_proxy: ' , example.com ,'};

      expect(selectProxy(new URL('https://example.com/'), env)).toBeUndefined();
    });

    it('reads the uppercase NO_PROXY name', () => {
      const env = {https_proxy: HTTPS_PROXY, NO_PROXY: 'example.com'};

      expect(selectProxy(new URL('https://example.com/'), env)).toBeUndefined();
    });

    it('matches an IP literal exactly, not as a suffix', () => {
      const env = {https_proxy: HTTPS_PROXY, no_proxy: '1.2.3.4'};

      expect(selectProxy(new URL('https://1.2.3.4/'), env)).toBeUndefined();
      expect(selectProxy(new URL('https://11.2.3.4/'), env)).toBe(HTTPS_PROXY);
    });

    it('matches a bracketed IPv6 literal by its bare address', () => {
      const env = {https_proxy: HTTPS_PROXY, no_proxy: '2606:4700:4700::1111'};

      expect(
        selectProxy(new URL('https://[2606:4700:4700::1111]/'), env),
      ).toBeUndefined();
    });
  });
});
