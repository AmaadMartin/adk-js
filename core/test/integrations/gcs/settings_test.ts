/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  FeatureStage,
  GcsCapabilities,
  GcsToolSettings,
  createGcsToolSettings,
  getFeatureConfig,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_GCS_CAPABILITIES} from '../../../src/integrations/gcs/settings.js';
import {logger} from '../../../src/utils/logger.js';

const ENABLE_ENV_VAR = 'ADK_ENABLE_GCS_TOOL_SETTINGS';
const DISABLE_ENV_VAR = 'ADK_DISABLE_GCS_TOOL_SETTINGS';
const NOT_ENABLED_MESSAGE = 'Feature GCS_TOOL_SETTINGS is not enabled.';

function spyOnLoggerWarn() {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

describe('GCS tool settings', () => {
  const originalEnv = process.env;
  let warnSpy: ReturnType<typeof spyOnLoggerWarn>;

  beforeEach(() => {
    process.env = {...originalEnv};
    delete process.env[ENABLE_ENV_VAR];
    delete process.env[DISABLE_ENV_VAR];
    warnSpy = spyOnLoggerWarn();
  });

  afterEach(() => {
    process.env = originalEnv;
    overrideFeatureEnabled(FeatureName.GCS_TOOL_SETTINGS, undefined);
    vi.restoreAllMocks();
  });

  // This case must stay first: the registry warns once per process and adk-js
  // exports no reset for its warned-feature set.
  it('warns once that GCS_TOOL_SETTINGS is enabled', () => {
    createGcsToolSettings();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('GCS_TOOL_SETTINGS is enabled.'),
    );

    createGcsToolSettings();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('registers GCS_TOOL_SETTINGS as experimental and on by default', () => {
    const config = getFeatureConfig(FeatureName.GCS_TOOL_SETTINGS);

    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(true);
  });

  describe('the feature gate', () => {
    it('throws when the feature is disabled programmatically', () => {
      overrideFeatureEnabled(FeatureName.GCS_TOOL_SETTINGS, false);

      expect(() => createGcsToolSettings()).toThrow(NOT_ENABLED_MESSAGE);
    });

    it('throws when ADK_DISABLE_GCS_TOOL_SETTINGS disables the feature', () => {
      process.env[DISABLE_ENV_VAR] = 'true';

      expect(() => createGcsToolSettings()).toThrow(NOT_ENABLED_MESSAGE);
    });

    it('stays enabled under ADK_ENABLE_GCS_TOOL_SETTINGS', () => {
      process.env[ENABLE_ENV_VAR] = 'true';

      expect(createGcsToolSettings()).toEqual({
        capabilities: [GcsCapabilities.READ_ONLY],
      });
    });
  });

  describe('createGcsToolSettings', () => {
    const cases: Array<{
      name: string;
      params: Partial<GcsToolSettings>;
      expected: GcsCapabilities[];
    }> = [
      {
        name: 'an empty object',
        params: {},
        expected: [GcsCapabilities.READ_ONLY],
      },
      {
        name: 'an explicit undefined capability list',
        params: {capabilities: undefined},
        expected: [GcsCapabilities.READ_ONLY],
      },
      {
        name: 'an empty capability list',
        params: {capabilities: []},
        expected: [],
      },
      {
        name: 'read-write alone',
        params: {capabilities: [GcsCapabilities.READ_WRITE]},
        expected: [GcsCapabilities.READ_WRITE],
      },
      {
        name: 'both capabilities in order',
        params: {
          capabilities: [GcsCapabilities.READ_ONLY, GcsCapabilities.READ_WRITE],
        },
        expected: [GcsCapabilities.READ_ONLY, GcsCapabilities.READ_WRITE],
      },
    ];

    it.each(cases)('resolves $name', ({params, expected}) => {
      expect(createGcsToolSettings(params)).toEqual({capabilities: expected});
    });

    it('defaults to read only when called with no arguments', () => {
      expect(createGcsToolSettings()).toEqual({
        capabilities: [GcsCapabilities.READ_ONLY],
      });
    });

    it('returns a fresh object per call', () => {
      const first = createGcsToolSettings();
      first.capabilities.push(GcsCapabilities.READ_WRITE);

      expect(createGcsToolSettings().capabilities).toEqual([
        GcsCapabilities.READ_ONLY,
      ]);
      expect(first.capabilities).not.toBe(DEFAULT_GCS_CAPABILITIES);
    });
  });

  describe('GcsCapabilities', () => {
    it('keeps the adk-python string values', () => {
      expect(GcsCapabilities.READ_ONLY).toBe('read_only');
      expect(GcsCapabilities.READ_WRITE).toBe('read_write');
      expect(Object.values(GcsCapabilities)).toEqual([
        'read_only',
        'read_write',
      ]);
    });
  });

  describe('DEFAULT_GCS_CAPABILITIES', () => {
    it('permits read alone, as adk-python does', () => {
      expect(DEFAULT_GCS_CAPABILITIES).toEqual([GcsCapabilities.READ_ONLY]);
    });
  });
});

// Ported from adk-python `tests/unittests/integrations/gcs/test_gcs_toolset.py`,
// the reference tests for `src/google/adk/integrations/gcs/settings.py`.
// adk-js has no GCSToolset or GCSAdminToolset yet, so only the settings half of
// each case is portable; the tool-list half is named in a comment instead.
describe('ported from adk-python test_gcs_toolset.py', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {...originalEnv};
    delete process.env[ENABLE_ENV_VAR];
    delete process.env[DISABLE_ENV_VAR];
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    overrideFeatureEnabled(FeatureName.GCS_TOOL_SETTINGS, undefined);
    vi.restoreAllMocks();
  });

  // The unported half asserts GCSToolset exposes exactly `get_object_data`,
  // `get_object_metadata` and `list_objects` under this default.
  it('test_gcs_toolset_tools_default', () => {
    const settings = createGcsToolSettings();

    expect(settings.capabilities).toEqual([GcsCapabilities.READ_ONLY]);
  });

  // The unported half asserts GCSToolset adds `create_object` and
  // `delete_objects` to the three read tools under this capability.
  it('test_gcs_toolset_tools_read_write', () => {
    const settings = createGcsToolSettings({
      capabilities: [GcsCapabilities.READ_WRITE],
    });

    expect(settings.capabilities).toEqual([GcsCapabilities.READ_WRITE]);
  });
});
