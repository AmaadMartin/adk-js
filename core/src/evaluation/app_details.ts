/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Tool} from '@google/genai';
import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * Details about an individual agent in the app, either the root agent or a
 * sub-agent of the agent tree.
 */
export interface AgentDetails {
  /** The name that uniquely identifies the agent in the app. */
  name: string;

  /** The instructions set on the agent. Defaults to an empty string. */
  instructions?: string;

  /** The tools available to the agent. Defaults to an empty list. */
  toolDeclarations?: Tool[];
}

/**
 * Details about the app, that is the agentic system.
 *
 * This is a projection of the actual app. It holds only the details that the
 * eval system uses.
 */
export interface AppDetails {
  /** A mapping from the agent name to the details of that agent. */
  agentDetails?: Record<string, AgentDetails>;
}

/**
 * Returns the instructions the developer set on the named agent, which is an
 * empty string when the agent carries none.
 *
 * adk-python declares this as a method on its `AppDetails` model. `AppDetails`
 * is a structural interface here, so it takes the details as an argument.
 *
 * @throws {InputValidationError} When the app has no agent of that name.
 */
export function getDeveloperInstructions(
  appDetails: AppDetails,
  agentName: string,
): string {
  const agentDetails = appDetails.agentDetails ?? {};
  if (!Object.hasOwn(agentDetails, agentName)) {
    throw new InputValidationError(
      `\`${agentName}\` not found in the agentic system.`,
    );
  }
  return agentDetails[agentName].instructions ?? '';
}

/** Returns the tools of every agent in the app, keyed by the agent name. */
export function getToolsByAgentName(
  appDetails: AppDetails,
): Record<string, Tool[]> {
  return Object.fromEntries(
    Object.entries(appDetails.agentDetails ?? {}).map(([name, details]) => [
      name,
      details.toolDeclarations ?? [],
    ]),
  );
}
