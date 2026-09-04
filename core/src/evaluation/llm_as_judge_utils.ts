/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The labels a judge model writes into its critique.
 *
 * The values are compared against model output, so they match adk-python
 * exactly.
 */
export enum Label {
  TRUE = 'true',
  INVALID = 'invalid',
  VALID = 'valid',
  ALMOST = 'almost',
  FALSE = 'false',
  NOT_FOUND = 'label field not found',
}

/**
 * The spellings a judge model uses for a partly valid response, which counts
 * as invalid.
 *
 * adk-python holds these on a multi-valued `Label.PARTIALLY_VALID` member. A
 * TypeScript enum member holds one string, so they live beside the enum.
 */
export const PARTIALLY_VALID_LABELS: readonly string[] = [
  'partially_valid',
  'partially valid',
  'partially',
];
