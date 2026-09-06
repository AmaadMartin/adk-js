/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {AppDetails} from './app_details.js';

/**
 * A single point in an agent's invocation: a reply, a tool call, or a tool
 * result. This is a projection of the runtime `Event` for the eval system.
 */
export interface InvocationEvent {
  /** The name of the agent that authored this event. */
  author: string;

  content?: Content;
}

/** Events that occurred during one invocation. */
export interface InvocationEvents {
  invocationEvents: InvocationEvent[];
}

/** One turn of a conversation, from the user's message to the agent's reply. */
export interface Invocation {
  /** Unique identifier for the invocation. Defaults to an empty string. */
  invocationId?: string;

  userContent: Content;

  finalResponse?: Content;

  /** The route the agent took to reach {@link finalResponse}. */
  intermediateData?: InvocationEvents;

  /** Details about the app that served this invocation. */
  appDetails?: AppDetails;
}
