/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  Runner,
} from '@google/adk';
import {Blob, Content, Modality} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

class MockLiveAgent extends LlmAgent {
  eventsToYield: Event[] = [];

  constructor(name = 'mock_live_agent', subAgents: BaseAgent[] = []) {
    super({
      name,
      model: 'gemini-2.5-flash',
      subAgents,
    });
  }

  override async *runLive(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.eventsToYield) {
      if (context.abortSignal?.aborted) {
        return;
      }
      yield event;
    }
  }
}

class MockLivePlugin extends BasePlugin {
  enableBeforeRun = false;
  enableOnEvent = false;
  afterRunCalled = false;

  constructor() {
    super('mock_live_plugin');
  }

  override async beforeRunCallback({
    invocationContext: _invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    if (this.enableBeforeRun) {
      return {role: 'model', parts: [{text: 'Early exit from beforeRun'}]};
    }
    return undefined;
  }

  override async onEventCallback({
    invocationContext: _invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    if (this.enableOnEvent && event.content?.parts?.[0]?.text) {
      return createEvent({
        ...event,
        content: {
          role: event.content.role,
          parts: [{text: `${event.content.parts[0].text} [MODIFIED]`}],
        },
      });
    }
    return undefined;
  }

  override async afterRunCallback({
    invocationContext: _invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    this.afterRunCalled = true;
  }
}

describe('Runner.runLive', () => {
  let sessionService: InMemorySessionService;
  let liveRequestQueue: LiveRequestQueue;
  let mockAgent: MockLiveAgent;
  let runner: Runner;

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    liveRequestQueue = new LiveRequestQueue();
    mockAgent = new MockLiveAgent();
    runner = new Runner({
      appName: 'test_app',
      agent: mockAgent,
      sessionService,
    });
  });

  it('throws an error if liveRequestQueue is not provided', async () => {
    const generator = runner.runLive({
      userId: 'user1',
      sessionId: 'session1',
      liveRequestQueue: undefined as unknown as LiveRequestQueue,
    });
    await expect(generator.next()).rejects.toThrow(
      'liveRequestQueue is required for runLive.',
    );
  });

  it('throws an error if neither session nor userId and sessionId are provided', async () => {
    const generator = runner.runLive({
      liveRequestQueue,
    });
    await expect(generator.next()).rejects.toThrow(
      'Either session or userId and sessionId must be provided.',
    );
  });

  it('throws an error if session cannot be found when userId and sessionId are provided', async () => {
    const generator = runner.runLive({
      userId: 'user1',
      sessionId: 'non_existent_session',
      liveRequestQueue,
    });
    await expect(generator.next()).rejects.toThrow(
      'Session not found: non_existent_session',
    );
  });

  it('yields events and filters out inline audio blobs and partial transcriptions from saving to session', async () => {
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user1',
    });

    const textEvent = createEvent({
      invocationId: 'inv1',
      author: 'model',
      content: {role: 'model', parts: [{text: 'Hello text'}]},
    });

    const audioBlobEvent = createEvent({
      invocationId: 'inv1',
      author: 'model',
      content: {
        role: 'model',
        parts: [
          {
            inlineData: {
              data: 'base64audio',
              mimeType: 'audio/pcm',
            } as Blob,
          },
        ],
      },
    });

    const partialTranscriptionEvent = createEvent({
      invocationId: 'inv1',
      author: 'model',
      content: {role: 'model', parts: [{text: 'Partial text...'}]},
      partial: true,
    });

    const functionCallEvent = createEvent({
      invocationId: 'inv1',
      author: 'model',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'test_tool', args: {}}}],
      },
    });

    mockAgent.eventsToYield = [
      textEvent,
      audioBlobEvent,
      partialTranscriptionEvent,
      functionCallEvent,
    ];

    const yieldedEvents: Event[] = [];
    for await (const event of runner.runLive({
      session,
      liveRequestQueue,
    })) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents).toHaveLength(4);
    expect(yieldedEvents[0].content?.parts?.[0].text).toBe('Hello text');
    expect(yieldedEvents[1].content?.parts?.[0].inlineData?.mimeType).toBe(
      'audio/pcm',
    );
    expect(yieldedEvents[2].partial).toBe(true);
    expect(yieldedEvents[3].content?.parts?.[0].functionCall?.name).toBe(
      'test_tool',
    );

    const updatedSession = await sessionService.getSession({
      appName: 'test_app',
      userId: 'user1',
      sessionId: session.id,
    });
    expect(updatedSession?.events).toBeDefined();
    // Only non-partial text and function call events should be saved to the session
    expect(updatedSession!.events).toHaveLength(2);
    expect(updatedSession!.events[0].content?.parts?.[0].text).toBe(
      'Hello text',
    );
    expect(
      updatedSession!.events[1].content?.parts?.[0].functionCall?.name,
    ).toBe('test_tool');
  });

  it('runs beforeRunCallback and exits early if content is returned', async () => {
    const plugin = new MockLivePlugin();
    plugin.enableBeforeRun = true;
    const runnerWithPlugin = new Runner({
      appName: 'test_app',
      agent: mockAgent,
      sessionService,
      plugins: [plugin],
    });

    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user1',
    });

    mockAgent.eventsToYield = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'Should not reach here'}]},
      }),
    ];

    const yieldedEvents: Event[] = [];
    for await (const event of runnerWithPlugin.runLive({
      session,
      liveRequestQueue,
    })) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents).toHaveLength(1);
    expect(yieldedEvents[0].content?.parts?.[0].text).toBe(
      'Early exit from beforeRun',
    );
    expect(plugin.afterRunCalled).toBe(false);
  });

  it('runs onEventCallback and afterRunCallback during live run', async () => {
    const plugin = new MockLivePlugin();
    plugin.enableOnEvent = true;
    const runnerWithPlugin = new Runner({
      appName: 'test_app',
      agent: mockAgent,
      sessionService,
      plugins: [plugin],
    });

    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user1',
    });

    mockAgent.eventsToYield = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'Hello world'}]},
      }),
    ];

    const yieldedEvents: Event[] = [];
    for await (const event of runnerWithPlugin.runLive({
      session,
      liveRequestQueue,
    })) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents).toHaveLength(1);
    expect(yieldedEvents[0].content?.parts?.[0].text).toBe(
      'Hello world [MODIFIED]',
    );
    expect(plugin.afterRunCalled).toBe(true);
  });

  it('stops yielding events when abortSignal is aborted', async () => {
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user1',
    });

    const abortController = new AbortController();
    mockAgent.eventsToYield = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'First event'}]},
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'Second event'}]},
      }),
    ];

    const yieldedEvents: Event[] = [];
    for await (const event of runner.runLive({
      session,
      liveRequestQueue,
      abortSignal: abortController.signal,
    })) {
      yieldedEvents.push(event);
      abortController.abort();
    }

    expect(yieldedEvents).toHaveLength(1);
    expect(yieldedEvents[0].content?.parts?.[0].text).toBe('First event');
  });

  it('automatically configures audio transcriptions on runConfig when subAgents are present and responseModalities includes AUDIO', async () => {
    const subAgent = new LlmAgent({
      name: 'sub_agent',
      model: 'gemini-2.5-flash',
    });
    const multiAgent = new MockLiveAgent('multi_agent', [subAgent]);
    let capturedContext: InvocationContext | undefined;

    multiAgent.runLive = async function* (context: InvocationContext) {
      capturedContext = context;
      yield createEvent({
        author: 'multi_agent',
        content: {role: 'model', parts: [{text: 'Done'}]},
      });
    };

    const multiRunner = new Runner({
      appName: 'test_app',
      agent: multiAgent,
      sessionService,
    });

    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'user1',
    });

    for await (const _ of multiRunner.runLive({
      session,
      liveRequestQueue,
      runConfig: {responseModalities: ['AUDIO' as unknown as Modality]},
    })) {
      // drain
    }

    expect(capturedContext).toBeDefined();
    expect(capturedContext?.runConfig?.outputAudioTranscription).toBeDefined();
    expect(capturedContext?.runConfig?.inputAudioTranscription).toBeDefined();
  });
});
