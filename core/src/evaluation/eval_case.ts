/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionCall, FunctionResponse, Part} from '@google/genai';
import {AppDetails} from './app_details.js';
import {Rubric} from './eval_rubrics.js';

/**
 * Intermediate data that an agent generates on the way to a final answer.
 */
export interface IntermediateData {
  /** Tool use trajectory, in chronological order. */
  toolUses?: FunctionCall[];

  /** Tool response trajectory, in chronological order. */
  toolResponses?: FunctionResponse[];

  /**
   * Responses that sub-agents generate to report progress, as opposed to the
   * final response. Each entry pairs the author, usually the sub-agent name,
   * with the parts of that response.
   */
  intermediateResponses?: Array<[string, Part[]]>;
}

/**
 * A record of a specific point in the agent's invocation. It holds an agent
 * reply, a request to use a tool, or a tool result.
 *
 * This is a projection of the `Event` data model for the eval system.
 */
export interface InvocationEvent {
  /** The name of the agent that authored this event. */
  author: string;

  /** The content of the event. */
  content?: Content;
}

/**
 * The events that occur during an invocation.
 */
export interface InvocationEvents {
  /** The events of the invocation. */
  invocationEvents: InvocationEvent[];
}

/**
 * The intermediate steps of an invocation, in either supported shape.
 *
 * Narrow it with `'invocationEvents' in value`.
 */
export type IntermediateDataType = IntermediateData | InvocationEvents;

/**
 * A single invocation of an agent.
 */
export interface Invocation {
  /** Unique identifier for the invocation. Defaults to an empty string. */
  invocationId?: string;

  /** Content that the user provided in this invocation. */
  userContent: Content;

  /** Final response from the agent. */
  finalResponse?: Content;

  /**
   * Intermediate steps that the agent generated during this invocation. For a
   * multi-agent system, these show the route the agent took to the final
   * response.
   */
  intermediateData?: IntermediateDataType;

  /**
   * Timestamp of the invocation, in seconds. Intended for debugging. Defaults
   * to 0.
   */
  creationTimestamp?: number;

  /** Rubrics that apply to this invocation only. */
  rubrics?: Rubric[];

  /** Details about the app that served this invocation. */
  appDetails?: AppDetails;
}
