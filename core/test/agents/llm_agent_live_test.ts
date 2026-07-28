/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
  createEvent,
  Event,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Session,
} from '@google/adk';
import {Blob, Content, Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

/**
 * Parity with the private `MAX_LIVE_RECONNECT_ATTEMPTS` constant in
 * `llm_agent.ts`. Kept in sync manually because the constant is module-private.
 */
const MAX_LIVE_RECONNECT_ATTEMPTS = 5;

interface MockConnectionOptions {
  receiveError?: Error;
  blockUntilClosed?: boolean;
}

/**
 * A scriptable live connection whose `receive()` yields a supplied list of
 * responses (optionally throwing to simulate a drop) and which records every
 * outbound call.
 */
class MockLlmConnection implements BaseLlmConnection {
  readonly sentHistory: Content[][] = [];
  readonly sentContents: Content[] = [];
  readonly sentRealtimeBlobs: Blob[] = [];
  activityStartCount = 0;
  activityEndCount = 0;
  closeCount = 0;

  private isClosed = false;
  private resolveClosed!: () => void;
  private readonly closedPromise: Promise<void>;

  constructor(
    private readonly responses: LlmResponse[] = [],
    private readonly options: MockConnectionOptions = {},
  ) {
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async sendHistory(history: Content[]): Promise<void> {
    this.sentHistory.push(history);
  }

  async sendContent(content: Content): Promise<void> {
    this.sentContents.push(content);
  }

  async sendRealtime(blob: Blob): Promise<void> {
    this.sentRealtimeBlobs.push(blob);
  }

  async sendActivityStart(): Promise<void> {
    this.activityStartCount++;
  }

  async sendActivityEnd(): Promise<void> {
    this.activityEndCount++;
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for (const response of this.responses) {
      yield response;
    }
    if (this.options.receiveError) {
      throw this.options.receiveError;
    }
    if (this.options.blockUntilClosed) {
      await this.closedPromise;
    }
  }

  async close(): Promise<void> {
    if (!this.isClosed) {
      this.isClosed = true;
      this.closeCount++;
      this.resolveClosed();
    }
  }
}

/**
 * A live model whose `connect()` returns a queued sequence of connections (to
 * script reconnects), recording the number of calls and the resumption handle
 * observed on each `llmRequest.liveConnectConfig`.
 */
class MockLiveLlm extends BaseLlm {
  connectCount = 0;
  readonly connectHandles: Array<string | undefined> = [];
  private readonly connections: MockLlmConnection[];

  constructor(
    connections: MockLlmConnection[],
    private readonly connectError?: Error,
  ) {
    super({model: 'mock-live-llm'});
    this.connections = [...connections];
  }

  // eslint-disable-next-line require-yield
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    throw new Error('generateContentAsync is not used by the live flow.');
  }

  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.connectCount++;
    this.connectHandles.push(
      llmRequest.liveConnectConfig.sessionResumption?.handle,
    );
    const connection = this.connections.shift();
    if (!connection) {
      throw this.connectError ?? new Error('No more mock connections queued.');
    }
    return connection;
  }
}

/** Exposes the protected live entry point so tests can drive `runLiveFlow`. */
class TestLlmAgent extends LlmAgent {
  async *testRunLive(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runLiveImpl(context);
  }
}

/** A request processor that seeds `llmRequest.contents` for history tests. */
class HistoryRequestProcessor extends BaseLlmRequestProcessor {
  constructor(private readonly contents: Content[]) {
    super();
  }

  // eslint-disable-next-line require-yield
  async *runAsync(
    _invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    llmRequest.contents.push(...this.contents);
  }
}

/** A request processor that ends the invocation during preprocessing. */
class EndInvocationProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield
  async *runAsync(
    invocationContext: InvocationContext,
    _llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    invocationContext.endInvocation = true;
  }
}

/** A response processor that always emits one extra event. */
class EchoResponseProcessor extends BaseLlmResponseProcessor {
  async *runAsync(
    _invocationContext: InvocationContext,
    _llmResponse: LlmResponse,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      author: 'response_processor',
      content: {role: 'model', parts: [{text: 'from-processor'}]},
    });
  }
}

interface AgentOptions {
  requestProcessors?: BaseLlmRequestProcessor[];
  responseProcessors?: BaseLlmResponseProcessor[];
  tools?: FunctionTool[];
}

function createAgent(model: BaseLlm, options: AgentOptions = {}): TestLlmAgent {
  return new TestLlmAgent({
    name: 'live_agent',
    model,
    // Disable transfer so the default AGENT_TRANSFER processor is not appended
    // (it would require full session state that these unit tests do not build).
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    requestProcessors: options.requestProcessors ?? [],
    responseProcessors: options.responseProcessors,
    tools: options.tools,
  });
}

interface ContextOptions {
  queue?: LiveRequestQueue;
  handle?: string;
  abortSignal?: AbortSignal;
  withoutQueue?: boolean;
}

function createLiveContext(
  agent: LlmAgent,
  options: ContextOptions = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_live',
    session: {} as Session,
    agent,
    pluginManager: new PluginManager(),
    liveRequestQueue: options.withoutQueue
      ? undefined
      : (options.queue ?? new LiveRequestQueue()),
    liveSessionResumptionHandle: options.handle,
    abortSignal: options.abortSignal,
  });
}

async function collect(
  generator: AsyncGenerator<Event, void, void>,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

const modelContentResponse = (text: string): LlmResponse => ({
  content: {role: 'model', parts: [{text}]},
});

describe('LlmAgent.runLiveFlow', () => {
  it('sends history on the first connect when contents are present', async () => {
    const content: Content = {role: 'user', parts: [{text: 'hello'}]};
    const connection = new MockLlmConnection();
    const model = new MockLiveLlm([connection]);
    const agent = createAgent(model, {
      requestProcessors: [new HistoryRequestProcessor([content])],
    });
    const ctx = createLiveContext(agent);

    await collect(agent.testRunLive(ctx));

    expect(connection.sentHistory).toEqual([[content]]);
  });

  it('does not send history when contents are empty', async () => {
    const connection = new MockLlmConnection();
    const model = new MockLiveLlm([connection]);
    const agent = createAgent(model);
    const ctx = createLiveContext(agent);

    await collect(agent.testRunLive(ctx));

    expect(connection.sentHistory).toEqual([]);
  });

  it('yields a model content response as an agent-authored event', async () => {
    const connection = new MockLlmConnection([
      modelContentResponse('hi there'),
    ]);
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('live_agent');
    expect(events[0].content?.parts?.[0].text).toBe('hi there');
  });

  it('authors input transcription events as the user and preserves partial', async () => {
    const connection = new MockLlmConnection([
      {inputTranscription: {text: 'user said'}, partial: true},
    ]);
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('user');
    expect(events[0].inputTranscription?.text).toBe('user said');
    expect(events[0].partial).toBe(true);
  });

  it('authors output transcription events as the agent', async () => {
    const connection = new MockLlmConnection([
      {outputTranscription: {text: 'model said'}, partial: false},
    ]);
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('live_agent');
    expect(events[0].outputTranscription?.text).toBe('model said');
  });

  it('surfaces a turn-complete event without ending the flow', async () => {
    const connection = new MockLlmConnection(
      [{turnComplete: true}, modelContentResponse('after turn')],
      {blockUntilClosed: true},
    );
    const queue = new LiveRequestQueue();
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent, {queue});

    const events: Event[] = [];
    for await (const event of agent.testRunLive(ctx)) {
      events.push(event);
      // The flow must still be alive after turn-complete; it only ends once the
      // queue closes.
      if (events.length === 2) {
        queue.close();
      }
    }

    expect(events).toHaveLength(2);
    expect(events[0].turnComplete).toBe(true);
    expect(events[1].content?.parts?.[0].text).toBe('after turn');
  });

  it('drains the request queue to the connection', async () => {
    const connection = new MockLlmConnection([], {blockUntilClosed: true});
    const queue = new LiveRequestQueue();
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent, {queue});

    const content: Content = {role: 'user', parts: [{text: 'turn'}]};
    const blob: Blob = {mimeType: 'audio/pcm', data: 'AAAA'};
    queue.sendContent(content);
    queue.sendRealtime(blob);
    queue.sendActivityStart();
    queue.sendActivityEnd();
    queue.close();

    await collect(agent.testRunLive(ctx));

    expect(connection.sentContents).toEqual([content]);
    expect(connection.sentRealtimeBlobs).toEqual([blob]);
    expect(connection.activityStartCount).toBe(1);
    expect(connection.activityEndCount).toBe(1);
    expect(connection.closeCount).toBe(1);
  });

  it('rejects when a queued user content contains a function call', async () => {
    const connection = new MockLlmConnection([], {blockUntilClosed: true});
    const queue = new LiveRequestQueue();
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent, {queue});

    queue.send({
      content: {role: 'user', parts: [{functionCall: {name: 'foo', args: {}}}]},
    });

    await expect(collect(agent.testRunLive(ctx))).rejects.toThrow(
      'User message cannot contain function calls.',
    );
  });

  it('executes tools and echoes function responses back to the queue', async () => {
    const echoTool = new FunctionTool({
      name: 'echo',
      description: 'Echoes the provided value.',
      parameters: {
        type: Type.OBJECT,
        properties: {value: {type: Type.STRING}},
      },
      execute: async (args) => ({echoed: (args as {value?: string}).value}),
    });
    const connection = new MockLlmConnection([
      {
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'echo', args: {value: 'x'}, id: 'fc1'}},
          ],
        },
      },
    ]);
    const queue = new LiveRequestQueue();
    const sendContentSpy = vi.spyOn(queue, 'sendContent');
    const agent = createAgent(new MockLiveLlm([connection]), {
      tools: [echoTool],
    });
    const ctx = createLiveContext(agent, {queue});

    const events = await collect(agent.testRunLive(ctx));

    const callEvent = events.find((event) =>
      event.content?.parts?.some((part) => part.functionCall),
    );
    const responseEvent = events.find((event) =>
      event.content?.parts?.some((part) => part.functionResponse),
    );
    expect(callEvent).toBeDefined();
    expect(responseEvent).toBeDefined();
    expect(responseEvent!.content?.parts?.[0].functionResponse?.name).toBe(
      'echo',
    );
    // The function response is echoed back so the live model receives it.
    expect(sendContentSpy).toHaveBeenCalledWith(responseEvent!.content);
  });

  it('renders a set_model_response function call as structured output', async () => {
    const args = {answer: 42};
    const connection = new MockLlmConnection([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'set_model_response', args}}],
        },
      },
    ]);
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].text).toBe(JSON.stringify(args));
    expect(events[0].actions.skipSummarization).toBe(true);
  });

  it('skips empty responses but keeps processing later events', async () => {
    const connection = new MockLlmConnection([
      {},
      modelContentResponse('real content'),
    ]);
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].text).toBe('real content');
  });

  it('records the session resumption handle and yields a resumption event', async () => {
    const connection = new MockLlmConnection([
      {liveSessionResumptionUpdate: {newHandle: 'handle-1'}},
    ]);
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(ctx.liveSessionResumptionHandle).toBe('handle-1');
    expect(events).toHaveLength(1);
    expect(events[0].liveSessionResumptionUpdate?.newHandle).toBe('handle-1');
  });

  it('reconnects with the saved handle on a server go-away', async () => {
    const content: Content = {role: 'user', parts: [{text: 'seed'}]};
    const firstConnection = new MockLlmConnection([
      {liveSessionResumptionUpdate: {newHandle: 'handle-1'}},
      {goAway: {}},
    ]);
    const secondConnection = new MockLlmConnection(
      [modelContentResponse('resumed')],
      {blockUntilClosed: true},
    );
    const model = new MockLiveLlm([firstConnection, secondConnection]);
    const queue = new LiveRequestQueue();
    const agent = createAgent(model, {
      requestProcessors: [new HistoryRequestProcessor([content])],
    });
    const ctx = createLiveContext(agent, {queue});

    const events: Event[] = [];
    for await (const event of agent.testRunLive(ctx)) {
      events.push(event);
      if (event.content?.parts?.[0].text === 'resumed') {
        queue.close();
      }
    }

    expect(model.connectCount).toBe(2);
    expect(model.connectHandles).toEqual([undefined, 'handle-1']);
    expect(firstConnection.sentHistory).toHaveLength(1);
    // History is not resent on the resumed reconnect.
    expect(secondConnection.sentHistory).toHaveLength(0);
    expect(
      events.some((event) => event.content?.parts?.[0].text === 'resumed'),
    ).toBe(true);
  });

  it('bounds reconnect attempts when connect keeps failing', async () => {
    const connectError = new Error('connect failed');
    const model = new MockLiveLlm([], connectError);
    const agent = createAgent(model);
    const ctx = createLiveContext(agent, {handle: 'handle-0'});

    await expect(collect(agent.testRunLive(ctx))).rejects.toThrow(
      'connect failed',
    );
    // Initial attempt plus MAX reconnect attempts.
    expect(model.connectCount).toBe(MAX_LIVE_RECONNECT_ATTEMPTS + 1);
  });

  it('recovers from a receive error when a handle is present', async () => {
    const firstConnection = new MockLlmConnection([], {
      receiveError: new Error('dropped'),
    });
    const secondConnection = new MockLlmConnection(
      [modelContentResponse('recovered')],
      {blockUntilClosed: true},
    );
    const model = new MockLiveLlm([firstConnection, secondConnection]);
    const queue = new LiveRequestQueue();
    const agent = createAgent(model);
    const ctx = createLiveContext(agent, {queue, handle: 'handle-0'});

    const events: Event[] = [];
    for await (const event of agent.testRunLive(ctx)) {
      events.push(event);
      if (event.content?.parts?.[0].text === 'recovered') {
        queue.close();
      }
    }

    expect(model.connectCount).toBe(2);
    expect(events.some((e) => e.content?.parts?.[0].text === 'recovered')).toBe(
      true,
    );
  });

  it('rethrows a receive error immediately when no handle is present', async () => {
    const connection = new MockLlmConnection([], {
      receiveError: new Error('dropped'),
    });
    const model = new MockLiveLlm([connection]);
    const agent = createAgent(model);
    const ctx = createLiveContext(agent);

    await expect(collect(agent.testRunLive(ctx))).rejects.toThrow('dropped');
    expect(model.connectCount).toBe(1);
  });

  it('throws when the live request queue is missing', async () => {
    const connection = new MockLlmConnection();
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent, {withoutQueue: true});

    await expect(collect(agent.testRunLive(ctx))).rejects.toThrow(
      'runLiveFlow requires invocationContext.liveRequestQueue to be set.',
    );
  });

  it('surfaces events emitted by response processors', async () => {
    const connection = new MockLlmConnection([
      modelContentResponse('model text'),
    ]);
    const agent = createAgent(new MockLiveLlm([connection]), {
      responseProcessors: [new EchoResponseProcessor()],
    });
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(
      events.some((e) => e.content?.parts?.[0].text === 'from-processor'),
    ).toBe(true);
    expect(
      events.some((e) => e.content?.parts?.[0].text === 'model text'),
    ).toBe(true);
  });

  it('closes the connection once on normal completion', async () => {
    const connection = new MockLlmConnection([modelContentResponse('done')]);
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent);

    await collect(agent.testRunLive(ctx));

    expect(connection.closeCount).toBe(1);
  });

  it('closes the connection once when the flow errors', async () => {
    const connection = new MockLlmConnection([], {
      receiveError: new Error('dropped'),
    });
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent);

    await expect(collect(agent.testRunLive(ctx))).rejects.toThrow('dropped');
    expect(connection.closeCount).toBe(1);
  });

  it('returns before connecting when preprocessing ends the invocation', async () => {
    const connection = new MockLlmConnection();
    const model = new MockLiveLlm([connection]);
    const agent = createAgent(model, {
      requestProcessors: [new EndInvocationProcessor()],
    });
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(events).toHaveLength(0);
    expect(model.connectCount).toBe(0);
  });

  it('does not emit a function response event when the tool is deferred', async () => {
    const longRunningTool = new FunctionTool({
      name: 'defer',
      description: 'A long-running tool that defers its response.',
      isLongRunning: true,
      execute: async () => undefined,
    });
    const connection = new MockLlmConnection([
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'defer', args: {}, id: 'fc-defer'}}],
        },
      },
    ]);
    const agent = createAgent(new MockLiveLlm([connection]), {
      tools: [longRunningTool],
    });
    const ctx = createLiveContext(agent);

    const events = await collect(agent.testRunLive(ctx));

    expect(
      events.some((event) =>
        event.content?.parts?.some((part) => part.functionCall),
      ),
    ).toBe(true);
    expect(
      events.some((event) =>
        event.content?.parts?.some((part) => part.functionResponse),
      ),
    ).toBe(false);
  });

  it('stops yielding when the abort signal fires mid-receive', async () => {
    const controller = new AbortController();
    const connection = new MockLlmConnection(
      [modelContentResponse('first'), modelContentResponse('second')],
      {blockUntilClosed: true},
    );
    const agent = createAgent(new MockLiveLlm([connection]));
    const ctx = createLiveContext(agent, {abortSignal: controller.signal});

    const events: Event[] = [];
    for await (const event of agent.testRunLive(ctx)) {
      events.push(event);
      controller.abort();
    }

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].text).toBe('first');
  });
});
