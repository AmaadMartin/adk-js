/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';

/** The verdict for one metric, or for a whole eval case. */
export enum EvalStatus {
  PASSED = 1,
  FAILED = 2,
  NOT_EVALUATED = 3,
}

/**
 * The criterion a metric is judged against.
 *
 * Metrics that need more than a threshold extend this, so a criterion read
 * from a config file can carry fields this interface does not name.
 */
export interface BaseCriterion {
  threshold: number;
}

/**
 * A runtime handle for a criterion shape.
 *
 * adk-python binds `Evaluator.criterion_type` to a pydantic model class and
 * calls `model_validate` on the criterion read from an eval config. A
 * TypeScript interface is erased at runtime, so the binding carries a name and
 * a validator in place of a class object.
 */
export interface CriterionType<C extends BaseCriterion = BaseCriterion> {
  /** The name used in validation errors, matching the adk-python class. */
  readonly name: string;

  /**
   * Validates a criterion read from an eval config.
   *
   * @throws {InputValidationError} When the value is not a valid `C`.
   */
  parse(raw: unknown): C;
}

/** Whether a value carries the finite numeric threshold every criterion needs. */
export function isBaseCriterion(raw: unknown): raw is BaseCriterion {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'threshold' in raw &&
    typeof raw.threshold === 'number' &&
    Number.isFinite(raw.threshold)
  );
}

/**
 * The criterion type an evaluator accepts unless it narrows it.
 *
 * `parse` returns the value unchanged, so the extra keys that adk-python's
 * `extra="allow"` config preserves survive here too.
 */
export const BASE_CRITERION_TYPE: CriterionType<BaseCriterion> = {
  name: 'BaseCriterion',

  parse(raw: unknown): BaseCriterion {
    if (!isBaseCriterion(raw)) {
      throw new InputValidationError(
        `Expected a criterion of type \`${this.name}\`.`,
      );
    }
    return raw;
  },
};
