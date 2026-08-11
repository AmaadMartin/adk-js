/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {randomUUID as shimRandomUUID} from '../../src/utils/crypto_shim.js';
import {
  base64Decode,
  getBooleanEnvVar,
  randomUUID,
} from '../../src/utils/env_aware_utils.js';

describe('env_aware_utils', () => {
  describe('getBooleanEnvVar', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return true for "true" (case-insensitive)', () => {
      process.env = {...originalEnv, 'TEST_VAR': 'true'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(true);

      process.env = {...originalEnv, 'TEST_VAR': 'TRUE'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(true);

      process.env = {...originalEnv, 'TEST_VAR': 'True'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(true);
    });

    it('should return true for "1"', () => {
      process.env = {...originalEnv, 'TEST_VAR': '1'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(true);
    });

    it('should return false for "false"', () => {
      process.env = {...originalEnv, 'TEST_VAR': 'false'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(false);
    });

    it('should return false for "0"', () => {
      process.env = {...originalEnv, 'TEST_VAR': '0'};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(false);
    });

    it('should return false for empty string', () => {
      process.env = {...originalEnv, 'TEST_VAR': ''};
      expect(getBooleanEnvVar('TEST_VAR')).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(getBooleanEnvVar('NON_EXISTENT_VAR')).toBe(false);
    });
  });

  describe('randomUUID', () => {
    const originalCrypto = globalThis.crypto;

    afterEach(() => {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
        writable: true,
      });
    });

    const setCrypto = (value: unknown) => {
      Object.defineProperty(globalThis, 'crypto', {
        value,
        configurable: true,
        writable: true,
      });
    };

    const UUID_V4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('uses crypto.randomUUID when it is available', () => {
      setCrypto({
        randomUUID: () => '00000000-0000-4000-8000-000000000000',
        getRandomValues: () => {
          throw new Error('getRandomValues must not be called');
        },
      });

      expect(randomUUID()).toBe('00000000-0000-4000-8000-000000000000');
    });

    it('returns a valid v4 UUID on this runtime', () => {
      expect(randomUUID()).toMatch(UUID_V4);
    });

    // crypto.randomUUID is a secure-context-only API, so it is absent on
    // plain-HTTP origins while crypto.getRandomValues remains available.
    it('falls back to crypto.getRandomValues when randomUUID is absent', () => {
      const getRandomValues =
        originalCrypto.getRandomValues.bind(originalCrypto);
      setCrypto({getRandomValues});

      expect(randomUUID()).toMatch(UUID_V4);
    });

    it('draws every byte from getRandomValues, not Math.random', () => {
      const getRandomValues = (array: Uint8Array) => {
        array.fill(0xab);
        return array;
      };
      setCrypto({getRandomValues});

      // 0xab in every byte, with the RFC 4122 version and variant bits applied.
      expect(randomUUID()).toBe('abababab-abab-4bab-abab-abababababab');
    });

    // globalThis.crypto was added in Node v17.4.0 and stayed behind
    // --experimental-global-webcrypto until v19.0.0, so on a default Node 18 or
    // earlier neither globalThis branch matches.
    it('falls back to node:crypto when globalThis.crypto is absent', () => {
      setCrypto(undefined);

      expect(randomUUID()).toMatch(UUID_V4);
    });

    it('does not repeat itself across calls without globalThis.crypto', () => {
      setCrypto(undefined);

      const ids = new Set(Array.from({length: 1000}, () => randomUUID()));

      expect(ids.size).toBe(1000);
    });

    // The web build aliases node:crypto to this shim, so it stands in for the
    // Node fallback in a browser that has no Web Crypto API at all.
    it('throws instead of degrading in the browser shim', () => {
      expect(() => shimRandomUUID()).toThrow(
        /no cryptographically secure source of randomness/,
      );
    });
  });

  describe('base64Decode', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // isBrowser() only checks for a `window` global, and `atob` is the sole
    // member the browser branch touches.
    const stubBrowser = () => {
      vi.stubGlobal('window', {atob: globalThis.atob.bind(globalThis)});
    };

    it('decodes UTF-8 text in Node', () => {
      const decoded = base64Decode('Y2Fmw6kg4pyT');

      expect(decoded).toBe('café ✓');
      expect(decoded.length).toBe(6);
    });

    // window.atob yields one code unit per byte, so this input decoded to
    // 'cafÃ© â' (9 code units) before the browser branch decoded UTF-8.
    it('decodes UTF-8 text in the browser', () => {
      stubBrowser();

      const decoded = base64Decode('Y2Fmw6kg4pyT');

      expect(decoded).toBe('café ✓');
      expect(decoded.length).toBe(6);
    });

    it('returns the same text in both environments', () => {
      const nodeResult = base64Decode('5pel5pys6KqeIOKCrDEwMA==');
      stubBrowser();
      const browserResult = base64Decode('5pel5pys6KqeIOKCrDEwMA==');

      expect(browserResult).toBe(nodeResult);
      expect(browserResult).toBe('日本語 €100');
    });

    it('leaves ASCII text unchanged in the browser', () => {
      stubBrowser();

      expect(base64Decode('aGVsbG8gd29ybGQ=')).toBe('hello world');
    });

    it('decodes the empty string in both environments', () => {
      expect(base64Decode('')).toBe('');

      stubBrowser();

      expect(base64Decode('')).toBe('');
    });

    // Buffer.toString() substitutes U+FFFD instead of throwing, so the browser
    // branch must decode in TextDecoder's default non-fatal mode to match.
    it('substitutes U+FFFD for invalid UTF-8 in both environments', () => {
      expect(base64Decode('//4=')).toBe('\uFFFD\uFFFD');

      stubBrowser();

      expect(base64Decode('//4=')).toBe('\uFFFD\uFFFD');
    });
  });
});
