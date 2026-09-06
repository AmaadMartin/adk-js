/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {ConversationScenario} from './conversation_scenarios.js';

export type {ConversationScenario} from './conversation_scenarios.js';

/** One turn of a conversation, from the user's message to the agent's reply. */
export interface Invocation {
  /** Unique identifier for the invocation. Defaults to an empty string. */
  invocationId?: string;

  userContent: Content;

  finalResponse?: Content;

  /**
   * Creation time in seconds since the epoch, for debugging. Defaults to 0.
   */
  creationTimestamp?: number;
}

/** A conversation whose user turns are already recorded. */
export type StaticConversation = Invocation[];

/**
 * One evaluation case: a conversation, or the scenario a simulated user plays
 * out.
 */
export interface EvalCase {
  /** Unique identifier for the eval case. */
  evalId: string;

  /**
   * A static conversation between the user and the agent. Set this or
   * {@link conversationScenario}, but not both.
   */
  conversation?: StaticConversation;

  /**
   * A scenario a user simulator plays out. Set this or {@link conversation},
   * but not both.
   */
  conversationScenario?: ConversationScenario;

  /** Creation time in seconds since the epoch. Defaults to 0. */
  creationTimestamp?: number;
}
