/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A behavior a simulated user persona exhibits. */
export interface UserBehavior {
  name: string;

  /** What the behavior looks like, used in the simulator's instructions. */
  description: string;

  /** Instructions the simulated user follows. */
  behaviorInstructions: string[];

  /** Rubrics that decide whether the simulator violated the behavior. */
  violationRubrics: string[];
}

/** A persona the user simulator adopts. */
export interface UserPersona {
  /** Human readable identifier; persona registries key on this. */
  id: string;

  description: string;

  behaviors: UserBehavior[];
}
