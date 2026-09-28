/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalCase} from './eval_case.js';

/** A set of eval cases, the unit an agent is evaluated against. */
export interface EvalSet {
  /** Unique identifier for the eval set. */
  evalSetId: string;

  name?: string;

  description?: string;

  evalCases: EvalCase[];

  /** Creation time in seconds since the epoch. */
  creationTimestamp: number;
}
