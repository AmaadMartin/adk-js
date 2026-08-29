/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Tool} from '@google/genai';
import {NotFoundError} from '../errors/not_found_error.js';

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
 * Returns the developer instructions given to the named agent.
 *
 * @throws NotFoundError if the app holds no agent under that name.
 */
export function getDeveloperInstructions(
  appDetails: AppDetails,
  agentName: string,
): string {
  const agentDetails = appDetails.agentDetails ?? {};
  // `Object.hasOwn` rather than a truthiness test: an inherited key such as
  // `toString` would otherwise resolve and return `undefined` instead of
  // throwing.
  if (!Object.hasOwn(agentDetails, agentName)) {
    throw new NotFoundError(
      `\`${agentName}\` not found in the agentic system.`,
    );
  }
  return agentDetails[agentName].instructions ?? '';
}

/**
 * Returns the tools available to each agent in the app, keyed by agent name.
 *
 * Every agent gets an entry, including the agents that declare no tool.
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
