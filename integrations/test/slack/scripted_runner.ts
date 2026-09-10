/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import type {Content} from '@google/genai';

/** The arguments of one recorded call to {@link ScriptedRunner.runAsync}. */
export interface RunCall {
  userId: string;
  sessionId: string;
  newMessage: Content;
}

/**
 * A {@link Runner} whose agent run is scripted.
 *
 * Its session service is a real {@link InMemorySessionService}, so a test can
 * assert which sessions the Slack runner created.
 */
export class ScriptedRunner extends Runner {
  /** Every call the Slack runner made, in order. */
  readonly runCalls: RunCall[] = [];
  /** The events each run yields. */
  events: Event[] = [];
  /** When set, the run throws this instead of yielding anything. */
  failure?: unknown;
  /** When set, the run throws this after yielding {@link events}. */
  lateFailure?: unknown;

  constructor() {
    super({
      appName: 'slack_app',
      agent: new LlmAgent({name: 'slack_agent', model: 'gemini-2.5-flash'}),
      sessionService: new InMemorySessionService(),
    });
  }

  override async *runAsync(params: {
    userId: string;
    sessionId: string;
    newMessage: Content;
  }): AsyncGenerator<Event, void, undefined> {
    this.runCalls.push({
      userId: params.userId,
      sessionId: params.sessionId,
      newMessage: params.newMessage,
    });
    if (this.failure !== undefined) {
      throw this.failure;
    }
    for (const event of this.events) {
      yield event;
    }
    if (this.lateFailure !== undefined) {
      throw this.lateFailure;
    }
  }
}

/** Builds a model event carrying one text part. */
export function modelEvent(text: string): Event {
  return createEvent({
    author: 'slack_agent',
    content: {role: 'model', parts: [{text}]},
  });
}
