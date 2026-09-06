/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A conversation between a simulated user and the agent under test.
 *
 * The persona field of `google/adk-python`'s model is left out until the
 * user-simulator personas are ported. Adding an optional field later does not
 * break a caller.
 */
export interface ConversationScenario {
  /**
   * The fixed first user message given to the agent. The user simulation
   * system produces every later user message.
   */
  startingPrompt: string;

  /** The plan the user-simulation system follows for the rest of the turns. */
  conversationPlan: string;
}
