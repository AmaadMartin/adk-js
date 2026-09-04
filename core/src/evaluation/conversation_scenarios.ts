/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {evalModel, optionalField, type EvalModel} from './common.js';
import {getDefaultPersonaRegistry} from './simulation/pre_built_personas.js';
import {
  userPersonaModel,
  type UserPersona,
} from './simulation/user_simulator_personas.js';

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
   * The persona the user simulator adopts. A scenario document may name a
   * built-in persona by its id instead; {@link parseConversationScenario}
   * resolves that id through the default persona registry.
   */
  userPersona?: UserPersona;
}

/** A list of scenarios, so a whole set serializes as one document. */
export interface ConversationScenarios {
  scenarios: ConversationScenario[];
}

/** Configuration for generating conversation scenarios. */
export interface ConversationGenerationConfig {
  /** How many scenarios to generate. */
  count: number;

  /** A natural language goal that steers what the scenarios cover. */
  generationInstruction?: string;

  /**
   * The backend data or state the agent's tools can reach. This is the ground
   * truth for the simulation, so a generated request names data that exists.
   */
  environmentContext?: string;

  /** The Gemini model that generates the scenarios. */
  modelName: string;
}

/**
 * Accepts a persona id or a whole persona, and yields a whole persona.
 *
 * The registry's `NotFoundError` propagates out of the parse unwrapped, so an
 * unknown id surfaces as `NotFoundError` rather than as a validation failure.
 * adk-python's `validate_user_persona` behaves the same way.
 */
const userPersonaField = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? getDefaultPersonaRegistry().getPersona(value)
      : value,
  userPersonaModel.schema,
);

/** Validates a {@link ConversationScenario} payload. */
export const conversationScenarioModel: EvalModel<ConversationScenario> =
  evalModel(
    {
      startingPrompt: z.string(),
      conversationPlan: z.string(),
      userPersona: optionalField(userPersonaField),
    },
    {name: 'ConversationScenario'},
  );

/** Validates a {@link ConversationScenarios} payload. */
export const conversationScenariosModel: EvalModel<ConversationScenarios> =
  evalModel(
    {scenarios: z.array(conversationScenarioModel.schema).default([])},
    {name: 'ConversationScenarios'},
  );

/** Validates a {@link ConversationGenerationConfig} payload. */
export const conversationGenerationConfigModel: EvalModel<ConversationGenerationConfig> =
  evalModel(
    {
      count: z.number().int(),
      generationInstruction: optionalField(z.string()),
      environmentContext: optionalField(z.string()),
      modelName: z.string(),
    },
    {name: 'ConversationGenerationConfig'},
  );

/**
 * Validates a conversation scenario payload, resolving a persona id.
 *
 * @throws {InputValidationError} When the payload is not a valid scenario.
 * @throws {NotFoundError} When `userPersona` names an unknown persona.
 */
export function parseConversationScenario(raw: unknown): ConversationScenario {
  return conversationScenarioModel.parse(raw);
}

/**
 * Validates a conversation scenarios document.
 *
 * @throws {InputValidationError} When the payload is not a valid document.
 * @throws {NotFoundError} When a scenario names an unknown persona.
 */
export function parseConversationScenarios(
  raw: unknown,
): ConversationScenarios {
  return conversationScenariosModel.parse(raw);
}

/**
 * Validates a conversation generation config payload.
 *
 * @throws {InputValidationError} When the payload is not a valid config.
 */
export function parseConversationGenerationConfig(
  raw: unknown,
): ConversationGenerationConfig {
  return conversationGenerationConfigModel.parse(raw);
}
