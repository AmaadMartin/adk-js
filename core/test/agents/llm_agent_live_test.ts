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
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Session,
} from '@google/adk';

import {Blob, Content, createUserContent} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';

class MockLlmConnection implements BaseLlmConnection {
  sentHistory: Content[][] = [];
  sentContents: Content[] = [];
  sentRealtimeBlobs: Blob[] = [];
  activityStarts = 0;
  activityEnds = 0;
  closed = false;

  constructor(private readonly responses: LlmResponse[] = []) {}

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
    this.activityStarts++;
  }

  async sendActivityEnd(): Promise<void> {
    this.activityEnds++;
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    while (!this.closed && this.responses.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    while (this.responses.length > 0) {
      const res = this.responses.shift()!;
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield res;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class MockLlm extends BaseLlm {
  connections: MockLlmConnection[] = [];
  connectCalls: LlmRequest[] = [];
  connectError?: Error;

  constructor(
    modelName: string,
    private readonly responsesToYield: LlmResponse[][] = [],
  ) {
    super({model: modelName});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {}

  async connect(request: LlmRequest): Promise<BaseLlmConnection> {
    if (this.connectError) {
      throw this.connectError;
    }
    this.connectCalls.push(request);
    const resps = this.responsesToYield.shift() || [];
    const conn = new MockLlmConnection(resps);
    this.connections.push(conn);
    return conn;
  }
}

describe('LlmAgent Live Mode (runLiveFlow & canonicalLiveModel)', () => {
  let session: Session;
  let liveRequestQueue: LiveRequestQueue;
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    process.env.GEMINI_API_KEY = 'test_api_key_for_unit_tests';
    sessionService = new InMemorySessionService();
    session = await sessionService.createSession({
      appName: 'testApp',
      userId: 'testUser',
      sessionId: 'session_live_1',
    });
    liveRequestQueue = new LiveRequestQueue();
  });

  describe('canonicalLiveModel and setDefaultLiveModel', () => {
    it('should resolve canonicalLiveModel from instance model', () => {
      const mockLlm = new MockLlm('custom-live-model');
      const agent = new LlmAgent({name: 'testAgent', model: mockLlm});
      expect(agent.canonicalLiveModel).toBe(mockLlm);
    });

    it('should resolve canonicalLiveModel from ancestor model if instance has no model', () => {
      const mockLlm = new MockLlm('parent-live-model');
      const parentAgent = new LlmAgent({name: 'parent', model: mockLlm});
      const childAgent = new LlmAgent({name: 'child'});
      parentAgent.subAgents = [childAgent];
      childAgent.parentAgent = parentAgent;

      expect(childAgent.canonicalLiveModel).toBe(mockLlm);
    });

    it('should resolve default live model when neither instance nor ancestor has a model', () => {
      const agent = new LlmAgent({name: 'noModelAgent'});
      const defaultModel = agent.canonicalLiveModel;
      expect(defaultModel.model).toBe('gemini-live-2.5-flash-native-audio');
    });

    it('should allow overriding default live model via setDefaultLiveModel', () => {
      const customDefault = new MockLlm('overridden-default-model');
      LlmAgent.setDefaultLiveModel(customDefault);
      try {
        const agent = new LlmAgent({name: 'testAgent'});
        expect(agent.canonicalLiveModel).toBe(customDefault);
      } finally {
        LlmAgent.setDefaultLiveModel('gemini-live-2.5-flash-native-audio');
      }
    });

    it('should throw when setting invalid default live model', () => {
      expect(() => LlmAgent.setDefaultLiveModel('')).toThrow(
        'Default live model must be a non-empty string.',
      );
      expect(() =>
        LlmAgent.setDefaultLiveModel(123 as unknown as string),
      ).toThrow('Default live model must be a model name or BaseLlm.');
    });
  });

  describe('runLiveFlow execution', () => {
    it('should establish connection, send history, and yield model events', async () => {
      const responses: LlmResponse[] = [
        {content: {role: 'model', parts: [{text: 'Hello from live model'}]}},
      ];
      const mockLlm = new MockLlm('test-live-llm', [responses]);
      const agent = new LlmAgent({name: 'liveAgent', model: mockLlm});

      const ctx = new InvocationContext({
        session,
        sessionService,
        agent,
        liveRequestQueue,
        pluginManager: new PluginManager(),
      });

      // Add existing user history so sendHistory is called
      const historyEvent = createEvent({
        author: 'user',
        content: createUserContent('Hi there'),
      });
      session.events.push(historyEvent);

      const yieldedEvents: Event[] = [];
      for await (const event of agent.runLive(ctx)) {
        yieldedEvents.push(event);
      }

      expect(mockLlm.connectCalls.length).toBe(1);
      expect(mockLlm.connections[0].sentHistory.length).toBe(1);
      expect(mockLlm.connections[0].sentHistory[0]).toEqual([
        historyEvent.content,
      ]);
      expect(yieldedEvents.length).toBe(1);
      expect(yieldedEvents[0].content?.parts?.[0].text).toBe(
        'Hello from live model',
      );
    });

    it('should drain liveRequestQueue items to connection in background', async () => {
      const mockLlm = new MockLlm('test-live-llm', [[]]);
      const agent = new LlmAgent({name: 'queueDrainAgent', model: mockLlm});

      const ctx = new InvocationContext({
        session,
        sessionService,
        agent,
        liveRequestQueue,
        pluginManager: new PluginManager(),
      });

      // Queue items before/during run
      liveRequestQueue.sendContent(createUserContent('msg 1'));
      liveRequestQueue.sendRealtime({mimeType: 'audio/wav', data: '1234'});
      liveRequestQueue.sendActivityStart();
      liveRequestQueue.sendActivityEnd();
      liveRequestQueue.close();

      const yieldedEvents: Event[] = [];
      for await (const event of agent.runLive(ctx)) {
        yieldedEvents.push(event);
      }

      expect(mockLlm.connections.length).toBe(1);
      const conn = mockLlm.connections[0];
      expect(conn.sentContents.length).toBe(1);
      expect(conn.sentContents[0].parts?.[0].text).toBe('msg 1');
      expect(conn.sentRealtimeBlobs.length).toBe(1);
      expect(conn.sentRealtimeBlobs[0].data).toBe('1234');
      expect(conn.activityStarts).toBe(1);
      expect(conn.activityEnds).toBe(1);
      expect(conn.closed).toBe(true);
    });

    it('should execute tool calls during live mode and push function response back to server', async () => {
      const responses: LlmResponse[] = [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'get_weather',
                  args: {location: 'Tokyo'},
                  id: 'call_weather_100',
                },
              },
            ],
          },
        },
      ];
      const mockLlm = new MockLlm('test-live-llm', [responses]);

      const weatherTool = new FunctionTool({
        name: 'get_weather',
        description: 'Get weather',
        execute: async () => ({temperature: '25C'}),
      });

      const agent = new LlmAgent({
        name: 'weatherAgent',
        model: mockLlm,
        tools: [weatherTool],
      });

      const sendContentSpy = vi.spyOn(liveRequestQueue, 'sendContent');

      const ctx = new InvocationContext({
        session,
        sessionService,
        agent,
        liveRequestQueue,
        pluginManager: new PluginManager(),
      });

      const yieldedEvents: Event[] = [];
      for await (const event of agent.runLive(ctx)) {
        yieldedEvents.push(event);
      }

      // First yielded event is the function call from model, second is function response event
      expect(yieldedEvents.length).toBe(2);
      expect(yieldedEvents[0].content?.parts?.[0].functionCall?.name).toBe(
        'get_weather',
      );
      expect(yieldedEvents[1].content?.parts?.[0].functionResponse?.name).toBe(
        'get_weather',
      );

      // Verify that sendContent was called on liveRequestQueue with the function response content
      expect(sendContentSpy).toHaveBeenCalledWith(yieldedEvents[1].content);
    });

    it('should cleanly transfer to subAgent on transfer_to_agent tool response', async () => {
      const parentResponses: LlmResponse[] = [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionResponse: {
                  name: 'transfer_to_agent',
                  response: {status: 'transferring'},
                  id: 'call_transfer_1',
                },
              },
            ],
          },
          actions: {transferToAgent: 'childAgent'},
        },
      ];
      const childResponses: LlmResponse[] = [
        {
          content: {
            role: 'model',
            parts: [{text: 'Hello from child live agent'}],
          },
        },
      ];

      const parentLlm = new MockLlm('parent-llm', [parentResponses]);
      const childLlm = new MockLlm('child-llm', [childResponses]);

      const parentAgent = new LlmAgent({name: 'parentAgent', model: parentLlm});
      const childAgent = new LlmAgent({name: 'childAgent', model: childLlm});
      parentAgent.subAgents = [childAgent];
      childAgent.parentAgent = parentAgent;

      const ctx = new InvocationContext({
        session,
        sessionService,
        agent: parentAgent,
        liveRequestQueue,
        pluginManager: new PluginManager(),
      });

      const yieldedEvents: Event[] = [];
      for await (const event of parentAgent.runLive(ctx)) {
        yieldedEvents.push(event);
      }

      expect(parentLlm.connections.length).toBe(1);
      expect(parentLlm.connections[0].closed).toBe(true); // Parent connection closed
      expect(childLlm.connections.length).toBe(1); // Child connection opened
      expect(yieldedEvents.length).toBe(2);
      expect(yieldedEvents[0].content?.parts?.[0].functionResponse?.name).toBe(
        'transfer_to_agent',
      );
      expect(yieldedEvents[1].content?.parts?.[0].text).toBe(
        'Hello from child live agent',
      );
    });

    it('should close connection and stop flow on task_completed tool response', async () => {
      const responses: LlmResponse[] = [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionResponse: {
                  name: 'task_completed',
                  response: {status: 'done'},
                  id: 'call_completed_1',
                },
              },
            ],
          },
        },
      ];
      const mockLlm = new MockLlm('test-live-llm', [responses]);
      const agent = new LlmAgent({name: 'completedAgent', model: mockLlm});

      const ctx = new InvocationContext({
        session,
        sessionService,
        agent,
        liveRequestQueue,
        pluginManager: new PluginManager(),
      });

      const yieldedEvents: Event[] = [];
      for await (const event of agent.runLive(ctx)) {
        yieldedEvents.push(event);
      }

      expect(mockLlm.connections.length).toBe(1);
      expect(mockLlm.connections[0].closed).toBe(true);
      expect(yieldedEvents.length).toBe(1);
    });

    it('should reconnect transparently using session resumption handle on connection close/loss', async () => {
      const firstConnResponses: LlmResponse[] = [
        {
          liveSessionResumptionUpdate: {newHandle: 'handle_abc_123'},
        },
        // Yielding goAway sentinel triggers reconnect check
        {
          goAway: {},
        },
      ];
      const secondConnResponses: LlmResponse[] = [
        {
          content: {role: 'model', parts: [{text: 'Reconnected response'}]},
        },
      ];

      const mockLlm = new MockLlm('test-live-llm', [
        firstConnResponses,
        secondConnResponses,
      ]);
      const agent = new LlmAgent({name: 'reconnectAgent', model: mockLlm});

      const ctx = new InvocationContext({
        session,
        sessionService,
        agent,
        liveRequestQueue,
        pluginManager: new PluginManager(),
      });

      // Add user history
      session.events.push(
        createEvent({author: 'user', content: createUserContent('initial')}),
      );

      const yieldedEvents: Event[] = [];
      for await (const event of agent.runLive(ctx)) {
        yieldedEvents.push(event);
      }

      expect(mockLlm.connectCalls.length).toBe(2);
      expect(
        mockLlm.connectCalls[1].liveConnectConfig.sessionResumption?.handle,
      ).toBe('handle_abc_123');
      // History should only be sent on first attempt when not resuming
      expect(mockLlm.connections[0].sentHistory.length).toBe(1);
      expect(mockLlm.connections[1].sentHistory.length).toBe(0);
      expect(
        yieldedEvents.some(
          (e) => e.content?.parts?.[0].text === 'Reconnected response',
        ),
      ).toBe(true);
    });
  });
});
