/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * Details about an individual agent in the App.
 *
 * This could be the root agent or a sub-agent in the agent tree.
 */
export const AgentDetailsSchema = z
  .object({
    /** The name of the agent that uniquely identifies it in the App. */
    name: z.string(),
    /** The instructions set on the agent. */
    instructions: z.string().default(''),
    /**
     * A list of tools available to the agent. At runtime these are genai
     * `ToolListUnion` elements; typed as `unknown[]` for parity with
     * adk-python's `list[Any]`.
     */
    toolDeclarations: z.array(z.unknown()).default(() => []),
  })
  .strict();

/**
 * Details about an individual agent in the App.
 */
export type AgentDetails = z.infer<typeof AgentDetailsSchema>;

/**
 * Details about the App (the agentic system).
 *
 * This structure is only a projection of the actual app: only details relevant
 * to the eval system are captured here.
 */
export const AppDetailsSchema = z
  .object({
    /** A mapping from the agent name to the details of that agent. */
    agentDetails: z.record(z.string(), AgentDetailsSchema).default(() => ({})),
  })
  .strict();

/**
 * Details about the App (the agentic system).
 */
export type AppDetails = z.infer<typeof AppDetailsSchema>;

/**
 * Returns the developer instructions for a named agent.
 *
 * @throws {Error} If the agent name is not found in the agentic system.
 */
export function getDeveloperInstructions(
  appDetails: AppDetails,
  agentName: string,
): string {
  const agent = appDetails.agentDetails[agentName];
  if (!agent) {
    throw new Error(`\`${agentName}\` not found in the agentic system.`);
  }
  return agent.instructions;
}

/**
 * Returns the tools available to each agent in the App, keyed by agent name.
 */
export function getToolsByAgentName(
  appDetails: AppDetails,
): Record<string, unknown[]> {
  const tools: Record<string, unknown[]> = {};
  for (const [name, details] of Object.entries(appDetails.agentDetails)) {
    tools[name] = details.toolDeclarations;
  }
  return tools;
}
