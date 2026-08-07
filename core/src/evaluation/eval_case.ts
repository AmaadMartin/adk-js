/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {AppDetails} from './app_details.js';

// PROVISIONAL: This is a minimal, parity-faithful subset of the evaluation base
// types (ported from adk-python's `eval_case.py`). It is provided so this port
// is self-contained and buildable regardless of merge ordering. It is
// superseded by the full evaluation base modules (evaluation sub-ports #1/#2),
// which a later rebase reconciles.

/**
 * An immutable record representing a specific point in the agent's invocation.
 *
 * It captures the agent's replies, requests to use tools (function calls), and
 * tool results. This structure is a simple projection of the actual `Event`
 * datamodel that is intended for the Eval System.
 */
export interface InvocationEvent {
  /** The name of the agent that authored/owned this event. */
  author: string;

  /** The content of the event. */
  content?: Content;
}

/** A container for events that occur during the course of an invocation. */
export interface InvocationEvents {
  /** A list of invocation events. */
  invocationEvents: InvocationEvent[];
}

/**
 * Represents a single invocation.
 *
 * NOTE (provisional): the full base type models `intermediateData` as a union
 * of `IntermediateData | InvocationEvents`. This subset only models the
 * `InvocationEvents` variant, which is the shape consumed by the multi-turn
 * metrics.
 */
export interface Invocation {
  /** Unique identifier for the invocation. */
  invocationId: string;

  /** Content provided by the user in this invocation. */
  userContent: Content;

  /** Final response from the agent. */
  finalResponse?: Content;

  /** Intermediate steps generated as a part of agent execution. */
  intermediateData?: InvocationEvents;

  /** Details about the App that was used for this invocation. */
  appDetails?: AppDetails;
}
