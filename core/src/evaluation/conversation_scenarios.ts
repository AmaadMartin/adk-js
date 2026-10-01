/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {UserPersonaSchema} from './simulation/user_simulator_personas.js';

/**
 * Scenario for a conversation between a simulated user and the agent under test.
 */
export const ConversationScenarioSchema = z
  .object({
    /**
     * Starting prompt for the conversation. Acts as the fixed first user
     * message given to the agent. Subsequent user messages are produced by the
     * user simulation system.
     */
    startingPrompt: z.string(),
    /**
     * A plan the user simulation system follows as it plays out the
     * conversation.
     */
    conversationPlan: z.string(),
    // The persona-id resolution (string id -> persona lookup via the default
    // registry) is deferred to the simulation subsystem sub-port, when the
    // persona registry lands. For now `userPersona` accepts a persona object.
    /**
     * User persona that the user simulator should adopt.
     */
    userPersona: UserPersonaSchema.optional(),
  })
  .strict();

/**
 * Scenario for a conversation between a simulated user and the agent under test.
 */
export type ConversationScenario = z.infer<typeof ConversationScenarioSchema>;

/**
 * A container for a list of {@link ConversationScenario}.
 *
 * Mainly serves the purpose of helping with serialization and deserialization.
 */
export const ConversationScenariosSchema = z
  .object({
    /** A list of conversation scenarios. */
    scenarios: z.array(ConversationScenarioSchema).default(() => []),
  })
  .strict();

/**
 * A container for a list of {@link ConversationScenario}.
 */
export type ConversationScenarios = z.infer<typeof ConversationScenariosSchema>;

/**
 * Configuration for generating conversation scenarios.
 */
export const ConversationGenerationConfigSchema = z
  .object({
    /** The number of conversation scenarios to generate. */
    count: z.number(),
    /** Optional natural language goal to guide the eval set generation. */
    generationInstruction: z.string().optional(),
    /**
     * Context describing the backend data or state accessible to the agent's
     * tools. Acts as the "ground truth" for the simulation, ensuring generated
     * queries reference data that actually exists.
     */
    environmentContext: z.string().optional(),
    /** The name of the Gemini model to use for generating the scenarios. */
    modelName: z.string(),
  })
  .strict();

/**
 * Configuration for generating conversation scenarios.
 */
export type ConversationGenerationConfig = z.infer<
  typeof ConversationGenerationConfigSchema
>;
