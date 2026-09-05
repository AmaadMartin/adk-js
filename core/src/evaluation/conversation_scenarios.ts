/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {UserPersona} from './simulation/user_simulator_personas.js';

/** A scenario for a conversation between a simulated user and the agent. */
export interface ConversationScenario {
  /**
   * The fixed first user message. Every later user message comes from the
   * user simulator.
   */
  startingPrompt: string;

  /** The plan the user simulator follows as it plays the conversation out. */
  conversationPlan: string;

  /** The persona the user simulator adopts. */
  userPersona?: UserPersona;
}
