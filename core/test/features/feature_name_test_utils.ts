/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FeatureName} from '@google/adk';

/**
 * Builds a feature name the `FeatureName` enum does not declare.
 *
 * The registry is keyed by string at runtime, so `registerFeature` accepts a
 * name that is not a member and `isFeatureEnabled` must reject one. Neither
 * case is expressible with a member, so a test needs a value from outside the
 * enum. This is the one place that produces one.
 *
 * A test must not reuse a real member for this. The warned-feature set and the
 * registry are module-level state that no test can reset, so writing to a real
 * member leaks into every later test in the process.
 */
export function unlistedFeatureName(name: string): FeatureName {
  return name as FeatureName;
}
