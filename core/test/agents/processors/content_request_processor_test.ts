/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  CompactedEvent,
  CONTENT_REQUEST_PROCESSOR,
  createSession,
  Event,
  EventActions,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
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
    model: 'gemini-2.5-flash',
  });

  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: agent as BaseAgent,
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

function createContextWithModelInputContext(params: {
  events: Event[];
  userContent?: Content;
  modelInputContext?: Content[];
}): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.5-flash',
    }) as BaseAgent,
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events: params.events,
    }),
    pluginManager: new PluginManager([]),
    userContent: params.userContent,
    runConfig: {modelInputContext: params.modelInputContext},
  });
}

async function runProcessor(
  invocationContext: InvocationContext,
): Promise<LlmRequest> {
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
  return llmRequest;
}

describe('ContentRequestProcessor modelInputContext', () => {
  const events = [
    createMockEvent('1', 1000, 'Earlier message'),
    createMockEvent('2', 2000, 'Current message'),
  ];
  const userContent: Content = {
    role: 'user',
    parts: [{text: 'Current message'}],
  };
  const transientContext: Content = {
    role: 'user',
    parts: [{text: 'Today is Tuesday.'}],
  };

  it('inserts the context immediately before the matching user content', async () => {
    const llmRequest = await runProcessor(
      createContextWithModelInputContext({
        events,
        userContent,
        modelInputContext: [transientContext],
      }),
    );

    expect(
      llmRequest.contents.map((content) => content.parts?.[0]?.text),
    ).toEqual(['Earlier message', 'Today is Tuesday.', 'Current message']);
  });

  it('inserts at the front when no content matches the user content', async () => {
    const llmRequest = await runProcessor(
      createContextWithModelInputContext({
        events,
        userContent: {role: 'user', parts: [{text: 'Never sent'}]},
        modelInputContext: [transientContext],
      }),
    );

    expect(
      llmRequest.contents.map((content) => content.parts?.[0]?.text),
    ).toEqual(['Today is Tuesday.', 'Earlier message', 'Current message']);
  });

  it('inserts at the front when the invocation has no user content', async () => {
    const llmRequest = await runProcessor(
      createContextWithModelInputContext({
        events,
        modelInputContext: [transientContext],
      }),
    );

    expect(llmRequest.contents[0].parts?.[0]?.text).toBe('Today is Tuesday.');
  });

  it('copies the context so the caller array is not aliased', async () => {
    const caller: Content = {
      role: 'user',
      parts: [{text: 'Today is Tuesday.'}],
    };
    const llmRequest = await runProcessor(
      createContextWithModelInputContext({
        events,
        userContent,
        modelInputContext: [caller],
      }),
    );

    const inserted = llmRequest.contents[1];
    expect(inserted).not.toBe(caller);
    inserted.parts![0].text = 'Mutated';
    expect(caller.parts![0].text).toBe('Today is Tuesday.');
  });

  it('does nothing for an empty context', async () => {
    const llmRequest = await runProcessor(
      createContextWithModelInputContext({
        events,
        userContent,
        modelInputContext: [],
      }),
    );

    expect(
      llmRequest.contents.map((content) => content.parts?.[0]?.text),
    ).toEqual(['Earlier message', 'Current message']);
  });

  it('does nothing when the run config carries no context', async () => {
    const llmRequest = await runProcessor(
      createContextWithModelInputContext({events, userContent}),
    );

    expect(
      llmRequest.contents.map((content) => content.parts?.[0]?.text),
    ).toEqual(['Earlier message', 'Current message']);
  });
});
