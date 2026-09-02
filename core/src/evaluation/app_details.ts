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
