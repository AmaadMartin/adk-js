/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thrown when an eval run finishes with at least one metric below its
 * threshold. The message carries the full failure report.
 */
export class EvalFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalFailureError';
  }
}
