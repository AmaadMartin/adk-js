/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {UserPersona} from './simulation/user_simulator_personas.js';

/**
 * A scenario for a conversation between a simulated user and the agent under
 * test. An eval case carries one of these instead of a recorded conversation
 * when the user's turns are produced at eval time.
 */
export interface ConversationScenario {
  /**
   * The fixed first user message given to the agent. The user simulation
   * system produces every later user message.
   */
  startingPrompt: string;

  /**
   * The plan the user simulator follows as it plays out the conversation.
   *
   * For a travel agent that can book a flight and a car, a starting prompt of
   * `I need to book a flight.` pairs with a plan such as: "First, book a
   * one-way flight from SFO to LAX for next Tuesday. You prefer a morning
   * flight and your budget is under $150. If the agent finds a valid flight,
   * confirm the booking. Then rent a standard-size car for three days from the
   * airport."
   */
  conversationPlan: string;

  /**
   * The persona the user simulator adopts. adk-python also accepts a persona
   * id here and resolves it through its default persona registry; that
   * registry is not ported yet, so give the persona itself.
   */
  userPersona?: UserPersona;
}
