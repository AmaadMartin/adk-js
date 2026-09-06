/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionCall,
  FunctionResponse,
  GroundingMetadata,
  Part,
} from '@google/genai';

import {AppDetails} from './app_details.js';

/**
 * Intermediate data an agent produces on its way to a final answer.
 */
export interface IntermediateData {
  /** Tool use trajectory in chronological order. */
  toolUses: FunctionCall[];

  /** Tool response trajectory in chronological order. */
  toolResponses: FunctionResponse[];

  /**
   * Responses that sub-agents emit to convey progress, as `[author, parts]`
   * pairs. These are distinct from the invocation's final response.
   */
  intermediateResponses: Array<[string, Part[]]>;
}

/**
 * A single point in an agent's invocation: a reply, a tool call, or a tool
 * result. This is a projection of the runtime `Event` for the eval system.
 */
export interface InvocationEvent {
  /** The name of the agent that authored this event. */
  author: string;

  content?: Content;

  /** The grounding metadata the model attached to the event. */
  groundingMetadata?: GroundingMetadata;
}

/** Events that occurred during one invocation. */
export interface InvocationEvents {
  invocationEvents: InvocationEvent[];
}

/**
 * The two shapes an invocation's intermediate steps can take. Recorded eval
 * data uses {@link IntermediateData}; a run replayed from events uses
 * {@link InvocationEvents}.
 */
export type IntermediateDataType = IntermediateData | InvocationEvents;

/** One turn of a conversation, from the user's message to the agent's reply. */
export interface Invocation {
  /** Unique identifier for the invocation. Defaults to an empty string. */
  invocationId?: string;

  userContent: Content;

  finalResponse?: Content;

  /** The route the agent took to reach {@link finalResponse}. */
  intermediateData?: IntermediateDataType;

  /**
   * Creation time in seconds since the epoch, for debugging. Defaults to 0.
   */
  creationTimestamp?: number;

  /** Details about the app that served this invocation. */
  appDetails?: AppDetails;
}

/** Returns true when the intermediate data is a list of invocation events. */
export function isInvocationEvents(
  value: IntermediateDataType,
): value is InvocationEvents {
  return 'invocationEvents' in value;
}
