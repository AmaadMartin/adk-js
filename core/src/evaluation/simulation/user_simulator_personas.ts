/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** One behaviour a simulated user is expected to display. */
export interface UserBehavior {
  /** The name of the behaviour. */
  name: string;

  /**
   * A general description of the expected behaviour. The user simulator and
   * the simulator's evaluator both receive it.
   */
  description: string;

  /** Instructions the simulated user follows. */
  behaviorInstructions: string[];

  /**
   * Rubrics that decide whether the simulator displayed the behaviour. A
   * response that violates any of them is invalid.
   */
  violationRubrics: string[];
}

/** A persona the user simulator adopts for a conversation. */
export interface UserPersona {
  /** A human readable identifier. Persona registries key on it. */
  id: string;

  /**
   * A description of the persona. The user simulator and its verifier both
   * receive it.
   */
  description: string;

  /** The behaviours that make up the persona. */
  behaviors: UserBehavior[];
}
