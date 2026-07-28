/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Provided by evaluation sub-port #2 (data models); minimal stand-in pending
// merge. This sub-port only accepts a `ConversationScenario` as a pass-through
// argument (per-invocation evaluators ignore it), so the full scenario/persona
// model owned by #2 is intentionally not reproduced here.
// simplicity: minimal stand-in; the complete model (user personas, scenario
// containers, generation config) lands with sub-port #2.

import {z} from 'zod';

/**
 * Scenario for a conversation between a simulated user and the agent under test.
 */
export const ConversationScenarioSchema = z
  .object({
    /**
     * Starting prompt for the conversation. Acts as the fixed first user
     * message given to the agent.
     */
    startingPrompt: z.string(),
    /**
     * A plan the user simulation system follows as it plays out the
     * conversation.
     */
    conversationPlan: z.string(),
  })
  .strict();

/**
 * Scenario for a conversation between a simulated user and the agent under test.
 */
export type ConversationScenario = z.infer<typeof ConversationScenarioSchema>;
