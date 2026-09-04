/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureStage,
  getFeatureConfig,
  isFeatureEnabled,
  overrideFeatureEnabled,
  registerFeature,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {unlistedFeatureName} from './feature_name_test_utils.js';

/**
 * The registry and the override map are object literals, so they inherit the
 * members of `Object.prototype`. A feature name that collides with one of
 * those members must still read as unregistered.
 */
const INHERITED_NAMES = [
  'toString',
  'constructor',
  'valueOf',
  'hasOwnProperty',
].map(unlistedFeatureName);

describe('feature registry inherited names', () => {
  it.each(INHERITED_NAMES)('getFeatureConfig(%s) is undefined', (name) => {
    expect(getFeatureConfig(name)).toBeUndefined();
  });

  it.each(INHERITED_NAMES)('isFeatureEnabled(%s) throws', (name) => {
    expect(() => isFeatureEnabled(name)).toThrowError(/is not registered/);
  });

  it.each(INHERITED_NAMES)('overrideFeatureEnabled(%s) throws', (name) => {
    expect(() => overrideFeatureEnabled(name, true)).toThrowError(
      /is not registered/,
    );
  });

  it.each(INHERITED_NAMES)(
    'withTemporaryFeatureOverride(%s) rejects',
    async (name) => {
      await expect(
        withTemporaryFeatureOverride(name, true, () => 'ran'),
      ).rejects.toThrowError(/is not registered/);
    },
  );

  it('resolves a registered feature that shadows an inherited member', async () => {
    const name = unlistedFeatureName('propertyIsEnumerable');
    registerFeature(name, {stage: FeatureStage.EXPERIMENTAL, defaultOn: false});

    expect(isFeatureEnabled(name)).toBe(false);

    const enabledInside = await withTemporaryFeatureOverride(name, true, () =>
      isFeatureEnabled(name),
    );

    expect(enabledInside).toBe(true);
    expect(isFeatureEnabled(name)).toBe(false);
  });
});
