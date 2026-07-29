/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  Event,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  MAX_LIVE_RECONNECT_ATTEMPTS,
  PluginManager,
  createSession,
} from '@google/adk';
import {Blob, Content, createUserContent} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {FunctionTool} from '../../src/tools/function_tool.js';

class MockLiveLlmConnection implements BaseLlmConnection {
  sendHistoryCalls: Content[][] = [];
  sendContentCalls: Content[] = [];
  sendRealtimeCalls: Blob[] = [];
  sendActivityStartCalls = 0;
  sendActivityEndCalls = 0;
  closeCalls = 0;
  isClosed = false;

  constructor(
    private readonly responses:
      | LlmResponse[]
      | (() => AsyncGenerator<LlmResponse, void, void>),
    private readonly onClose?: () => void,
  ) {}

  async sendHistory(history: Content[]): Promise<void> {
    this.sendHistoryCalls.push(history);
  }

  async sendContent(content: Content): Promise<void> {
    this.sendContentCalls.push(content);
  }

  async sendRealtime(blob: Blob): Promise<void> {
    this.sendRealtimeCalls.push(blob);
  }

  async sendActivityStart(): Promise<void> {
    this.sendActivityStartCalls++;
  }

  async sendActivityEnd(): Promise<void> {
    this.sendActivityEndCalls++;
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    if (typeof this.responses === 'function') {
      yield* this.responses();
    } else {
      for (const res of this.responses) {
        if (this.isClosed) {
          break;
        }
        yield res;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  async close(): Promise<void> {
    this.isClosed = true;
    this.closeCalls++;
    this.onClose?.();
  }
}

class MockLiveLlm extends BaseLlm {
  connectCalls: LlmRequest[] = [];
  connections: MockLiveLlmConnection[] = [];
  connectionIndex = 0;
  private readonly throwOnReconnect?: Error;

  constructor(connections: MockLiveLlmConnection[], throwOnReconnect?: Error) {
    super({model: 'mock-live-llm'});
    this.connections = connections;
    this.throwOnReconnect = throwOnReconnect;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    // No-op for non-live generator in live tests
  }

  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.connectCalls.push(JSON.parse(JSON.stringify(llmRequest)));
    if (
      this.throwOnReconnect &&
      llmRequest.liveConnectConfig?.sessionResumption?.handle
    ) {
      throw this.throwOnReconnect;
    }
    if (this.connectionIndex >= this.connections.length) {
      throw new Error('No more mock connections available in MockLiveLlm.');
    }
    const conn = this.connections[this.connectionIndex++];
    return conn;
  }
}

describe('LlmAgent runLiveFlow', () => {
  function createTestContext(
    agent: BaseAgent,
    liveRequestQueue = new LiveRequestQueue(),
  ): InvocationContext {
    const session = createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
    });

    const pluginManager = new PluginManager();

    return new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session,
      pluginManager,
      liveRequestQueue,
    });
  }

  it('should verify normal bidirectional streaming turns: sendHistory and receive responses', async () => {
    const conn = new MockLiveLlmConnection([
      {
        content: {role: 'model', parts: [{text: 'Hello world'}]},
      },
      {
        inputTranscription: {text: 'user speech', finished: true},
      },
      {
        outputTranscription: {text: 'model speech', finished: true},
      },
    ]);
    const llm = new MockLiveLlm([conn]);
    const agent = new LlmAgent({name: 'live_agent', model: llm});

    const context = createTestContext(agent);

    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
    }

    expect(llm.connectCalls.length).toBe(1);
    expect(events.length).toBe(3);
    expect(events[0].content?.parts?.[0].text).toBe('Hello world');
    expect(events[1].author).toBe('user');
    expect(events[1].inputTranscription?.text).toBe('user speech');
    expect(events[2].outputTranscription?.text).toBe('model speech');
    // The connection must be released once the server stream ends.
    expect(conn.closeCalls).toBe(1);
  });

  it('should throw when the invocation has no live request queue', async () => {
    const conn = new MockLiveLlmConnection([]);
    const llm = new MockLiveLlm([conn]);
    const agent = new LlmAgent({name: 'live_agent', model: llm});

    const context = new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    });

    await expect(async () => {
      for await (const _event of agent.runLive(context)) {
        // Should never yield.
      }
    }).rejects.toThrow('requires invocationContext.liveRequestQueue');
    expect(llm.connectCalls.length).toBe(0);
  });

  it('should verify parallel queue draining: forwarding content, blob, activity boundaries and close', async () => {
    const conn = new MockLiveLlmConnection(async function* () {
      while (!conn.isClosed) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The connection produces no server messages; delegating to an empty
      // iterable yields nothing while still being a yield expression.
      yield* [];
    });
    const llm = new MockLiveLlm([conn]);
    const agent = new LlmAgent({name: 'live_agent', model: llm});

    const queue = new LiveRequestQueue();
    const context = createTestContext(agent, queue);

    const toolStream = new LiveRequestQueue();
    const toolStreamSend = vi.spyOn(toolStream, 'send');
    context.activeStreamingTools = {
      tool1: new ActiveStreamingTool({stream: toolStream}),
    };

    const runPromise = (async () => {
      for await (const _event of agent.runLive(context)) {
        // Drain events
      }
    })();

    queue.sendContent(createUserContent('Hello queue'));
    queue.sendRealtime({mimeType: 'audio/pcm', data: '1234'});
    queue.sendActivityStart();
    queue.sendActivityEnd();
    queue.close();

    await runPromise;

    expect(conn.sendContentCalls.length).toBe(1);
    expect(conn.sendContentCalls[0].parts?.[0].text).toBe('Hello queue');
    expect(conn.sendRealtimeCalls.length).toBe(1);
    expect(conn.sendRealtimeCalls[0].data).toBe('1234');
    expect(conn.sendActivityStartCalls).toBe(1);
    expect(conn.sendActivityEndCalls).toBe(1);
    expect(conn.closeCalls).toBe(1);
    expect(toolStreamSend).toHaveBeenCalled();
  });

  it('should verify reconnection logic on goAway when resumption handle is present and skip sendHistory on retries', async () => {
    const conn1 = new MockLiveLlmConnection([
      {
        liveSessionResumptionUpdate: {newHandle: 'resumption-handle-abc'},
      },
      {
        goAway: {},
      },
    ]);
    const conn2 = new MockLiveLlmConnection([
      {
        content: {role: 'model', parts: [{text: 'Resumed response'}]},
      },
    ]);
    const llm = new MockLiveLlm([conn1, conn2]);
    const agent = new LlmAgent({name: 'live_agent', model: llm});

    agent.requestProcessors.push({
      runAsync: async function* (_ctx, req) {
        req.contents.push(createUserContent('initial history'));
        // The processor only mutates the request and emits no events.
        yield* [];
      },
    });

    const context = createTestContext(agent);

    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
    }

    expect(llm.connectCalls.length).toBe(2);
    // The dropped connection must not be left open across the reconnect.
    expect(conn1.closeCalls).toBe(1);
    expect(conn1.sendHistoryCalls.length).toBe(1);
    expect(conn1.sendHistoryCalls[0][0].parts?.[0].text).toBe(
      'initial history',
    );
    expect(conn2.sendHistoryCalls.length).toBe(0);
    expect(
      llm.connectCalls[1].liveConnectConfig.sessionResumption?.handle,
    ).toBe('resumption-handle-abc');
    expect(
      events.some((e) => e.content?.parts?.[0].text === 'Resumed response'),
    ).toBe(true);
  });

  it('should verify connection drop exception retries when resumption handle is present', async () => {
    const conn1 = new MockLiveLlmConnection(async function* () {
      yield {liveSessionResumptionUpdate: {newHandle: 'handle-xyz'}};
      throw new Error('WebSocket connection lost');
    });
    const conn2 = new MockLiveLlmConnection([
      {
        content: {role: 'model', parts: [{text: 'Recovered after drop'}]},
      },
    ]);
    const llm = new MockLiveLlm([conn1, conn2]);
    const agent = new LlmAgent({name: 'live_agent', model: llm});

    const context = createTestContext(agent);

    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
    }

    expect(llm.connectCalls.length).toBe(2);
    expect(
      llm.connectCalls[1].liveConnectConfig.sessionResumption?.handle,
    ).toBe('handle-xyz');
    expect(
      events.some((e) => e.content?.parts?.[0].text === 'Recovered after drop'),
    ).toBe(true);
  });

  it('should throw error when reconnection attempts exceed MAX_LIVE_RECONNECT_ATTEMPTS', async () => {
    const conn1 = new MockLiveLlmConnection(async function* () {
      yield {liveSessionResumptionUpdate: {newHandle: 'handle-loop'}};
      throw new Error('Persistent drop');
    });
    const llm = new MockLiveLlm(
      [conn1],
      new Error('Server unavailable during reconnect'),
    );
    const agent = new LlmAgent({name: 'live_agent', model: llm});

    const context = createTestContext(agent);

    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
    }

    expect(llm.connectCalls.length).toBe(MAX_LIVE_RECONNECT_ATTEMPTS + 1);
    expect(
      events.some((e) =>
        e.errorMessage?.includes('Server unavailable during reconnect'),
      ),
    ).toBe(true);
  });

  it('should not retry agent-side failures even when a resumption handle is present', async () => {
    const conn = new MockLiveLlmConnection([
      {liveSessionResumptionUpdate: {newHandle: 'handle-present'}},
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'transfer_to_agent',
                args: {agentName: 'ghost_agent'},
              },
            },
          ],
        },
      },
    ]);
    const llm = new MockLiveLlm([conn]);
    const subAgent = new LlmAgent({name: 'sub_agent', model: llm});
    const agent = new LlmAgent({
      name: 'live_agent',
      model: llm,
      subAgents: [subAgent],
    });

    const context = createTestContext(agent);

    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
    }

    // A transfer to an unknown agent is a deterministic bug, not a dropped
    // connection: it must surface on the first throw rather than burn the
    // reconnect budget.
    expect(llm.connectCalls.length).toBe(1);
    expect(events.some((e) => e.errorMessage?.includes('ghost_agent'))).toBe(
      true,
    );
  });

  it('should verify tool execution and sending function response back to queue in live mode', async () => {
    const conn = new MockLiveLlmConnection(async function* () {
      yield {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'test_tool',
                args: {query: 'hello'},
              },
            },
          ],
        },
      };
      while (conn.sendContentCalls.length === 0 && !conn.isClosed) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    const llm = new MockLiveLlm([conn]);

    const tool = new FunctionTool({
      name: 'test_tool',
      description: 'A test tool',
      parameters: z.object({query: z.string()}),
      execute: async (args) => `Result for ${args.query}`,
    });

    const agent = new LlmAgent({name: 'live_agent', model: llm, tools: [tool]});
    const context = createTestContext(agent);

    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
    }

    expect(conn.sendContentCalls.length).toBe(1);
    expect(conn.sendContentCalls[0].parts?.[0].functionResponse?.name).toBe(
      'test_tool',
    );
    expect(
      conn.sendContentCalls[0].parts?.[0].functionResponse?.response?.result,
    ).toBe('Result for hello');
  });

  it('should verify sub-agent transfer (transfer_to_agent) delegates to sub-agent runLive cleanly without duplicate function response processing', async () => {
    const parentConn = new MockLiveLlmConnection([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'transfer_to_agent',
                args: {agentName: 'sub_agent'},
              },
            },
          ],
        },
      },
    ]);
    const childConn = new MockLiveLlmConnection([
      {
        content: {role: 'model', parts: [{text: 'Hello from sub_agent'}]},
      },
    ]);
    const llm = new MockLiveLlm([parentConn, childConn]);

    const subAgent = new LlmAgent({name: 'sub_agent', model: llm});
    const parentAgent = new LlmAgent({
      name: 'parent_agent',
      model: llm,
      subAgents: [subAgent],
    });

    const context = createTestContext(parentAgent);

    const events: Event[] = [];
    for await (const event of parentAgent.runLive(context)) {
      events.push(event);
    }

    expect(parentConn.closeCalls).toBe(1);
    expect(
      events.some((e) => e.content?.parts?.[0].text === 'Hello from sub_agent'),
    ).toBe(true);
    expect(
      events.filter(
        (e) =>
          e.content?.parts?.[0].functionResponse?.name === 'transfer_to_agent',
      ).length,
    ).toBe(1);
  });

  it('should stop when task_completed function response is received', async () => {
    const conn = new MockLiveLlmConnection([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionResponse: {
                name: 'task_completed',
                response: {status: 'done'},
              },
            },
          ],
        },
      },
    ]);
    const llm = new MockLiveLlm([conn]);
    const agent = new LlmAgent({name: 'live_agent', model: llm});

    const context = createTestContext(agent);

    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0].content?.parts?.[0].functionResponse?.name).toBe(
      'task_completed',
    );
  });
});
