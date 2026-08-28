/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, GroundingMetadata} from '@google/genai';

/**
 * An immutable record of one point in an agent's invocation.
 *
 * It captures an agent's replies, its requests to use tools, and the tool
 * results. This is a projection of {@link Event} for the eval system.
 */
export interface InvocationEvent {
  /** The name of the agent that authored this event. */
  author: string;

  /**
   * The content of the event.
   *
   * Absent when the event is the invocation's final response and carries no
   * function call, because the response body is already on
   * {@link Invocation.finalResponse}.
   */
  content?: Content;

  /** Grounding metadata emitted with the event. */
  groundingMetadata?: GroundingMetadata;
}

/**
 * A container for the events that occur during one invocation.
 *
 * The wrapper is the shape an `.evalset.json` file carries, and the
 * `invocationEvents` key is what tells `google/adk-python` to read the object
 * as this arm of its `intermediate_data` union rather than as the tool-use
 * arm. Do not flatten it to a bare array.
 */
export interface InvocationEvents {
  /** The events of the invocation, in the order the agent emitted them. */
  invocationEvents: InvocationEvent[];
}

/** Represents a single invocation. */
export interface Invocation {
  /** Unique identifier for the invocation. */
  invocationId: string;

  /** Content provided by the user in this invocation. */
  userContent: Content;

  /** Final response from the agent, absent when the turn produced none. */
  finalResponse?: Content;

  /**
   * Intermediate steps generated as part of agent execution.
   *
   * For a multi-agent system, these show the route the agents took to reach
   * the final response. A turn with no intermediate step carries an empty
   * list, so readers never have to test for absence.
   */
  intermediateData: InvocationEvents;

  /**
   * Creation time in milliseconds since the epoch, taken from the invocation's
   * user event. Zero when the invocation has no user event.
   *
   * `google/adk-python` records this field in seconds, because its
   * `Event.timestamp` is in seconds. adk-js keeps the unit of its own
   * `Event.timestamp`, so a serializer that writes eval sets for adk-python
   * must convert at that boundary.
   */
  creationTimestamp: number;
}
