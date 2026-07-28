/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  CacheMetadata,
  ContextCacheConfig,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
  SequentialAgent,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

const PROMPT_TOKEN_COUNT = 4096;

interface CapturedRequest {
  cacheConfig?: ContextCacheConfig;
  cacheMetadata?: CacheMetadata;
  cacheableContentsTokenCount?: number;
}

/**
 * A mock model that records the cache-relevant fields of each request and, when
 * caching is enabled, returns a response whose `cacheMetadata` simulates what
 * the Gemini cache manager (Task 1) would populate: it echoes the request's
 * incoming metadata (reflecting an incremented reuse) or seeds an initial active
 * cache on the first cached turn.
 */
class RecordingLlm extends BaseLlm {
  static override readonly supportedModels: string[] = [];
  readonly capturedRequests: CapturedRequest[] = [];

  constructor() {
    super({model: 'context-cache-orchestration-test-model'});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.capturedRequests.push({
      cacheConfig: llmRequest.cacheConfig,
      cacheMetadata: llmRequest.cacheMetadata,
      cacheableContentsTokenCount: llmRequest.cacheableContentsTokenCount,
    });

    const response: LlmResponse = {
      content: {role: 'model', parts: [{text: 'ok'}]},
      usageMetadata: {promptTokenCount: PROMPT_TOKEN_COUNT},
    };

    if (llmRequest.cacheConfig) {
      response.cacheMetadata = llmRequest.cacheMetadata ?? {
        cacheName: 'projects/p/locations/l/cachedContents/c',
        expireTime: Date.now() / 1000 + 1800,
        fingerprint: 'fingerprint',
        invocationsUsed: 1,
        contentsCount: 2,
        createdAt: Date.now() / 1000,
      };
    }

    yield response;
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('connect is not used in these tests');
  }
}

/** Captures the invocation context's cache config when run as a sub-agent. */
class ConfigCapturingAgent extends BaseAgent {
  capturedConfig?: ContextCacheConfig;
  wasRun = false;

  constructor(name: string) {
    super({name});
  }

  // eslint-disable-next-line require-yield
  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.capturedConfig = context.contextCacheConfig;
    this.wasRun = true;
  }

  protected override async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

function userMessage(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

async function drain(gen: AsyncGenerator<Event, void, void>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('Context cache orchestration through the Runner', () => {
  it('threads App.contextCacheConfig onto the first LLM request', async () => {
    const model = new RecordingLlm();
    const agent = new LlmAgent({name: 'assistant', model});
    const cacheConfig = new ContextCacheConfig({minTokens: 2048});
    const app = new App({
      name: 'cache_app',
      rootAgent: agent,
      contextCacheConfig: cacheConfig,
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({app, sessionService});
    const session = await sessionService.createSession({
      appName: app.name,
      userId: 'user',
    });

    await drain(
      runner.runAsync({
        userId: 'user',
        sessionId: session.id,
        newMessage: userMessage('hello'),
      }),
    );

    expect(runner.contextCacheConfig).toBe(cacheConfig);
    expect(model.capturedRequests[0].cacheConfig).toBe(cacheConfig);
    expect(model.capturedRequests[0].cacheMetadata).toBeUndefined();
    expect(
      model.capturedRequests[0].cacheableContentsTokenCount,
    ).toBeUndefined();
  });

  it('recovers metadata and token count across turns and increments invocationsUsed', async () => {
    const model = new RecordingLlm();
    const agent = new LlmAgent({name: 'assistant', model});
    const cacheConfig = new ContextCacheConfig({minTokens: 2048});
    const app = new App({
      name: 'cache_app',
      rootAgent: agent,
      contextCacheConfig: cacheConfig,
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({app, sessionService});
    const session = await sessionService.createSession({
      appName: app.name,
      userId: 'user',
    });

    for (let turn = 0; turn < 3; turn++) {
      await drain(
        runner.runAsync({
          userId: 'user',
          sessionId: session.id,
          newMessage: userMessage(`turn ${turn}`),
        }),
      );
    }

    const [first, second, third] = model.capturedRequests;

    // Turn 1: no prior metadata or token count.
    expect(first.cacheMetadata).toBeUndefined();
    expect(first.cacheableContentsTokenCount).toBeUndefined();

    // Turn 2: recovers turn 1's metadata (incremented) and token count.
    expect(second.cacheMetadata?.invocationsUsed).toBe(2);
    expect(second.cacheableContentsTokenCount).toBe(PROMPT_TOKEN_COUNT);

    // Turn 3: recovers turn 2's metadata (incremented again).
    expect(third.cacheMetadata?.invocationsUsed).toBe(3);
    expect(third.cacheableContentsTokenCount).toBe(PROMPT_TOKEN_COUNT);
  });

  it('persists cacheMetadata onto the emitted model-response events', async () => {
    const model = new RecordingLlm();
    const agent = new LlmAgent({name: 'assistant', model});
    const cacheConfig = new ContextCacheConfig({minTokens: 2048});
    const app = new App({
      name: 'cache_app',
      rootAgent: agent,
      contextCacheConfig: cacheConfig,
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({app, sessionService});
    const session = await sessionService.createSession({
      appName: app.name,
      userId: 'user',
    });

    await drain(
      runner.runAsync({
        userId: 'user',
        sessionId: session.id,
        newMessage: userMessage('hello'),
      }),
    );

    const persisted = await sessionService.getSession({
      appName: app.name,
      userId: 'user',
      sessionId: session.id,
    });
    const modelEvent = persisted!.events.find((e) => e.author === 'assistant');
    expect(modelEvent?.cacheMetadata?.invocationsUsed).toBe(1);
  });

  it('propagates the config to a sub-agent invocation context', async () => {
    const subAgent = new ConfigCapturingAgent('sub');
    const rootAgent = new SequentialAgent({
      name: 'root',
      subAgents: [subAgent],
    });
    const cacheConfig = new ContextCacheConfig({minTokens: 2048});
    const app = new App({
      name: 'cache_app',
      rootAgent,
      contextCacheConfig: cacheConfig,
    });
    const sessionService = new InMemorySessionService();
    const runner = new Runner({app, sessionService});
    const session = await sessionService.createSession({
      appName: app.name,
      userId: 'user',
    });

    await drain(
      runner.runAsync({
        userId: 'user',
        sessionId: session.id,
        newMessage: userMessage('hello'),
      }),
    );

    expect(subAgent.wasRun).toBe(true);
    expect(subAgent.capturedConfig).toBe(cacheConfig);
  });

  it('is a no-op when no contextCacheConfig is set', async () => {
    const model = new RecordingLlm();
    const agent = new LlmAgent({name: 'assistant', model});
    const app = new App({name: 'cache_app', rootAgent: agent});
    const sessionService = new InMemorySessionService();
    const runner = new Runner({app, sessionService});
    const session = await sessionService.createSession({
      appName: app.name,
      userId: 'user',
    });

    for (let turn = 0; turn < 2; turn++) {
      await drain(
        runner.runAsync({
          userId: 'user',
          sessionId: session.id,
          newMessage: userMessage(`turn ${turn}`),
        }),
      );
    }

    expect(runner.contextCacheConfig).toBeUndefined();
    for (const request of model.capturedRequests) {
      expect(request.cacheConfig).toBeUndefined();
      expect(request.cacheMetadata).toBeUndefined();
      expect(request.cacheableContentsTokenCount).toBeUndefined();
    }

    const persisted = await sessionService.getSession({
      appName: app.name,
      userId: 'user',
      sessionId: session.id,
    });
    for (const event of persisted!.events) {
      expect(event.cacheMetadata).toBeUndefined();
    }
  });
});
