/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  FunctionCall,
  FunctionResponse,
  GroundingMetadata,
  Part,
} from '@google/genai';
import type {AppDetails} from './app_details.js';
import type {Rubric} from './eval_rubrics.js';

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

  /** The grounding metadata the model attached to the event. */
  groundingMetadata?: GroundingMetadata;
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
 * Recorded eval data uses {@link IntermediateData}; a run replayed from events
 * uses {@link InvocationEvents}. Narrow it with {@link isInvocationEvents}.
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

/** Values that initialize the session an eval case runs in. */
export interface SessionInput {
  appName: string;

  userId: string;

  /**
   * A fixed session id for this eval case. Artifacts are keyed by
   * `(appName, userId, sessionId)`, so pinning the id lets a case reach
   * artifacts that were pre-loaded for that session. When unset, a random id
   * is generated per case.
   */
  sessionId?: string;

  /** The state the session starts from. Applied only when creating it. */
  state?: Record<string, unknown>;
}

/** One evaluation case: a conversation plus the session it runs in. */
export interface EvalCase {
  /** Unique identifier for the eval case. */
  evalId: string;

  /** A static conversation between the user and the agent. */
  conversation?: Invocation[];

  sessionInput?: SessionInput;

  /** Creation time in seconds since the epoch. */
  creationTimestamp: number;

  /** The expected session state at the end of the conversation. */
  finalSessionState?: Record<string, unknown>;
}

/** Returns true when the intermediate data is a list of invocation events. */
export function isInvocationEvents(
  intermediateData: IntermediateDataType,
): intermediateData is InvocationEvents {
  return 'invocationEvents' in intermediateData;
}

/** Returns every tool call recorded in the given intermediate data. */
export function getAllToolCalls(
  intermediateData?: IntermediateDataType,
): FunctionCall[] {
  if (!intermediateData) {
    return [];
  }
  if (!isInvocationEvents(intermediateData)) {
    return intermediateData.toolUses ?? [];
  }
  const toolCalls: FunctionCall[] = [];
  for (const event of intermediateData.invocationEvents) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionCall) {
        toolCalls.push(part.functionCall);
      }
    }
  }
  return toolCalls;
}
