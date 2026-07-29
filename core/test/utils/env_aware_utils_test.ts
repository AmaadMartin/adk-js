/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  getBooleanEnvVar,
  isEnterpriseModeEnabled,
} from '../../src/utils/env_aware_utils.js';
import {logger} from '../../src/utils/logger.js';

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

  describe('isEnterpriseModeEnabled', () => {
    const originalEnv = process.env;
    let warnSpy: MockInstance<typeof logger.warn>;

    beforeEach(() => {
      process.env = {...originalEnv};
      delete process.env['GOOGLE_GENAI_USE_ENTERPRISE'];
      delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('should return false and not warn when neither env var is set', () => {
      expect(isEnterpriseModeEnabled()).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each(['true', '1'])(
      'should return true when GOOGLE_GENAI_USE_ENTERPRISE is "%s"',
      (value) => {
        process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = value;
        expect(isEnterpriseModeEnabled()).toBe(true);
      },
    );

    it('should return false when GOOGLE_GENAI_USE_ENTERPRISE is "false"', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'false';
      expect(isEnterpriseModeEnabled()).toBe(false);
    });

    it.each([
      {enterprise: '0', legacy: 'true', expected: false},
      // An empty value is present-but-falsy: it must still win over the legacy
      // variable, which a truthiness check instead of a presence check would
      // get wrong.
      {enterprise: '', legacy: 'true', expected: false},
      {enterprise: 'true', legacy: 'false', expected: true},
    ])(
      'should let GOOGLE_GENAI_USE_ENTERPRISE="$enterprise" override the legacy var',
      ({enterprise, legacy, expected}) => {
        process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = enterprise;
        process.env['GOOGLE_GENAI_USE_VERTEXAI'] = legacy;
        expect(isEnterpriseModeEnabled()).toBe(expected);
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it('should fall back to GOOGLE_GENAI_USE_VERTEXAI and warn', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      expect(isEnterpriseModeEnabled()).toBe(true);
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
        'GOOGLE_GENAI_USE_VERTEXAI is deprecated, please use GOOGLE_GENAI_USE_ENTERPRISE instead',
      );
    });

    it('should warn on the fallback path even when the legacy value is falsy', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'false';
      expect(isEnterpriseModeEnabled()).toBe(false);
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it('should return false when process.env is unavailable (browser/shim builds)', () => {
      Reflect.deleteProperty(process, 'env');
      expect(isEnterpriseModeEnabled()).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should warn once per call on the fallback path', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      isEnterpriseModeEnabled();
      isEnterpriseModeEnabled();
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });
});
