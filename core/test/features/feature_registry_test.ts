/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  FeatureStage,
  getFeatureConfig,
  isFeatureEnabled,
  overrideFeatureEnabled,
  registerFeature,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('FeatureRegistry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {...originalEnv};
    // Reset overrides
    // We can't easily reset the internal modules without exposing a reset function,
    // but we can override back to undefined or known state using overrideFeatureEnabled
    // Actually withTemporaryFeatureOverride does clean up.
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should get correct config for PROGRESSIVE_SSE_STREAMING', () => {
    const config = getFeatureConfig(FeatureName.PROGRESSIVE_SSE_STREAMING);
    expect(config).toBeDefined();
    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(true);
  });

  it('should return defaultOn value when no overrides or env vars', () => {
    delete process.env.ADK_ENABLE_PROGRESSIVE_SSE_STREAMING;
    delete process.env.ADK_DISABLE_PROGRESSIVE_SSE_STREAMING;

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(true);
  });

  it('should respect ADK_DISABLE_ env var', () => {
    process.env.ADK_DISABLE_PROGRESSIVE_SSE_STREAMING = 'true';

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(false);
  });

  it('should respect ADK_ENABLE_ env var', () => {
    // Register a dummy feature that is default off
    const dummyName = 'DUMMY_FEATURE' as FeatureName;
    registerFeature(dummyName, {
      stage: FeatureStage.EXPERIMENTAL,
      defaultOn: false,
    });

    process.env.ADK_ENABLE_DUMMY_FEATURE = 'true';

    expect(isFeatureEnabled(dummyName)).toBe(true);
  });

  it('should respect programmatic overrides over env vars', () => {
    process.env.ADK_DISABLE_PROGRESSIVE_SSE_STREAMING = 'true';
    overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, true);

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(true);

    overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, undefined);
  });

  it('should throw error when checking unregistered feature', () => {
    expect(() => isFeatureEnabled('NON_EXISTENT' as FeatureName)).toThrowError(
      /is not registered/,
    );
  });

  it('should support temporary overrides', async () => {
    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(true);

    await withTemporaryFeatureOverride(
      FeatureName.PROGRESSIVE_SSE_STREAMING,
      true,
      () => {
        expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(
          true,
        );
      },
    );

    // restored
    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(true);
  });

  it('should support temporary overrides with promises', async () => {
    await withTemporaryFeatureOverride(
      FeatureName.PROGRESSIVE_SSE_STREAMING,
      true,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(
          true,
        );
      },
    );
  });

  // PROGRESSIVE_SSE_STREAMING now defaults to true, so an override to true no
  // longer distinguishes the overridden state from the restored one.
  it('should restore the default after a temporary override to false', async () => {
    await withTemporaryFeatureOverride(
      FeatureName.PROGRESSIVE_SSE_STREAMING,
      false,
      () => {
        expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(
          false,
        );
      },
    );

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(true);
  });

  it('should restore an existing override after a temporary override', async () => {
    overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, false);

    await withTemporaryFeatureOverride(
      FeatureName.PROGRESSIVE_SSE_STREAMING,
      true,
      () => {
        expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(
          true,
        );
      },
    );

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(false);

    overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, undefined);
  });

  it('should restore the override state when the callback throws', async () => {
    await expect(
      withTemporaryFeatureOverride(
        FeatureName.PROGRESSIVE_SSE_STREAMING,
        false,
        () => {
          throw new Error('callback failed');
        },
      ),
    ).rejects.toThrowError('callback failed');

    expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(true);
  });

  it('should throw when temporarily overriding an unregistered feature', async () => {
    await expect(
      withTemporaryFeatureOverride('NO_SUCH_FEATURE' as FeatureName, true, () =>
        expect.fail('the callback must not run'),
      ),
    ).rejects.toThrowError(/is not registered/);
  });
});
