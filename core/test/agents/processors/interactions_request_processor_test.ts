/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Agent,
  createEvent,
  Gemini,
  INTERACTIONS_REQUEST_PROCESSOR,
  InvocationContext,
  LlmRequest,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('InteractionsRequestProcessor', () => {
  it('should skip if agent is not LlmAgent', async () => {
    const context = new InvocationContext({
      invocationId: '1',
      session: {} as Session,
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    for await (const _event of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      context,
      request,
    )) {
      // should yield nothing
    }
    expect(request.previousInteractionId).toBeUndefined();
  });

  it('should skip if model is not Gemini with useInteractionsApi enabled', async () => {
    const agent = new Agent({
      name: 'agent_a',
      model: new Gemini({apiKey: 'key', useInteractionsApi: false}),
    });
    const context = new InvocationContext({
      invocationId: '1',
      session: {events: []} as unknown as Session,
      agent,
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };
    for await (const _event of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      context,
      request,
    )) {
      // should yield nothing
    }
    expect(request.previousInteractionId).toBeUndefined();
  });

  it('should extract latest interactionId from matching agent and branch', async () => {
    const agent = new Agent({
      name: 'agent_a',
      model: new Gemini({apiKey: 'key', useInteractionsApi: true}),
    });

    const event1 = createEvent({
      author: 'agent_a',
      branch: 'root',
      interactionId: 'interaction_1',
    });
    const event2 = createEvent({
      author: 'agent_b',
      branch: 'root',
      interactionId: 'interaction_2',
    });
    const event3 = createEvent({
      author: 'agent_a',
      branch: 'other_branch',
      interactionId: 'interaction_3',
    });

    const session: unknown = {events: [event1, event2, event3]};
    const context = new InvocationContext({
      invocationId: '1',
      session: session as Session,
      agent,
      branch: 'root',
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };

    for await (const _event of INTERACTIONS_REQUEST_PROCESSOR.runAsync(
      context,
      request,
    )) {
      // should yield nothing
    }

    expect(request.previousInteractionId).toBe('interaction_1');
  });
});
