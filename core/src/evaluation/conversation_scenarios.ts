/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getDefaultPersonaRegistry} from './simulation/pre_built_personas.js';
import {UserPersona} from './simulation/user_simulator_personas.js';

/**
 * Resolves a `userPersona` field value.
 *
 * When a persona id (`string`) is supplied, it is resolved to a `UserPersona`
 * via the default persona registry (throwing `NotFoundError` for unknown ids).
 * A `UserPersona` object, or `undefined`, passes through unchanged. This
 * completes the persona-resolution behavior that the data-models sub-port left
 * as a pass-through.
 */
function validateUserPersona(
  value?: UserPersona | string,
): UserPersona | undefined {
  if (typeof value === 'string') {
    return getDefaultPersonaRegistry().getPersona(value);
  }
  return value;
}

/**
 * Initializer for a {@link ConversationScenario}. `userPersona` may be a
 * `UserPersona` object or a persona id `string` (resolved via the default
 * registry).
 */
export interface ConversationScenarioInit {
  /** Fixed first user message given to the agent. */
  startingPrompt: string;
  /** Plan the user-simulation system follows as it plays out the conversation. */
  conversationPlan: string;
  /** Persona the user simulator should adopt, or a persona id to resolve. */
  userPersona?: UserPersona | string;
}

/**
 * Scenario for a conversation between a simulated user and the agent under test.
 *
 * Parity with the adk-python `ConversationScenario`.
 */
export class ConversationScenario {
  /**
   * Starting prompt for the conversation. This acts as the fixed first user
   * message given to the agent; subsequent user messages are produced by the
   * user-simulation system.
   */
  readonly startingPrompt: string;

  /**
   * A plan the user-simulation system follows as it plays out the conversation.
   */
  readonly conversationPlan: string;

  /**
   * User persona the user simulator should adopt. When a persona id is supplied
   * to the constructor, it is resolved to a default persona.
   */
  readonly userPersona?: UserPersona;

  /**
   * Creates a `ConversationScenario`, resolving a persona id to a
   * `UserPersona` when necessary.
   *
   * @param init The scenario fields.
   * @throws {import('../errors/not_found_error.js').NotFoundError} If
   *     `userPersona` is a string id that is not in the default registry.
   */
  constructor(init: ConversationScenarioInit) {
    this.startingPrompt = init.startingPrompt;
    this.conversationPlan = init.conversationPlan;
    this.userPersona = validateUserPersona(init.userPersona);
  }
}
