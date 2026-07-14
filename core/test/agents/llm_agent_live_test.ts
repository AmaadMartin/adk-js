/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Blob, Content, LiveServerMessage} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

interface TestableAgent extends LlmAgent {
  runLiveFlow(context: InvocationContext): AsyncGenerator<Event, void, void>;
  postprocessLiveAsync(
    context: InvocationContext,
    request: LlmRequest,
    response: LlmResponse,
    event: Event,
  ): AsyncGenerator<Event, void, void>;
  pluginManager: unknown;
}

class MockLlmConnection implements BaseLlmConnection {
  sentHistory: Content[][] = [];
  sentContents: Content[] = [];
  sentRealtime: Blob[] = [];
  activityStartCalled = 0;
  activityEndCalled = 0;
  closed = false;

  responsesToYield: (LlmResponse | Error)[] = [];
  onCloseCallback?: () => void;

  async sendHistory(history: Content[]): Promise<void> {
    this.sentHistory.push(history);
  }

  async sendContent(content: Content): Promise<void> {
    this.sentContents.push(content);
  }

  async sendRealtime(blob: Blob): Promise<void> {
    this.sentRealtime.push(blob);
  }

  async sendActivityStart(): Promise<void> {
    this.activityStartCalled++;
  }

  async sendActivityEnd(): Promise<void> {
    this.activityEndCalled++;
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for (const item of this.responsesToYield) {
      if (item instanceof Error) {
        throw item;
      }
      yield item;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.onCloseCallback) {
      this.onCloseCallback();
    }
  }
}

class MockLlm extends BaseLlm {
  connections: MockLlmConnection[] = [];
  connectRequests: LlmRequest[] = [];

  constructor() {
    super({model: 'gemini-2.5-flash'});
  }

  async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.connectRequests.push(llmRequest);
    const conn = new MockLlmConnection();
    this.connections.push(conn);
    return conn;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: 'Fallback'}]}};
  }
}

describe('LlmAgent.runLiveFlow', () => {
  let sessionService: InMemorySessionService;
  let liveRequestQueue: LiveRequestQueue;
  let mockLlm: MockLlm;
  let agent: LlmAgent;
  let invocationContext: InvocationContext;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    liveRequestQueue = new LiveRequestQueue();
    mockLlm = new MockLlm();
    agent = new LlmAgent({
      name: 'live_test_agent',
      model: mockLlm,
    });

    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user1',
    });

    const testAgent = agent as unknown as TestableAgent;
    invocationContext = new InvocationContext({
      invocationId: 'inv_live_1',
      agent,
      session,
      sessionService,
      liveRequestQueue,
      runConfig: {},
      pluginManager: (testAgent.pluginManager || {
        runBeforeModelCallback: async () => undefined,
        runAfterModelCallback: async () => undefined,
      }) as InvocationContext['pluginManager'],
    });
  });

  it('drains liveRequestQueue and dispatches sendContent, sendRealtime, sendActivityStart, and sendActivityEnd to connection', async () => {
    mockLlm.connect = async (req: LlmRequest) => {
      mockLlm.connectRequests.push(req);
      const conn = new MockLlmConnection();
      conn.responsesToYield = [
        {content: {role: 'model', parts: [{text: 'Hello response'}]}},
      ];
      mockLlm.connections.push(conn);
      return conn;
    };

    const runPromise = (async () => {
      const events: Event[] = [];
      const testAgent = agent as unknown as TestableAgent;
      for await (const event of testAgent.runLiveFlow(invocationContext)) {
        events.push(event);
      }
      return events;
    })();

    // Push requests to queue
    liveRequestQueue.sendContent({role: 'user', parts: [{text: 'Hi model'}]});
    liveRequestQueue.sendRealtime({data: 'audio_bytes', mimeType: 'audio/pcm'});
    liveRequestQueue.sendActivityStart();
    liveRequestQueue.sendActivityEnd();
    liveRequestQueue.close();

    const yieldedEvents = await runPromise;
    expect(yieldedEvents.length).toBeGreaterThanOrEqual(1);
    expect(yieldedEvents[0].content?.parts?.[0].text).toBe('Hello response');

    const conn = mockLlm.connections[0];
    expect(conn.sentContents.length).toBe(1);
    expect(conn.sentContents[0].parts?.[0].text).toBe('Hi model');
    expect(conn.sentRealtime.length).toBe(1);
    expect(conn.activityStartCalled).toBe(1);
    expect(conn.activityEndCalled).toBe(1);
  });

  it('handles liveSessionResumptionUpdate and reconnects on goAway signal', async () => {
    let callCount = 0;
    mockLlm.connect = async (req: LlmRequest) => {
      mockLlm.connectRequests.push(req);
      const conn = new MockLlmConnection();
      callCount++;
      if (callCount === 1) {
        conn.responsesToYield = [
          {
            liveSessionResumptionUpdate: {
              newHandle: 'handle_abc_123',
            } as LiveServerMessage['sessionResumptionUpdate'],
          },
          {goAway: {} as LiveServerMessage['goAway']},
        ];
      } else {
        conn.responsesToYield = [
          {content: {role: 'model', parts: [{text: 'Reconnected response'}]}},
        ];
      }
      mockLlm.connections.push(conn);
      return conn;
    };

    const runPromise = (async () => {
      const events: Event[] = [];
      const testAgent = agent as unknown as TestableAgent;
      for await (const event of testAgent.runLiveFlow(invocationContext)) {
        events.push(event);
      }
      return events;
    })();

    liveRequestQueue.close();
    const yieldedEvents = await runPromise;

    expect(callCount).toBe(2);
    expect(invocationContext.liveSessionResumptionHandle).toBe(
      'handle_abc_123',
    );
    expect(
      mockLlm.connectRequests[1].liveConnectConfig?.sessionResumption?.handle,
    ).toBe('handle_abc_123');
    expect(
      yieldedEvents.some(
        (e) => e.content?.parts?.[0].text === 'Reconnected response',
      ),
    ).toBe(true);
  });

  it('reconnects when connection drops cleanly or with API error code 1000/1006/1011 if resumption handle exists', async () => {
    invocationContext.liveSessionResumptionHandle = 'existing_handle_xyz';
    let callCount = 0;

    mockLlm.connect = async (req: LlmRequest) => {
      mockLlm.connectRequests.push(req);
      const conn = new MockLlmConnection();
      callCount++;
      if (callCount === 1) {
        const error = new Error('Connection lost code 1006');
        Object.assign(error, {code: 1006});
        conn.responsesToYield = [error];
      } else {
        conn.responsesToYield = [
          {content: {role: 'model', parts: [{text: 'Recovered after drop'}]}},
        ];
      }
      mockLlm.connections.push(conn);
      return conn;
    };

    liveRequestQueue.close();
    const events: Event[] = [];
    const testAgent = agent as unknown as TestableAgent;
    for await (const event of testAgent.runLiveFlow(invocationContext)) {
      events.push(event);
    }

    expect(callCount).toBe(2);
    expect(
      events.some((e) => e.content?.parts?.[0].text === 'Recovered after drop'),
    ).toBe(true);
  });

  it('sets initialHistoryInClientContent when history is present and no resumption handle exists', async () => {
    mockLlm.connect = async (req: LlmRequest) => {
      mockLlm.connectRequests.push(req);
      const conn = new MockLlmConnection();
      mockLlm.connections.push(conn);
      return conn;
    };

    invocationContext.session.events.push(
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'Old history'}]},
      }),
    );

    liveRequestQueue.close();
    const testAgent = agent as unknown as TestableAgent;
    for await (const _ of testAgent.runLiveFlow(invocationContext)) {
      // drain
    }

    const req = mockLlm.connectRequests[0];
    const liveCfg = req.liveConnectConfig as Record<string, unknown>;
    const histCfg = liveCfg?.historyConfig as Record<string, unknown>;
    expect(histCfg?.initialHistoryInClientContent).toBe(true);
    expect(mockLlm.connections[0].sentHistory.length).toBe(1);
  });

  it('handles transferToAgent by closing connection, clearing resumption handle in child context, and running child agent', async () => {
    const subAgent = new LlmAgent({name: 'target_sub_agent', model: mockLlm});
    let childContextCaptured: InvocationContext | undefined;

    subAgent.runLive = async function* (childCtx: InvocationContext) {
      childContextCaptured = childCtx;
      yield createEvent({
        author: 'target_sub_agent',
        content: {role: 'model', parts: [{text: 'Transferred response'}]},
      });
    };

    const multiAgent = new LlmAgent({
      name: 'parent_agent',
      model: mockLlm,
      subAgents: [subAgent],
    });

    invocationContext = new InvocationContext({
      invocationId: 'inv_multi_1',
      agent: multiAgent,
      session: invocationContext.session,
      sessionService,
      liveRequestQueue,
      liveSessionResumptionHandle: 'parent_handle_123',
      pluginManager: invocationContext.pluginManager,
    });

    mockLlm.connect = async (_req: LlmRequest) => {
      const conn = new MockLlmConnection();
      conn.responsesToYield = [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionResponse: {
                  name: 'transfer_to_agent',
                  response: {status: 'ok'},
                },
              },
            ],
          },
        } as unknown as LlmResponse,
      ];
      mockLlm.connections.push(conn);
      return conn;
    };

    const testMultiAgent = multiAgent as unknown as TestableAgent;
    const originalPostprocess =
      testMultiAgent.postprocessLiveAsync.bind(multiAgent);
    testMultiAgent.postprocessLiveAsync = async function* (
      ctx: InvocationContext,
      req: LlmRequest,
      resp: LlmResponse,
      event: Event,
    ) {
      if (
        resp.content?.parts?.[0]?.functionResponse?.name === 'transfer_to_agent'
      ) {
        event.actions.transferToAgent = 'target_sub_agent';
        yield event;
        return;
      }
      yield* originalPostprocess(ctx, req, resp, event);
    };

    liveRequestQueue.close();
    const events: Event[] = [];
    for await (const event of testMultiAgent.runLiveFlow(invocationContext)) {
      events.push(event);
    }

    expect(mockLlm.connections[0].closed).toBe(true);
    expect(childContextCaptured).toBeDefined();
    expect(childContextCaptured?.liveSessionResumptionHandle).toBeUndefined();
    expect(
      events.some((e) => e.content?.parts?.[0].text === 'Transferred response'),
    ).toBe(true);
  });
});
