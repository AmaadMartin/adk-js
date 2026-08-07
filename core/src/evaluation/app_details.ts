/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Tool} from '@google/genai';

// PROVISIONAL: This is a minimal, parity-faithful subset of the evaluation base
// types (ported from adk-python's `app_details.py`). It is provided so this
// port is self-contained and buildable regardless of merge ordering. It is
// superseded by the full evaluation base modules (evaluation sub-ports #1/#2),
// which a later rebase reconciles.

/**
 * Details about an individual agent in the App.
 *
 * This could be a root agent or a sub-agent in the agent tree.
 */
export interface AgentDetails {
  /** The name of the agent that uniquely identifies it in the App. */
  name: string;

  /** The instructions set on the agent. */
  instructions: string;

  /** A list of tools available to the agent. */
  toolDeclarations: Tool[];
}

/**
 * Contains details about the App (the agentic system).
 *
 * This structure is only a projection of the actual app. Only details that are
 * relevant to the Eval System are captured here.
 */
export interface AppDetails {
  /** A mapping from the agent name to the details of that agent. */
  agentDetails: Record<string, AgentDetails>;
}
