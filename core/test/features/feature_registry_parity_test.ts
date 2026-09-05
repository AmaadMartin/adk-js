/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python tests/unittests/features/test_feature_registry.py at
// commit 2367901ec54824984d9f0ef9aee711a6edbcb990 (google/adk-python main).
//
// Python resets the warned-feature set and the override map between tests with
// an autouse fixture, and reuses feature names across tests. adk-js exports no
// reset, and must not grow one for the tests, so each test here registers its
// own feature name instead. The test titles are the Python method names.

import {
  FeatureName,
  FeatureStage,
  getFeatureConfig,
  isFeatureEnabled,
  overrideFeatureEnabled,
  registerFeature,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const overriddenFeatures: FeatureName[] = [];

/** Overrides a feature and remembers it, so `afterEach` can clear it. */
function overrideForTest(featureName: FeatureName, enabled: boolean): void {
  overriddenFeatures.push(featureName);
  overrideFeatureEnabled(featureName, enabled);
}

describe('feature registry parity', () => {
  const originalEnv = process.env;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = {...originalEnv};
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    while (overriddenFeatures.length > 0) {
      overrideFeatureEnabled(overriddenFeatures.pop()!, undefined);
    }
    vi.restoreAllMocks();
  });

  describe('TestGetFeatureConfig', () => {
    it('test_feature_in_registry', () => {
      const name = 'MY_FEATURE' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: true,
      });

      expect(getFeatureConfig(name)).toEqual({
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: true,
      });
    });

    it('test_feature_not_in_registry', () => {
      expect(
        getFeatureConfig('UNKNOWN_FEATURE' as FeatureName),
      ).toBeUndefined();
    });
  });

  describe('TestIsFeatureEnabled', () => {
    it('test_not_in_registry_raises_value_error', () => {
      expect(() => isFeatureEnabled('NEW_FEATURE' as FeatureName)).toThrowError(
        /is not registered/,
      );
    });

    it('test_wip_feature_disabled', () => {
      const name = 'WIP_FEATURE_DISABLED' as FeatureName;
      registerFeature(name, {stage: FeatureStage.WIP, defaultOn: false});

      expect(isFeatureEnabled(name)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('test_wip_feature_enabled', () => {
      const name = 'WIP_FEATURE_ENABLED' as FeatureName;
      registerFeature(name, {stage: FeatureStage.WIP, defaultOn: true});

      expect(isFeatureEnabled(name)).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[WIP] feature WIP_FEATURE_ENABLED is enabled.',
      );
    });

    it('test_experimental_disabled_feature', () => {
      const name = 'EXP_DISABLED' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: false,
      });

      expect(isFeatureEnabled(name)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('test_experimental_enabled_feature', () => {
      const name = 'EXP_ENABLED' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: true,
      });

      expect(isFeatureEnabled(name)).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[EXPERIMENTAL] feature EXP_ENABLED is enabled.',
      );
    });

    it('test_stable_feature_enabled', () => {
      const name = 'STABLE_FEATURE' as FeatureName;
      registerFeature(name, {stage: FeatureStage.STABLE, defaultOn: true});

      expect(isFeatureEnabled(name)).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('test_enable_env_var_takes_precedence', () => {
      const name = 'ENV_ENABLE_TEST' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: false,
      });
      process.env.ADK_ENABLE_ENV_ENABLE_TEST = 'true';

      expect(isFeatureEnabled(name)).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[EXPERIMENTAL] feature ENV_ENABLE_TEST is enabled.',
      );
    });

    it('test_disable_env_var_takes_precedence', () => {
      const name = 'ENV_DISABLE_TEST' as FeatureName;
      registerFeature(name, {stage: FeatureStage.STABLE, defaultOn: true});
      process.env.ADK_DISABLE_ENV_DISABLE_TEST = 'true';

      expect(isFeatureEnabled(name)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('test_warn_once_per_feature', () => {
      const name = 'WARN_ONCE_FEATURE' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: false,
      });
      process.env.ADK_ENABLE_WARN_ONCE_FEATURE = 'true';

      expect(isFeatureEnabled(name)).toBe(true);
      expect(isFeatureEnabled(name)).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[EXPERIMENTAL] feature WARN_ONCE_FEATURE is enabled.',
      );
    });
  });

  describe('TestOverrideFeatureEnabled', () => {
    it('test_override_not_in_registry_raises_value_error', () => {
      expect(() =>
        overrideFeatureEnabled('UNKNOWN_FEATURE' as FeatureName, true),
      ).toThrowError(/is not registered/);
    });

    it('test_override_enables_disabled_feature', () => {
      const name = 'OVERRIDE_ENABLE_TEST' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: false,
      });
      expect(isFeatureEnabled(name)).toBe(false);

      overrideForTest(name, true);

      expect(isFeatureEnabled(name)).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[EXPERIMENTAL] feature OVERRIDE_ENABLE_TEST is enabled.',
      );
    });

    it('test_override_disables_enabled_feature', () => {
      const name = 'OVERRIDE_DISABLE_TEST' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: true,
      });

      overrideForTest(name, false);

      expect(isFeatureEnabled(name)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('test_override_takes_precedence_over_env_enable', () => {
      const name = 'PRIORITY_ENV_ENABLE' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: false,
      });
      process.env.ADK_ENABLE_PRIORITY_ENV_ENABLE = 'true';
      expect(isFeatureEnabled(name)).toBe(true);

      overrideForTest(name, false);
      warnSpy.mockClear();

      expect(isFeatureEnabled(name)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('test_override_takes_precedence_over_env_disable', () => {
      const name = 'PRIORITY_ENV_DISABLE' as FeatureName;
      registerFeature(name, {
        stage: FeatureStage.EXPERIMENTAL,
        defaultOn: true,
      });
      process.env.ADK_DISABLE_PRIORITY_ENV_DISABLE = 'true';
      expect(isFeatureEnabled(name)).toBe(false);

      overrideForTest(name, true);

      expect(isFeatureEnabled(name)).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[EXPERIMENTAL] feature PRIORITY_ENV_DISABLE is enabled.',
      );
    });

    it('test_override_stable_feature_no_warning', () => {
      const name = 'STABLE_OVERRIDE' as FeatureName;
      registerFeature(name, {stage: FeatureStage.STABLE, defaultOn: true});

      overrideForTest(name, true);

      expect(isFeatureEnabled(name)).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
