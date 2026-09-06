/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, FunctionCall} from '@google/genai';

/** Intermediate data an agent generated on the way to its final response. */
export interface IntermediateData {
  /** Tool use trajectory in chronological order. */
  toolUses?: FunctionCall[];
}

/**
 * A single point in an agent's invocation: a reply, a request to use a tool,
 * or a tool result.
 *
 * This is a projection of the runtime `Event` model, reduced to the fields
 * the evaluation system reads.
 */
export interface InvocationEvent {
  /** Name of the agent that authored this event. */
  author: string;

  /** The content of the event. */
  content?: Content;
}

/** Container for the events that occurred during one invocation. */
export interface InvocationEvents {
  invocationEvents: InvocationEvent[];
}

/**
 * The two shapes an invocation's intermediate data can take.
 *
 * `IntermediateData` is the flat trajectory a hand-written eval case carries.
 * `InvocationEvents` is what a recorded agent run produces.
 */
export type IntermediateDataType = IntermediateData | InvocationEvents;

/** Represents a single invocation of an agent. */
export interface Invocation {
  /** Content provided by the user in this invocation. */
  userContent: Content;

  /** Intermediate steps generated as part of agent execution. */
  intermediateData?: IntermediateDataType;
}

/** Whether intermediate data holds recorded events rather than a trajectory. */
export function isInvocationEvents(
  intermediateData: IntermediateDataType,
): intermediateData is InvocationEvents {
  return 'invocationEvents' in intermediateData;
}

/** Returns every tool call in intermediate data, in chronological order. */
export function getAllToolCalls(
  intermediateData?: IntermediateDataType,
): FunctionCall[] {
  if (!intermediateData) {
    return [];
  }

  if (isInvocationEvents(intermediateData)) {
    return intermediateData.invocationEvents.flatMap(
      (event) =>
        event.content?.parts?.flatMap((part) => part.functionCall ?? []) ?? [],
    );
  }

  return intermediateData.toolUses ?? [];
}
