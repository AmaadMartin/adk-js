/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A score an auto-rater produced for one sample of one invocation. */
export interface AutoRaterScore {
  /** The overall score. Absent when it could not be determined. */
  score?: number;
}
