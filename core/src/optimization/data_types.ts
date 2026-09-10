/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data types of the optimization package.
 *
 * This file currently carries only the type that {@link ./sampler.js | sampler}
 * needs. The optimizer result types are ported separately, and belong here too.
 */

/**
 * Base class for evaluation results of the candidate agent on the batch of
 * examples.
 *
 * Optimizers may sub-type this to carry the extra data they need for
 * optimization.
 */
export interface SamplingResult {
  /**
   * A map from example UID to the agent's overall score on that example
   * (higher is better).
   */
  scores: Record<string, number>;
}
