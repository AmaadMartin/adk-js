/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {evalModel, optionalField, type EvalModel} from './common.js';
import {getDefaultPersonaRegistry} from './simulation/pre_built_personas.js';
import type {
  UserBehavior,
  UserPersona,
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
   * The persona the user simulator adopts.
   *
   * A document may name a persona instead of spelling one out. The parser
   * resolves that name through {@link getDefaultPersonaRegistry}, so a parsed
   * scenario always holds the persona itself.
   */
  userPersona?: UserPersona;
}

/**
 * A list of conversation scenarios, so a scenarios document is one value to
 * read and write.
 */
export interface ConversationScenarios {
  /** The scenarios in the document. Empty when the document names none. */
  scenarios: ConversationScenario[];
}

/** How a generator should produce a set of conversation scenarios. */
export interface ConversationGenerationConfig {
  /** How many scenarios to generate. */
  count: number;

  /** What the generated scenarios should be about. */
  generationInstruction?: string;

  /**
   * The backend data or state the agent's tools can reach, which the generated
   * scenarios must stay consistent with. Naming the models a `get_models` tool
   * returns, for example, stops the generator from asking about one that does
   * not exist.
   */
  environmentContext?: string;

  /** The Gemini model that generates the scenarios. */
  modelName: string;
}

const userBehaviorModel: EvalModel<UserBehavior> = evalModel(
  {
    name: z.string(),
    description: z.string(),
    behaviorInstructions: z.array(z.string()),
    violationRubrics: z.array(z.string()),
  },
  {name: 'UserBehavior'},
);

const userPersonaModel: EvalModel<UserPersona> = evalModel(
  {
    id: z.string(),
    description: z.string(),
    behaviors: z.array(userBehaviorModel.schema),
  },
  {name: 'UserPersona'},
);

/**
 * Reads a persona id as the persona the default registry holds for it.
 *
 * The decoded side is `z.custom` because the registry only ever returns a
 * persona it was given, so re-validating one would report a schema failure for
 * a value no document supplied.
 *
 * @throws {NotFoundError} If the id names no persona in the default registry.
 */
const personaIdCodec = z.codec(z.string(), z.custom<UserPersona>(), {
  decode: (personaId) => getDefaultPersonaRegistry().getPersona(personaId),
  encode: (persona) => persona.id,
});

/**
 * Accepts a persona or a persona id, and yields the persona.
 *
 * The persona comes first so that rendering a scenario writes the whole
 * persona, which is what adk-python writes, rather than collapsing it back to
 * an id the reader may not know.
 */
const userPersonaField = z.union([userPersonaModel.schema, personaIdCodec]);

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
      count: z.number(),
      generationInstruction: optionalField(z.string()),
      environmentContext: optionalField(z.string()),
      modelName: z.string(),
    },
    {name: 'ConversationGenerationConfig'},
  );

/**
 * Validates a scenario payload written in either the adk-python spelling
 * (`starting_prompt`) or the adk-js one (`startingPrompt`).
 *
 * @throws {InputValidationError} When the payload is not a valid scenario.
 * @throws {NotFoundError} When `userPersona` names no default persona.
 */
export function parseConversationScenario(raw: unknown): ConversationScenario {
  return conversationScenarioModel.parse(raw);
}

/**
 * Validates a scenarios document.
 *
 * @throws {InputValidationError} When the document is not a valid scenario
 *   list.
 * @throws {NotFoundError} When a scenario's `userPersona` names no default
 *   persona.
 */
export function parseConversationScenarios(
  raw: unknown,
): ConversationScenarios {
  return conversationScenariosModel.parse(raw);
}

/**
 * Validates a scenario generation config.
 *
 * @throws {InputValidationError} When the payload is not a valid config.
 */
export function parseConversationGenerationConfig(
  raw: unknown,
): ConversationGenerationConfig {
  return conversationGenerationConfigModel.parse(raw);
}
