/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Message shown when optional evaluation dependencies are not installed.
 */
export const MISSING_EVAL_DEPENDENCIES_MESSAGE =
  'Eval module is not installed, please install via `pip install' +
  ' "google-adk[eval]"`.';

/**
 * Default timeout, in seconds, applied to live (bidi) eval invocations.
 */
export const DEFAULT_LIVE_TIMEOUT_SECONDS = 300;
