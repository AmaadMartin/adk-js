/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A partial port of adk-python's `evaluation/conversation_scenarios.py`, with
 * the one type an eval case needs. The `userPersona` field, the
 * `ConversationScenarios` container and `ConversationGenerationConfig` depend
 * on the user-simulator persona registry, which adk-js does not have yet.
 */

/**
 * Scenario for a conversation between a simulated user and the agent under
 * test.
 */
export interface ConversationScenario {
  /**
   * The fixed first user message given to the agent. A user simulator produces
   * every later user message.
   */
  startingPrompt: string;

  /**
   * The plan the user simulator follows as it plays the conversation out.
   *
   * For a travel agent that can book a flight and a car, a starting prompt of
   * `I need to book a flight.` pairs with a plan such as: book a one-way
   * morning flight from SFO to LAX next Tuesday under $150, confirm it, then
   * rent a standard-size car for three days from the airport.
   */
  conversationPlan: string;
}
