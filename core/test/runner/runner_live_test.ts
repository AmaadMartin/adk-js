/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InvocationContext,
  LiveRequestQueue,
  Runner,
} from '@google/adk';

import {Content, createUserContent, Modality} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';

class MockLiveAgent extends BaseAgent {
  eventsToYield: Event[] = [];
  lastReceivedContext?: InvocationContext;

  constructor(name: string, events: Event[] = []) {
    super({name});
    this.eventsToYield = events;
  }

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.lastReceivedContext = invocationContext;
    for (const event of this.eventsToYield) {
      yield event;
    }
  }
}

class MockPlugin extends BasePlugin {
  beforeRunResponse?: Content;
  onEventMutator?: (event: Event) => Event | undefined;
  afterRunCalled = false;

  constructor(name: string) {
    super(name);
  }

  override async beforeRunCallback(
    _params: Parameters<BasePlugin['beforeRunCallback']>[0],
  ): Promise<Content | undefined> {
    return this.beforeRunResponse;
  }

  override async afterRunCallback(
    _params: Parameters<BasePlugin['afterRunCallback']>[0],
  ): Promise<void> {
    this.afterRunCalled = true;
  }

  override async onEventCallback(
    params: Parameters<BasePlugin['onEventCallback']>[0],
  ): Promise<Event | undefined> {
    if (this.onEventMutator) {
      return this.onEventMutator(params.event);
    }
    return undefined;
  }
}

describe('Runner.runLive and Event Persistence Rules', () => {
  let sessionService: InMemorySessionService;
  let liveRequestQueue: LiveRequestQueue;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    liveRequestQueue = new LiveRequestQueue();
  });

  describe('Input Validation & Session Resolution', () => {
    it('should throw if both userId and sessionId are not provided', async () => {
      const agent = new MockLiveAgent('testAgent');
      const runner = new Runner({
        agent,
        appName: 'testApp',
        sessionService,
      });

      const gen = runner.runLive({
        userId: '',
        sessionId: '',
        liveRequestQueue,
      });
      await expect(gen.next()).rejects.toThrow(
        'Both userId and sessionId must be provided.',
      );
    });

    it('should throw if liveRequestQueue is missing', async () => {
      const agent = new MockLiveAgent('testAgent');
      const runner = new Runner({
        agent,
        appName: 'testApp',
        sessionService,
      });

      const gen = runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue: undefined as unknown as LiveRequestQueue,
      });
      await expect(gen.next()).rejects.toThrow(
        'liveRequestQueue is required for runLive.',
      );
    });

    it('should fetch existing session or create new one when userId and sessionId are provided', async () => {
      const agent = new MockLiveAgent('testAgent');
      const runner = new Runner({
        agent,
        appName: 'testApp',
        sessionService,
      });

      // First run creates session
      const gen1 = runner.runLive({
        userId: 'user_1',
        sessionId: 'sess_1',
        liveRequestQueue,
      });
      for await (const _ of gen1) {
        /* consume generator */
      }

      const createdSession = await sessionService.getSession({
        appName: 'testApp',
        userId: 'user_1',
        sessionId: 'sess_1',
      });
      expect(createdSession).toBeDefined();

      // Second run reuses existing session
      const gen2 = runner.runLive({
        userId: 'user_1',
        sessionId: 'sess_1',
        liveRequestQueue,
      });
      for await (const _ of gen2) {
        /* consume generator */
      }
      const fetchedSession = await sessionService.getSession({
        appName: 'testApp',
        userId: 'user_1',
        sessionId: 'sess_1',
      });
      expect(fetchedSession?.id).toBe('sess_1');
    });

    it('should default responseModalities to AUDIO when not provided', async () => {
      const agent = new MockLiveAgent('testAgent');
      const runner = new Runner({
        agent,
        appName: 'testApp',
        sessionService,
      });

      const gen = runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue,
      });
      for await (const _ of gen) {
        /* consume generator */
      }

      expect(agent.lastReceivedContext?.runConfig?.responseModalities).toEqual([
        Modality.AUDIO,
      ]);
    });
  });

  describe('Plugin Lifecycle & Resumption in runLive', () => {
    it('should pass liveSessionResumptionHandle to context when sessionResumption config is present', async () => {
      const agent = new MockLiveAgent('testAgent');
      const runner = new Runner({
        agent,
        appName: 'testApp',
        sessionService,
      });

      const gen = runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue,
        runConfig: {
          sessionResumption: {handle: 'resume_handle_xyz'},
        },
      });
      for await (const _ of gen) {
        /* consume generator */
      }

      expect(agent.lastReceivedContext?.liveSessionResumptionHandle).toBe(
        'resume_handle_xyz',
      );
    });

    it('should execute plugin beforeRun, onEvent, and afterRun callbacks', async () => {
      const mockEvent = createEvent({
        author: 'testAgent',
        content: createUserContent('normal event'),
      });
      const agent = new MockLiveAgent('testAgent', [mockEvent]);
      const plugin = new MockPlugin('livePlugin');

      const runner = new Runner({
        agent,
        appName: 'testApp',
        sessionService,
        plugins: [plugin],
      });

      const yieldedEvents: Event[] = [];
      for await (const event of runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue,
      })) {
        yieldedEvents.push(event);
      }

      expect(yieldedEvents.length).toBe(1);
      expect(yieldedEvents[0].content?.parts?.[0].text).toBe('normal event');
      expect(plugin.afterRunCalled).toBe(true);
    });

    it('should short-circuit runLive when plugin beforeRunCallback returns a response', async () => {
      const agent = new MockLiveAgent('testAgent', [
        createEvent({
          author: 'testAgent',
          content: createUserContent('should be skipped'),
        }),
      ]);
      const plugin = new MockPlugin('livePlugin');
      plugin.beforeRunResponse = createUserContent('short circuit event');

      const runner = new Runner({
        agent,
        appName: 'testApp',
        sessionService,
        plugins: [plugin],
      });

      const yieldedEvents: Event[] = [];
      for await (const event of runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue,
      })) {
        yieldedEvents.push(event);
      }

      expect(yieldedEvents.length).toBe(1);
      expect(yieldedEvents[0].content?.parts?.[0].text).toBe(
        'short circuit event',
      );
      expect(agent.lastReceivedContext).toBeUndefined(); // agent not run
    });
  });

  describe('shouldSaveLiveEventToSession Persistence Rules', () => {
    it('should NOT save partial events to session storage', async () => {
      const partialEvent = createEvent({
        author: 'testAgent',
        content: createUserContent('partial token...'),
        partial: true,
      });
      const agent = new MockLiveAgent('testAgent', [partialEvent]);
      const runner = new Runner({agent, appName: 'testApp', sessionService});

      for await (const _ of runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue,
      })) {
        /* consume generator */
      }

      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'u1',
        sessionId: 's1',
      });
      expect(session?.events.length).toBe(0);
    });

    it('should save usageMetadata, transcriptions, function calls, function responses, and text content', async () => {
      const usageEvent = createEvent({
        author: 'testAgent',
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      });
      const transcriptionEvent = createEvent({
        author: 'testAgent',
        outputTranscription: {text: 'Transcribed speech'},
      });
      const funcCallEvent = createEvent({
        author: 'testAgent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'do_task', args: {}}}],
        },
      });
      const funcRespEvent = createEvent({
        author: 'testAgent',
        content: {
          role: 'user',
          parts: [{functionResponse: {name: 'do_task', response: {ok: true}}}],
        },
      });
      const textEvent = createEvent({
        author: 'testAgent',
        content: createUserContent('Final text answer'),
      });

      const agent = new MockLiveAgent('testAgent', [
        usageEvent,
        transcriptionEvent,
        funcCallEvent,
        funcRespEvent,
        textEvent,
      ]);
      const runner = new Runner({agent, appName: 'testApp', sessionService});

      for await (const _ of runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue,
      })) {
        /* consume generator */
      }

      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'u1',
        sessionId: 's1',
      });
      expect(session?.events.length).toBe(5);
    });

    it('should NOT save inline audio/video blobs when saveLiveBlob is false (default)', async () => {
      const audioBlobEvent = createEvent({
        author: 'testAgent',
        content: {
          role: 'model',
          parts: [
            {inlineData: {mimeType: 'audio/pcm', data: 'binary_audio_data'}},
          ],
        },
      });
      const agent = new MockLiveAgent('testAgent', [audioBlobEvent]);
      const runner = new Runner({agent, appName: 'testApp', sessionService});

      for await (const _ of runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue,
      })) {
        /* consume generator */
      }

      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'u1',
        sessionId: 's1',
      });
      expect(session?.events.length).toBe(0);
    });

    it('should save inline audio/video blobs when saveLiveBlob is true', async () => {
      const audioBlobEvent = createEvent({
        author: 'testAgent',
        content: {
          role: 'model',
          parts: [
            {inlineData: {mimeType: 'audio/pcm', data: 'binary_audio_data'}},
          ],
        },
      });
      const agent = new MockLiveAgent('testAgent', [audioBlobEvent]);
      const runner = new Runner({agent, appName: 'testApp', sessionService});

      for await (const _ of runner.runLive({
        userId: 'u1',
        sessionId: 's1',
        liveRequestQueue,
        runConfig: {saveLiveBlob: true},
      })) {
        /* consume generator */
      }

      const session = await sessionService.getSession({
        appName: 'testApp',
        userId: 'u1',
        sessionId: 's1',
      });
      expect(session?.events.length).toBe(1);
    });
  });
});
