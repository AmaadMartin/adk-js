/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompactedEvent,
  CONTENT_REQUEST_PROCESSOR,
  createEvent,
  createSession,
  Event,
  EventActions,
  Gemini,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  RunConfig,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createMockEvent(id: string, timestamp: number, text: string): Event {
  return {
    id,
    invocationId: 'test-invoc',
    author: 'user',
    actions: {} as EventActions,
    timestamp,
    content: {
      role: 'user',
      parts: [{text}],
    },
  };
}

function createCompactedEvent(
  id: string,
  timestamp: number,
  startTime: number,
  endTime: number,
  compactedContent: string,
): CompactedEvent {
  return {
    id,
    invocationId: 'test-invoc',
    author: 'system',
    actions: {} as EventActions,
    timestamp,
    isCompacted: true,
    startTime,
    endTime,
    compactedContent,
  };
}

function createMockInvocationContext(events: Event[]): InvocationContext {
  const session = {
    id: 'test-session',
    events,
    appName: 'test-app',
    userId: 'test-user',
  } as unknown as Session;

  const agent = new LlmAgent({
    name: 'test_agent',
    model: new Gemini({model: 'gemini-2.5-flash', apiKey: 'test-api-key'}),
  });

  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session,
    pluginManager: new PluginManager([]),
  });
}

describe('ContentRequestProcessor', () => {
  it('should format CompactedEvent first and elide covered events', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 1000, 'Original message 1'),
      createMockEvent('2', 2000, 'Original message 2'),
      createMockEvent('3', 3000, 'Original message 3'), // This should be covered
      createCompactedEvent('c1', 3500, 1000, 3000, 'Summary of messages 1-3'),
      createMockEvent('4', 4000, 'New message 4'),
    ];

    const invocationContext = createMockInvocationContext(rawEvents);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.contents.length).toBe(2);

    // First element in context should be the CompactedEvent, formatted as user context
    const compactedContext = llmRequest.contents[0];
    expect(compactedContext.role).toBe('user');
    expect(compactedContext.parts?.[0]?.text).toContain(
      'Summary of messages 1-3',
    );

    // Second element should be message 4 (event 1-3 are elided)
    const newContext = llmRequest.contents[1];
    expect(newContext.role).toBe('user');
    expect(newContext.parts?.[0]?.text).toBe('New message 4');
  });

  it('should reorder events placing the compacted event first', async () => {
    // A scenario where events 4 and 5 happened before the compact event was written to the session,
    // but the compact event only summarized up to event 3.
    const rawEvents: Event[] = [
      createMockEvent('1', 1000, 'Original message 1'),
      createMockEvent('2', 2000, 'Original message 2'),
      createMockEvent('3', 3000, 'Original message 3'), // This should be covered
      createMockEvent('4', 4000, 'New message 4'),
      createMockEvent('5', 5000, 'New message 5'),
      createCompactedEvent('c1', 6000, 1000, 3000, 'Summary of messages 1-3'),
    ];

    const invocationContext = createMockInvocationContext(rawEvents);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.contents.length).toBe(3);

    // First element in context should be the CompactedEvent, formatted as user context, despite being last in rawEvents
    const compactedContext = llmRequest.contents[0];
    expect(compactedContext.role).toBe('user');
    expect(compactedContext.parts?.[0]?.text).toContain(
      'Summary of messages 1-3',
    );

    // Messages 4 and 5 follow
    expect(llmRequest.contents[1].parts?.[0]?.text).toContain('New message 4');
    expect(llmRequest.contents[2].parts?.[0]?.text).toContain('New message 5');
  });

  it('should only ever produce one compacted event', async () => {
    const rawEvents: Event[] = [
      createMockEvent('1', 1000, 'Original message 1'),
      createMockEvent('2', 2000, 'Original message 2'),
      createCompactedEvent('c1', 3000, 1000, 2000, 'Summary 1-2'),
      createMockEvent('3', 4000, 'Original message 3'),
      createCompactedEvent('c2', 5000, 1000, 4000, 'Summary 1-3'),
      createMockEvent('4', 6000, 'New message 4'),
    ];

    const invocationContext = createMockInvocationContext(rawEvents);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }

    expect(llmRequest.contents.length).toBe(2);

    // First is the latest compacted event
    expect(llmRequest.contents[0].parts?.[0]?.text).toContain('Summary 1-3');
    // Followed by message 4
    expect(llmRequest.contents[1].parts?.[0]?.text).toContain('New message 4');
  });
});

describe('ContentRequestProcessor — function call ids', () => {
  function callAndResponseEvents(): Event[] {
    return [
      createEvent({
        author: 'test_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool', id: 'adk-1', args: {}}}],
        },
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'tool', id: 'adk-1', response: {}}},
          ],
        },
      }),
    ];
  }

  async function contentsFor(model: Gemini): Promise<Content[]> {
    const session = createSession({
      id: 'test-session',
      events: callAndResponseEvents(),
      appName: 'test-app',
      userId: 'test-user',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent', model}),
      session,
      pluginManager: new PluginManager([]),
    });
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }
    return llmRequest.contents;
  }

  it('strips the adk- ids for a plain Gemini model', async () => {
    const contents = await contentsFor(
      new Gemini({model: 'gemini-2.5-flash', apiKey: 'test-api-key'}),
    );

    expect(contents[0].parts?.[0].functionCall?.id).toBeUndefined();
  });

  it('preserves the adk- ids for a Gemini model on the Interactions API', async () => {
    const contents = await contentsFor(
      new Gemini({
        model: 'gemini-2.5-flash',
        apiKey: 'test-api-key',
        useInteractionsApi: true,
      }),
    );

    expect(contents[0].parts?.[0].functionCall?.id).toBe('adk-1');
  });
});

describe('ContentRequestProcessor — thoughts from other agents', () => {
  const thinkingEvent = createEvent({
    author: 'other_agent',
    invocationId: 'test-invocation',
    content: {
      role: 'model',
      parts: [{text: 'weighing options', thought: true}, {text: 'done'}],
    },
  });

  async function contentsFor(
    includeContents: 'default' | 'none',
    runConfig?: RunConfig,
  ): Promise<string[]> {
    const session = createSession({
      id: 'test-session',
      events: [thinkingEvent],
      appName: 'test-app',
      userId: 'test-user',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({
        name: 'test_agent',
        model: new Gemini({model: 'gemini-2.5-flash', apiKey: 'test-api-key'}),
        includeContents,
      }),
      session,
      pluginManager: new PluginManager([]),
      runConfig,
    });
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // intentionally empty
    }
    return llmRequest.contents.flatMap((content) =>
      (content.parts ?? []).map((part) => part.text ?? ''),
    );
  }

  it('relays the thoughts into the full history when the run config asks', async () => {
    const texts = await contentsFor('default', {
      includeThoughtsFromOtherAgents: true,
    });

    expect(texts).toContain('[other_agent] thought: weighing options');
  });

  it('omits the thoughts from the full history by default', async () => {
    const texts = await contentsFor('default');

    expect(texts).not.toContain('[other_agent] thought: weighing options');
    expect(texts).toContain('[other_agent] said: done');
  });

  it('omits the thoughts from a current-turn build even when the run config asks', async () => {
    const texts = await contentsFor('none', {
      includeThoughtsFromOtherAgents: true,
    });

    expect(texts).not.toContain('[other_agent] thought: weighing options');
    expect(texts).toContain('[other_agent] said: done');
  });
});
