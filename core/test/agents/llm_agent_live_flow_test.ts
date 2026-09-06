/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  AuthConfig,
  BaseLlm,
  BaseLlmRequestProcessor,
  BaseTool,
  BaseToolset,
  Event,
  FunctionTool,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  Runner,
  Task,
  getFunctionCalls,
} from '@google/adk';
import {Behavior, FunctionDeclaration} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

import {ScriptedLiveLlm} from './live_test_helpers.js';

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session-id';

/** Base64 for the bytes 0x01 0x02. */
const AUDIO_CHUNK = 'AQI=';

class ProtectedToolset extends BaseToolset {
  constructor() {
    super([]);
  }
  override getAuthConfig(): AuthConfig {
    return {
      authScheme: {type: 'apiKey', in: 'header', name: 'x-api-key'},
      credentialKey: 'protected-toolset-key',
    };
  }
  override async getTools(): Promise<BaseTool[]> {
    throw new Error('getTools must not run before the credential resolves.');
  }
  override async close(): Promise<void> {}
}

/** Captures the invocation context so a test can inspect it after the run. */
class ContextCapturingProcessor extends BaseLlmRequestProcessor {
  invocationContext?: InvocationContext;

  // eslint-disable-next-line require-yield -- it only records the context.
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.invocationContext = invocationContext;
  }
}

/** Registers a background tool task so the teardown has something to stop. */
class BackgroundTaskProcessor extends BaseLlmRequestProcessor {
  invocationContext?: InvocationContext;
  readonly task = new Task<void>(
    (abortSignal) =>
      new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => resolve(), {once: true});
      }),
  );

  // eslint-disable-next-line require-yield -- it only records the context.
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.invocationContext = invocationContext;
    invocationContext.activeStreamingTools = {
      worker: new ActiveStreamingTool({task: this.task}),
    };
  }
}

/** A non-live model that answers with a single text turn. */
class TextOnlyLlm extends BaseLlm {
  readonly requestsSeen: LlmRequest[] = [];

  constructor() {
    super({model: 'text-only-llm'});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requestsSeen.push(llmRequest);
    yield {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  override async connect(): Promise<never> {
    throw new Error('connect is not used by the non-live tests.');
  }
}

function streamingTool(): FunctionTool {
  return new FunctionTool({
    name: 'streamer',
    description: 'Yields results as they arrive.',
    execute: async function* () {
      yield 'chunk';
    },
  });
}

function declarationsOf(llmRequest: LlmRequest): FunctionDeclaration[] {
  const geminiTool = llmRequest.config?.tools?.[0];
  if (!geminiTool || !('functionDeclarations' in geminiTool)) {
    return expect.fail('the request carries no function declarations');
  }
  return geminiTool.functionDeclarations ?? [];
}

describe('LlmAgent live flow', () => {
  let sessionService: InMemorySessionService;
  let artifactService: InMemoryArtifactService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    artifactService = new InMemoryArtifactService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  function makeRunner(agent: LlmAgent): Runner {
    return new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      artifactService,
    });
  }

  async function drain(
    runner: Runner,
    queue: LiveRequestQueue,
    runConfig?: {saveLiveBlob?: boolean},
  ): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: USER_ID,
      sessionId: SESSION_ID,
      liveRequestQueue: queue,
      runConfig,
    })) {
      events.push(event);
    }
    return events;
  }

  function artifactKeys(): Promise<string[]> {
    return artifactService.listArtifactKeys({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  }

  describe('audio caching', () => {
    it('writes the turn audio to the artifact service on turn complete', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {
            content: {
              role: 'model',
              parts: [{inlineData: {data: AUDIO_CHUNK, mimeType: 'audio/pcm'}}],
            },
          },
          {turnComplete: true},
        ],
      ]);
      const runner = makeRunner(new LlmAgent({name: 'agent', model: llm}));
      const queue = new LiveRequestQueue();
      queue.sendRealtime({data: AUDIO_CHUNK, mimeType: 'audio/pcm'});
      queue.close();

      const events = await drain(runner, queue, {saveLiveBlob: true});

      const keys = await artifactKeys();
      expect(keys.filter((key) => key.includes('input_audio'))).toHaveLength(1);
      expect(keys.filter((key) => key.includes('output_audio'))).toHaveLength(
        1,
      );
      const references = events
        .flatMap((event) => event.content?.parts ?? [])
        .map((part) => part.fileData?.fileUri)
        .filter((uri): uri is string => uri !== undefined);
      expect(references).toHaveLength(2);
      for (const reference of references) {
        expect(reference).toContain(
          `artifact://${APP_NAME}/${USER_ID}/${SESSION_ID}/_adk_live/`,
        );
      }
    });

    it('caches nothing while saveLiveBlob is off', async () => {
      const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);
      const agent = new LlmAgent({name: 'agent', model: llm});
      const processor = new ContextCapturingProcessor();
      agent.requestProcessors.push(processor);
      const runner = makeRunner(agent);
      const queue = new LiveRequestQueue();
      for (let i = 0; i < 5; i++) {
        queue.sendRealtime({data: AUDIO_CHUNK, mimeType: 'audio/pcm'});
      }
      queue.close();

      await drain(runner, queue);

      // Nothing flushes the cache while the flag is off, so nothing may enter
      // it either.
      expect(processor.invocationContext?.inputRealtimeCache).toBeUndefined();
      expect(llm.connections[0].realtimeCalls).toHaveLength(5);
    });

    it('emits no turnComplete on a turn whose audio it flushed', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {
            content: {
              role: 'model',
              parts: [{inlineData: {data: AUDIO_CHUNK, mimeType: 'audio/pcm'}}],
            },
          },
          {turnComplete: true},
        ],
      ]);
      const runner = makeRunner(new LlmAgent({name: 'agent', model: llm}));
      const queue = new LiveRequestQueue();
      queue.close();

      const events = await drain(runner, queue, {saveLiveBlob: true});

      // The flush replaces the control event, so a caller cannot use
      // turnComplete as the turn boundary. The guide says so too.
      expect(events.some((event) => event.turnComplete)).toBe(false);
      expect(
        events.some((event) =>
          event.content?.parts?.some((part) => part.fileData),
        ),
      ).toBe(true);
    });

    it('writes nothing when saveLiveBlob is off', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {
            content: {
              role: 'model',
              parts: [{inlineData: {data: AUDIO_CHUNK, mimeType: 'audio/pcm'}}],
            },
          },
          {turnComplete: true},
        ],
      ]);
      const runner = makeRunner(new LlmAgent({name: 'agent', model: llm}));
      const queue = new LiveRequestQueue();
      queue.sendRealtime({data: AUDIO_CHUNK, mimeType: 'audio/pcm'});
      queue.close();

      const events = await drain(runner, queue);

      expect(await artifactKeys()).toEqual([]);
      expect(events.some((event) => event.turnComplete)).toBe(true);
    });

    it('flushes only the model audio when the user interrupts', async () => {
      const llm = new ScriptedLiveLlm([
        [
          {
            content: {
              role: 'model',
              parts: [{inlineData: {data: AUDIO_CHUNK, mimeType: 'audio/pcm'}}],
            },
          },
          {interrupted: true},
        ],
      ]);
      const agent = new LlmAgent({name: 'agent', model: llm});
      const processor = new ContextCapturingProcessor();
      agent.requestProcessors.push(processor);
      const runner = makeRunner(agent);
      const queue = new LiveRequestQueue();
      // The user is still speaking, so their audio must survive the flush.
      queue.sendRealtime({data: AUDIO_CHUNK, mimeType: 'audio/pcm'});
      queue.close();

      await drain(runner, queue, {saveLiveBlob: true});

      const keys = await artifactKeys();
      expect(keys.filter((key) => key.includes('output_audio'))).toHaveLength(
        1,
      );
      expect(keys.filter((key) => key.includes('input_audio'))).toEqual([]);
      expect(processor.invocationContext?.inputRealtimeCache).toHaveLength(1);
    });
  });

  describe('toolset auth', () => {
    it('interrupts the live run before the connection opens', async () => {
      const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);
      const runner = makeRunner(
        new LlmAgent({
          name: 'agent',
          model: llm,
          tools: [new ProtectedToolset()],
        }),
      );
      const queue = new LiveRequestQueue();
      queue.close();

      const events = await drain(runner, queue);

      expect(llm.connections).toEqual([]);
      expect(events).toHaveLength(1);
      expect(getFunctionCalls(events[0])[0].name).toBe(
        REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
      );
    });

    it('interrupts the non-live run too', async () => {
      const llm = new TextOnlyLlm();
      const runner = makeRunner(
        new LlmAgent({
          name: 'agent',
          model: llm,
          tools: [new ProtectedToolset()],
        }),
      );

      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
      })) {
        events.push(event);
      }

      expect(llm.requestsSeen).toEqual([]);
      const authEvent = events.find(
        (event) =>
          getFunctionCalls(event)[0]?.name ===
          REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
      );
      expect(authEvent).toBeDefined();
    });
  });

  describe('NON_BLOCKING declarations', () => {
    it('marks a streaming tool on the live path', async () => {
      const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);
      const runner = makeRunner(
        new LlmAgent({name: 'agent', model: llm, tools: [streamingTool()]}),
      );
      const queue = new LiveRequestQueue();
      queue.close();

      await drain(runner, queue);

      expect(declarationsOf(llm.requestsSeen[0])[0].behavior).toBe(
        Behavior.NON_BLOCKING,
      );
    });

    it('leaves the same tool unmarked on the non-live path', async () => {
      const llm = new TextOnlyLlm();
      const runner = makeRunner(
        new LlmAgent({name: 'agent', model: llm, tools: [streamingTool()]}),
      );

      for await (const _ of runner.runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: {role: 'user', parts: [{text: 'hello'}]},
      })) {
        // drain
      }

      expect(declarationsOf(llm.requestsSeen[0])[0].behavior).toBeUndefined();
    });
  });

  describe('background tool tasks', () => {
    it('stops the tasks the run started when the run ends', async () => {
      const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);
      const agent = new LlmAgent({name: 'agent', model: llm});
      const processor = new BackgroundTaskProcessor();
      agent.requestProcessors.push(processor);
      const runner = makeRunner(agent);
      const queue = new LiveRequestQueue();
      queue.close();

      await drain(runner, queue);

      expect(processor.task.done()).toBe(true);
      expect(processor.invocationContext?.activeStreamingTools).toEqual({});
    });
  });
});
