/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterAll, afterEach, describe, expect, it, vi} from 'vitest';
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
    // The ambient developer/CI environment may set either variable, so every
    // case starts from a base with both explicitly removed.
    const baseEnv = {...originalEnv};
    delete baseEnv['GOOGLE_GENAI_USE_ENTERPRISE'];
    delete baseEnv['GOOGLE_GENAI_USE_VERTEXAI'];

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    afterEach(() => {
      process.env = originalEnv;
      warnSpy.mockClear();
    });

    afterAll(() => {
      warnSpy.mockRestore();
    });

    it('should return true when GOOGLE_GENAI_USE_ENTERPRISE is "true"', () => {
      process.env = {...baseEnv, 'GOOGLE_GENAI_USE_ENTERPRISE': 'true'};
      expect(isEnterpriseModeEnabled()).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should return true when GOOGLE_GENAI_USE_ENTERPRISE is "1"', () => {
      process.env = {...baseEnv, 'GOOGLE_GENAI_USE_ENTERPRISE': '1'};
      expect(isEnterpriseModeEnabled()).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should return false when GOOGLE_GENAI_USE_ENTERPRISE is "false"', () => {
      process.env = {...baseEnv, 'GOOGLE_GENAI_USE_ENTERPRISE': 'false'};
      expect(isEnterpriseModeEnabled()).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should let GOOGLE_GENAI_USE_ENTERPRISE="false" override GOOGLE_GENAI_USE_VERTEXAI="true"', () => {
      process.env = {
        ...baseEnv,
        'GOOGLE_GENAI_USE_ENTERPRISE': 'false',
        'GOOGLE_GENAI_USE_VERTEXAI': 'true',
      };
      expect(isEnterpriseModeEnabled()).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should let GOOGLE_GENAI_USE_ENTERPRISE="true" override GOOGLE_GENAI_USE_VERTEXAI="false"', () => {
      process.env = {
        ...baseEnv,
        'GOOGLE_GENAI_USE_ENTERPRISE': 'true',
        'GOOGLE_GENAI_USE_VERTEXAI': 'false',
      };
      expect(isEnterpriseModeEnabled()).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should fall back to GOOGLE_GENAI_USE_VERTEXAI="true" and warn', () => {
      process.env = {...baseEnv, 'GOOGLE_GENAI_USE_VERTEXAI': 'true'};
      expect(isEnterpriseModeEnabled()).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/GOOGLE_GENAI_USE_VERTEXAI is deprecated/),
      );
    });

    it('should warn on GOOGLE_GENAI_USE_VERTEXAI="false" since presence triggers the notice', () => {
      process.env = {...baseEnv, 'GOOGLE_GENAI_USE_VERTEXAI': 'false'};
      expect(isEnterpriseModeEnabled()).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('should return false when neither variable is set', () => {
      process.env = {...baseEnv};
      expect(isEnterpriseModeEnabled()).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should not consult GOOGLE_GENAI_USE_VERTEXAI when GOOGLE_GENAI_USE_ENTERPRISE is empty', () => {
      process.env = {
        ...baseEnv,
        'GOOGLE_GENAI_USE_ENTERPRISE': '',
        'GOOGLE_GENAI_USE_VERTEXAI': 'true',
      };
      expect(isEnterpriseModeEnabled()).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
