/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
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
  LlmResponse,
  PluginManager,
  RoutedLlm,
  Session,
} from '@google/adk';
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

/** A non-Gemini provider, which pairs a tool call with its result by id. */
class StubLlm extends BaseLlm {
  generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }
  connect(): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

const TEST_API_KEY = 'test-api-key';

function createCallEvent(ids: string[], timestamp: number): Event {
  return createEvent({
    author: 'test_agent',
    timestamp,
    content: {
      role: 'model',
      parts: ids.map((id) => ({
        functionCall: {id, name: 'roll_die', args: {sides: 6}},
      })),
    },
  });
}

function createResponseEvent(id: string, timestamp: number): Event {
  return createEvent({
    author: 'user',
    timestamp,
    content: {
      role: 'user',
      parts: [
        {functionResponse: {id, name: 'roll_die', response: {result: 'four'}}},
      ],
    },
  });
}

function createContextForAgent(
  events: Event[],
  agent: LlmAgent,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: agent as BaseAgent,
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events,
    }),
    pluginManager: new PluginManager([]),
  });
}

async function runProcessor(
  invocationContext: InvocationContext,
): Promise<LlmRequest['contents']> {
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

async function buildContents(
  events: Event[],
  model: BaseLlm,
): Promise<LlmRequest['contents']> {
  return runProcessor(
    createContextForAgent(events, new LlmAgent({name: 'test_agent', model})),
  );
}

describe('ContentRequestProcessor function call ids', () => {
  const toolEvents = [
    createCallEvent(['adk-1'], 1000),
    createResponseEvent('adk-1', 2000),
  ];

  it('strips the ids for a plain Gemini model', async () => {
    const contents = await buildContents(
      toolEvents,
      new Gemini({model: 'gemini-2.5-flash', apiKey: TEST_API_KEY}),
    );

    expect(contents[0].parts?.[0].functionCall?.id).toBeUndefined();
    expect(contents[1].parts?.[0].functionResponse?.id).toBeUndefined();
  });

  it('keeps the ids for a Gemini model on the Interactions API', async () => {
    const contents = await buildContents(
      toolEvents,
      new Gemini({
        model: 'gemini-2.5-flash',
        apiKey: TEST_API_KEY,
        useInteractionsApi: true,
      }),
    );

    expect(contents[0].parts?.[0].functionCall?.id).toBe('adk-1');
    expect(contents[1].parts?.[0].functionResponse?.id).toBe('adk-1');
  });

  // Stands in for adk-python's test_adk_function_call_ids_preserved_for_
  // anthropic_model, ..._lite_llm_model and ..._openai_responses_model. None of
  // those provider classes exists on this branch.
  it('keeps the ids for a non-Gemini provider', async () => {
    const contents = await buildContents(
      toolEvents,
      new StubLlm({model: 'stub-provider'}),
    );

    expect(contents[0].parts?.[0].functionCall?.id).toBe('adk-1');
    expect(contents[1].parts?.[0].functionResponse?.id).toBe('adk-1');
  });

  it('strips the ids when a routed set includes a plain Gemini model', async () => {
    const routed = new RoutedLlm({
      models: [
        new Gemini({model: 'gemini-2.5-flash', apiKey: TEST_API_KEY}),
        new StubLlm({model: 'stub-provider'}),
      ],
      router: () => 'stub-provider',
    });

    const contents = await buildContents(toolEvents, routed);

    expect(contents[0].parts?.[0].functionCall?.id).toBeUndefined();
    expect(contents[1].parts?.[0].functionResponse?.id).toBeUndefined();
  });

  it('keeps the ids when every routed model pairs by id', async () => {
    const routed = new RoutedLlm({
      models: [new StubLlm({model: 'stub-a'}), new StubLlm({model: 'stub-b'})],
      router: () => 'stub-a',
    });

    const contents = await buildContents(toolEvents, routed);

    expect(contents[0].parts?.[0].functionCall?.id).toBe('adk-1');
    expect(contents[1].parts?.[0].functionResponse?.id).toBe('adk-1');
  });

  it('strips the ids when the agent resolves to no model', async () => {
    const contents = await runProcessor(
      createContextForAgent(toolEvents, new LlmAgent({name: 'test_agent'})),
    );

    expect(contents[0].parts?.[0].functionCall?.id).toBeUndefined();
  });

  it('keeps the ids on the current-turn-only path', async () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new StubLlm({model: 'stub-provider'}),
      includeContents: 'none',
    });

    const contents = await runProcessor(
      createContextForAgent(
        [
          createEvent({
            author: 'user',
            timestamp: 500,
            content: {role: 'user', parts: [{text: 'roll a die'}]},
          }),
          ...toolEvents,
        ],
        agent,
      ),
    );

    expect(contents[0].parts?.[0].functionCall?.id).toBe('adk-1');
    expect(contents[1].parts?.[0].functionResponse?.id).toBe('adk-1');
  });
});

describe('ContentRequestProcessor compacted call recovery', () => {
  it('recovers a call the summary elided and keeps it before its response', async () => {
    const events = [
      createCallEvent(['adk-lr1'], 1000),
      createCompactedEvent('c1', 1500, 1000, 1200, 'Summary of the call'),
      createResponseEvent('adk-lr1', 3000),
    ];

    const contents = await buildContents(
      events,
      new Gemini({model: 'gemini-2.5-flash', apiKey: TEST_API_KEY}),
    );

    expect(contents).toHaveLength(3);
    expect(contents[0].parts?.[0].text).toContain('Summary of the call');
    expect(contents[1].parts?.[0].functionCall?.name).toBe('roll_die');
    expect(contents[2].parts?.[0].functionResponse?.name).toBe('roll_die');
  });

  it('still reports an orphaned response the source cannot explain', async () => {
    const events = [
      createCompactedEvent('c1', 1500, 1000, 1200, 'Summary of the call'),
      createResponseEvent('adk-gone', 3000),
    ];

    await expect(
      buildContents(
        events,
        new Gemini({model: 'gemini-2.5-flash', apiKey: TEST_API_KEY}),
      ),
    ).rejects.toThrow(
      'No function call event found for function responses ids: adk-gone',
    );
  });
});
