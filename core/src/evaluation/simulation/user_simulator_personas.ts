/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** One behavior a simulated user follows. */
export interface UserBehavior {
  /** The name of the behavior. */
  name: string;

  /**
   * What the behavior looks like. The user simulator and the simulator's
   * evaluator both read this.
   */
  description: string;

  /** Instructions given to the user simulator. */
  behaviorInstructions: string[];

  /**
   * Rubrics that decide whether the simulator kept to the behavior. A response
   * that violates any of them is not a valid user turn.
   */
  violationRubrics: string[];
}

/** The persona a simulated user adopts. */
export interface UserPersona {
  /** Human readable identifier. A persona registry refers to this id. */
  id: string;

  /** What the persona is. Included in the user simulator's instructions. */
  description: string;

  /** The behaviors that make up the persona. */
  behaviors: UserBehavior[];
}
