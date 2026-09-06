/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigtableToolSettings,
  FeatureName,
  FeatureStage,
  createBigtableToolSettings,
  getFeatureConfig,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

const ENABLE_ENV_VAR = 'ADK_ENABLE_BIGTABLE_TOOL_SETTINGS';
const DISABLE_ENV_VAR = 'ADK_DISABLE_BIGTABLE_TOOL_SETTINGS';
const NOT_ENABLED_MESSAGE = 'Feature BIGTABLE_TOOL_SETTINGS is not enabled.';

function spyOnLoggerWarn() {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

describe('Bigtable tool settings', () => {
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
    overrideFeatureEnabled(FeatureName.BIGTABLE_TOOL_SETTINGS, undefined);
    vi.restoreAllMocks();
  });

  // This case must stay first: the registry warns once per process and adk-js
  // exports no reset for its warned-feature set.
  it('warns once that BIGTABLE_TOOL_SETTINGS is enabled', () => {
    createBigtableToolSettings();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BIGTABLE_TOOL_SETTINGS is enabled.'),
    );

    createBigtableToolSettings();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('registers BIGTABLE_TOOL_SETTINGS as experimental and on by default', () => {
    const config = getFeatureConfig(FeatureName.BIGTABLE_TOOL_SETTINGS);

    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(true);
  });

  describe('createBigtableToolSettings', () => {
    const cases: Array<{
      name: string;
      params: Partial<BigtableToolSettings>;
      expectedRows: number;
    }> = [
      {name: 'an empty object', params: {}, expectedRows: 50},
      {
        name: 'an explicit undefined row cap',
        params: {maxQueryResultRows: undefined},
        expectedRows: 50,
      },
      {name: 'one row', params: {maxQueryResultRows: 1}, expectedRows: 1},
      {name: 'ten rows', params: {maxQueryResultRows: 10}, expectedRows: 10},
      {
        name: 'a hundred rows',
        params: {maxQueryResultRows: 100},
        expectedRows: 100,
      },
    ];

    it.each(cases)('resolves $name', ({params, expectedRows}) => {
      expect(createBigtableToolSettings(params)).toEqual({
        maxQueryResultRows: expectedRows,
      });
    });

    it('defaults the row cap when called with no arguments', () => {
      expect(createBigtableToolSettings()).toEqual({maxQueryResultRows: 50});
    });

    // The Bigtable query tool substitutes its own limit for a non-positive
    // cap, so the settings keep the caller's zero.
    it('preserves a zero row cap', () => {
      expect(createBigtableToolSettings({maxQueryResultRows: 0})).toEqual({
        maxQueryResultRows: 0,
      });
    });

    it('returns a fresh object per call', () => {
      const first = createBigtableToolSettings();
      first.maxQueryResultRows = 7;

      expect(createBigtableToolSettings().maxQueryResultRows).toBe(50);
    });

    it('throws when the feature is disabled programmatically', () => {
      overrideFeatureEnabled(FeatureName.BIGTABLE_TOOL_SETTINGS, false);

      expect(() => createBigtableToolSettings()).toThrow(NOT_ENABLED_MESSAGE);
    });

    it('throws when ADK_DISABLE_BIGTABLE_TOOL_SETTINGS disables the feature', () => {
      process.env[DISABLE_ENV_VAR] = 'true';

      expect(() => createBigtableToolSettings()).toThrow(NOT_ENABLED_MESSAGE);
    });

    it('stays enabled under ADK_ENABLE_BIGTABLE_TOOL_SETTINGS', () => {
      process.env[ENABLE_ENV_VAR] = 'true';

      expect(createBigtableToolSettings()).toEqual({maxQueryResultRows: 50});
    });
  });
});
