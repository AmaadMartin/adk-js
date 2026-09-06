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
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  PluginManager,
  RunConfig,
  Runner,
  Session,
} from '@google/adk';
import {Content, createUserContent} from '@google/genai';
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

function createMockInvocationContext(
  events: Event[],
  options: {runConfig?: RunConfig; userContent?: Content} = {},
): InvocationContext {
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
    runConfig: options.runConfig,
    userContent: options.userContent,
  });
}

function emptyRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

async function runProcessor(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
): Promise<void> {
  for await (const _ of CONTENT_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    // The processor only mutates the request; it emits no events.
  }
}

function requestTexts(llmRequest: LlmRequest): Array<string | undefined> {
  return llmRequest.contents.map((content) => content.parts?.[0]?.text);
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

describe('ContentRequestProcessor — previous interaction id', () => {
  function turn(invocationId: string, text: string): Event {
    return createEvent({
      invocationId,
      author: 'user',
      content: {role: 'user', parts: [{text}]},
    });
  }

  const history = [
    turn('inv1', 'question one'),
    turn('inv2', 'question two'),
    turn('inv3', 'question three'),
  ];

  it('sends only the current turn when the request carries one', async () => {
    const llmRequest = emptyRequest();
    llmRequest.previousInteractionId = 'interaction-1';

    await runProcessor(createMockInvocationContext(history), llmRequest);

    expect(requestTexts(llmRequest)).toEqual(['question three']);
  });

  it('keeps the full history when no previous interaction id is set', async () => {
    const llmRequest = emptyRequest();

    await runProcessor(createMockInvocationContext(history), llmRequest);

    expect(requestTexts(llmRequest)).toEqual([
      'question one',
      'question two',
      'question three',
    ]);
  });

  it('shortens a chained request when the agent runs its own processors', async () => {
    const agent = new LlmAgent({
      name: 'chat_agent',
      model: new Gemini({
        model: 'gemini-2.5-flash',
        apiKey: 'unused-in-this-test',
        useInteractionsApi: true,
      }),
    });
    const events = [
      createEvent({
        invocationId: 'inv1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'question one'}]},
      }),
      createEvent({
        invocationId: 'inv1',
        author: 'chat_agent',
        interactionId: 'interaction-1',
        content: {role: 'model', parts: [{text: 'answer one'}]},
      }),
      createEvent({
        invocationId: 'inv2',
        author: 'user',
        content: {role: 'user', parts: [{text: 'question two'}]},
      }),
    ];
    const invocationContext = new InvocationContext({
      invocationId: 'inv2',
      agent: agent as BaseAgent,
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        events,
      }),
      pluginManager: new PluginManager([]),
    });
    const llmRequest = emptyRequest();

    for (const processor of agent.requestProcessors) {
      for await (const _ of processor.runAsync(invocationContext, llmRequest)) {
        // These request processors emit no events for this agent.
      }
    }

    expect(llmRequest.previousInteractionId).toBe('interaction-1');
    expect(requestTexts(llmRequest)).toEqual(['question two']);
  });
});

describe('ContentRequestProcessor — model input context', () => {
  const userContent: Content = {role: 'user', parts: [{text: 'the question'}]};

  function userTurn(): Event {
    return createEvent({
      invocationId: 'inv1',
      author: 'user',
      content: {role: 'user', parts: [{text: 'the question'}]},
    });
  }

  function document(text: string): Content {
    return {role: 'user', parts: [{text}]};
  }

  it('inserts the block before the user content', async () => {
    const events = [userTurn()];
    const invocationContext = createMockInvocationContext(events, {
      runConfig: {modelInputContext: [document('a retrieved document')]},
      userContent,
    });
    const llmRequest = emptyRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(requestTexts(llmRequest)).toEqual([
      'a retrieved document',
      'the question',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].text).toBe('the question');
  });

  it('keeps the block before the user message across a tool call', async () => {
    const events = [
      userTurn(),
      createEvent({
        invocationId: 'inv1',
        author: 'test_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-1', name: 'lookup', args: {}}}],
        },
      }),
      createEvent({
        invocationId: 'inv1',
        author: 'test_agent',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {id: 'call-1', name: 'lookup', response: {}}},
          ],
        },
      }),
    ];
    const invocationContext = createMockInvocationContext(events, {
      runConfig: {modelInputContext: [document('a retrieved document')]},
      userContent,
    });
    const llmRequest = emptyRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(requestTexts(llmRequest)[0]).toBe('a retrieved document');
    expect(requestTexts(llmRequest)[1]).toBe('the question');
    expect(llmRequest.contents).toHaveLength(4);
  });

  it('does not alias the run config array into the request', async () => {
    const block = [document('a retrieved document')];
    const invocationContext = createMockInvocationContext([userTurn()], {
      runConfig: {modelInputContext: block},
      userContent,
    });
    const llmRequest = emptyRequest();

    await runProcessor(invocationContext, llmRequest);
    llmRequest.contents[0].parts![0].text = 'edited in the request';

    expect(block[0].parts?.[0].text).toBe('a retrieved document');
  });

  it('goes to the front for a turn that starts from another agent', async () => {
    const agent = new LlmAgent({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
      includeContents: 'none',
    });
    const invocationContext = new InvocationContext({
      invocationId: 'inv1',
      agent: agent as BaseAgent,
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        events: [
          userTurn(),
          createEvent({
            invocationId: 'inv1',
            author: 'coordinator',
            content: {role: 'model', parts: [{text: 'over to you'}]},
          }),
        ],
      }),
      pluginManager: new PluginManager([]),
      runConfig: {modelInputContext: [document('a retrieved document')]},
      userContent,
    });
    const llmRequest = emptyRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(requestTexts(llmRequest)).toEqual([
      'a retrieved document',
      'For context:',
    ]);
  });

  it('is a no-op for an empty model input context', async () => {
    const invocationContext = createMockInvocationContext([userTurn()], {
      runConfig: {modelInputContext: []},
      userContent,
    });
    const llmRequest = emptyRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(requestTexts(llmRequest)).toEqual(['the question']);
  });

  it('is a no-op when the run config omits the field', async () => {
    const invocationContext = createMockInvocationContext([userTurn()], {
      runConfig: {},
      userContent,
    });
    const llmRequest = emptyRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(requestTexts(llmRequest)).toEqual(['the question']);
  });
});

describe('ContentRequestProcessor — rewind filtering', () => {
  it('drops rewound events from the request contents', async () => {
    const events = [
      createEvent({
        invocationId: 'inv1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'question one'}]},
      }),
      createEvent({
        invocationId: 'inv2',
        author: 'user',
        content: {role: 'user', parts: [{text: 'question two'}]},
      }),
      createEvent({
        invocationId: 'inv3',
        author: 'user',
        actions: {rewindBeforeInvocationId: 'inv2'},
      }),
      createEvent({
        invocationId: 'inv3',
        author: 'user',
        content: {role: 'user', parts: [{text: 'question three'}]},
      }),
    ];
    const llmRequest = emptyRequest();

    await runProcessor(createMockInvocationContext(events), llmRequest);

    expect(requestTexts(llmRequest)).toEqual([
      'question one',
      'question three',
    ]);
  });
});

/** Records each request the agent sends and answers with a fixed reply. */
class CaptureLlm extends BaseLlm {
  static override readonly supportedModels = [/capture-model/];
  static readonly requests: LlmRequest[] = [];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    CaptureLlm.requests.push(structuredClone(llmRequest));
    yield {content: {role: 'model', parts: [{text: 'the answer'}]}};
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(CaptureLlm);

describe('model input context through the runner', () => {
  it('reaches the model without entering the session', async () => {
    CaptureLlm.requests.length = 0;
    const sessionService = new InMemorySessionService();
    const runner = new Runner({
      appName: 'test-app',
      agent: new LlmAgent({name: 'capture_agent', model: 'capture-model'}),
      sessionService,
    });
    const session = await sessionService.createSession({
      appName: 'test-app',
      userId: 'ada',
    });

    for await (const _ of runner.runAsync({
      userId: 'ada',
      sessionId: session.id,
      newMessage: createUserContent('the question'),
      runConfig: {
        modelInputContext: [createUserContent('a retrieved document')],
      },
    })) {
      // Drain the event stream so the invocation completes.
    }

    expect(CaptureLlm.requests).toHaveLength(1);
    expect(requestTexts(CaptureLlm.requests[0])).toEqual([
      'a retrieved document',
      'the question',
    ]);

    const stored = await sessionService.getSession({
      appName: 'test-app',
      userId: 'ada',
      sessionId: session.id,
    });
    const storedTexts = stored?.events.map((e) => e.content?.parts?.[0]?.text);
    expect(storedTexts).toEqual(['the question', 'the answer']);
  });
});
