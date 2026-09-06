/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reported when the eval runtime cannot be loaded.
 *
 * The data model, the config helpers and the eval-set migration utilities in
 * this directory work on their own. Scoring an agent additionally needs the
 * local eval service, which is loaded lazily at the point of use.
 */
export const MISSING_EVAL_DEPENDENCIES_MESSAGE =
  'The eval runtime is not available. Scoring an agent needs the local eval ' +
  'service, which this build of @google/adk does not provide yet.';

/** Seconds to wait for a model turn to complete in live mode. */
export const DEFAULT_LIVE_TIMEOUT_SECONDS = 300;
