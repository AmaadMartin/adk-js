/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from '@google/adk';
import {
  createSession,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import type {Content} from '@google/genai';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {MockLiveLlm, MockLlmConnection} from './mock_llm_connection.js';

function weatherTool() {
  return new FunctionTool({
    name: 'get_weather',
    description: 'Returns the weather for a city.',
    parameters: {
      type: Type.OBJECT,
      properties: {city: {type: Type.STRING}},
    },
    execute: async (args) => ({
      forecast: `sunny in ${(args as {city?: string}).city}`,
    }),
  });
}

function liveContext(
  agent: LlmAgent,
  queue: LiveRequestQueue,
  handle?: string,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_live_integration',
    session: createSession({id: 'session-1', appName: 'live-app'}),
    agent,
    pluginManager: new PluginManager(),
    liveRequestQueue: queue,
    liveSessionResumptionHandle: handle,
  });
}

describe('LlmAgent.runLive (integration)', () => {
  it('drives a full live turn: user content, model text, tool call, echo', async () => {
    const connection = new MockLlmConnection({
      responses: [
        {content: {role: 'model', parts: [{text: 'Let me check.'}]}},
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'get_weather',
                  args: {city: 'Paris'},
                  id: 'c1',
                },
              },
            ],
          },
        },
        {turnComplete: true},
      ],
      blockUntilClosed: true,
    });
    const model = new MockLiveLlm([connection]);
    const agent = new LlmAgent({
      name: 'weather_agent',
      model,
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      requestProcessors: [],
      tools: [weatherTool()],
    });

    const queue = new LiveRequestQueue();
    const userContent: Content = {
      role: 'user',
      parts: [{text: 'What is the weather in Paris?'}],
    };
    queue.sendContent(userContent);

    const events: Event[] = [];
    for await (const event of agent.runLive(liveContext(agent, queue))) {
      events.push(event);
      if (event.turnComplete) {
        queue.close();
      }
    }

    const texts = events
      .map((event) => event.content?.parts?.[0].text)
      .filter((text): text is string => !!text);
    expect(texts).toContain('Let me check.');

    const callEvent = events.find((event) =>
      event.content?.parts?.some((part) => part.functionCall),
    );
    const responseEvent = events.find((event) =>
      event.content?.parts?.some((part) => part.functionResponse),
    );
    expect(callEvent?.content?.parts?.[0].functionCall?.name).toBe(
      'get_weather',
    );
    expect(
      responseEvent?.content?.parts?.[0].functionResponse?.response,
    ).toEqual({forecast: 'sunny in Paris'});
    expect(events.some((event) => event.turnComplete)).toBe(true);

    // The send task forwards the user content and the echoed tool response.
    expect(connection.sentContents[0]).toEqual(userContent);
    expect(
      connection.sentContents.some(
        (content) =>
          content.parts?.[0].functionResponse?.name === 'get_weather',
      ),
    ).toBe(true);
  });

  it('reconnects with the session handle after a mid-stream drop', async () => {
    const firstConnection = new MockLlmConnection({
      responses: [
        {liveSessionResumptionUpdate: {newHandle: 'resume-token'}},
        {content: {role: 'model', parts: [{text: 'partial answer'}]}},
      ],
      receiveError: new Error('network drop'),
    });
    const secondConnection = new MockLlmConnection({
      responses: [
        {content: {role: 'model', parts: [{text: 'resumed answer'}]}},
        {turnComplete: true},
      ],
      blockUntilClosed: true,
    });
    const model = new MockLiveLlm([firstConnection, secondConnection]);
    const agent = new LlmAgent({
      name: 'resuming_agent',
      model,
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      requestProcessors: [],
    });

    const queue = new LiveRequestQueue();
    const events: Event[] = [];
    for await (const event of agent.runLive(liveContext(agent, queue))) {
      events.push(event);
      if (event.turnComplete) {
        queue.close();
      }
    }

    const texts = events
      .map((event) => event.content?.parts?.[0].text)
      .filter((text): text is string => !!text);
    expect(texts).toContain('partial answer');
    expect(texts).toContain('resumed answer');
    expect(model.connectCount).toBe(2);
    expect(model.connectHandles).toEqual([undefined, 'resume-token']);
  });
});
