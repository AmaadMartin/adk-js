/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {UserPersona} from './simulation/user_simulator_personas.js';

/** A conversation between a simulated user and the agent under test. */
export interface ConversationScenario {
  /**
   * The fixed first user message given to the agent. The user simulation
   * system produces every later user message.
   */
  startingPrompt: string;

  /** The plan the user-simulation system follows for the rest of the turns. */
  conversationPlan: string;

  /** The persona the user simulator adopts. */
  userPersona?: UserPersona;
}
