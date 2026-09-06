/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as adk from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('feature registry public surface', () => {
  it('publishes the feature registry runtime API', () => {
    const names = Object.keys(adk);

    expect(names).toContain('FeatureName');
    expect(names).toContain('isFeatureEnabled');
    expect(names).toContain('overrideFeatureEnabled');
    expect(names).toContain('withTemporaryFeatureOverride');
  });

  // `FeatureConfig` is an interface, so it has no runtime key to assert on. It
  // can only return through the wildcard, which these three names already
  // catch.
  it('does not publish the registry-authoring helpers', () => {
    const names = Object.keys(adk);

    expect(names).not.toContain('getFeatureConfig');
    expect(names).not.toContain('registerFeature');
    expect(names).not.toContain('FeatureStage');
  });
});
