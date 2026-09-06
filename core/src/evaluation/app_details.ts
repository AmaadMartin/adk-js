/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Tool} from '@google/genai';

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
 * Returns the instructions the developer set on the named agent, or an empty
 * string when the agent carries none.
 *
 * adk-python declares this as a method on its `AppDetails` pydantic model.
 * `AppDetails` is a plain interface here, so the app details are the first
 * argument.
 *
 * @throws {Error} If the app holds no agent under that name.
 */
export function getDeveloperInstructions(
  appDetails: AppDetails,
  agentName: string,
): string {
  const agentDetails = appDetails.agentDetails ?? {};
  // `Object.hasOwn` rather than a lookup: an inherited key such as `toString`
  // resolves through `Object.prototype`, so a plain lookup would answer for an
  // agent the app does not hold. Python's `in` on a `dict` has no such hole.
  if (!Object.hasOwn(agentDetails, agentName)) {
    throw new Error(`\`${agentName}\` not found in the agentic system.`);
  }
  return agentDetails[agentName].instructions ?? '';
}

/**
 * Returns the tools of every agent in the app, keyed by the agent name.
 *
 * An agent that declares no tool keeps its entry, mapped to an empty list. The
 * lists are the caller's own arrays rather than copies, matching adk-python.
 */
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
