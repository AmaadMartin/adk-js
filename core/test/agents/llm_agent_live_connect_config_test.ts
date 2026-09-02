/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlmConnection,
  BaseLlmRequestProcessor,
  Event,
  Gemini,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  Runner,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

import {ScriptedLiveConnection, ScriptedLiveLlm} from './live_test_helpers.js';

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session-id';

/**
 * A Gemini whose live connection is scripted. Subclassing keeps the real
 * `apiBackend` resolution, which is what these tests are about.
 */
class ScriptedGemini extends Gemini {
  readonly requestsSeen: LlmRequest[] = [];

  constructor(params: {vertexai: boolean}) {
    super(
      params.vertexai
        ? {
            model: 'gemini-2.5-flash',
            vertexai: true,
            project: 'test-project',
            location: 'us-central1',
          }
        : {model: 'gemini-2.5-flash', apiKey: 'test-key'},
    );
  }

  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    this.requestsSeen.push(
      JSON.parse(JSON.stringify(llmRequest)) as LlmRequest,
    );
    return new ScriptedLiveConnection([{turnComplete: true}]);
  }
}

/** Turns off transparent resumption before the flow reaches the connect. */
class TransparentOffProcessor extends BaseLlmRequestProcessor {
  override async *runAsync(
    _invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    yield* [];
    llmRequest.liveConnectConfig.sessionResumption = {transparent: false};
  }
}

describe('LlmAgent live connect config', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  async function runLive(
    llm: ScriptedGemini | ScriptedLiveLlm,
    options: {liveSessionResumptionHandle?: string} = {},
  ): Promise<Event[]> {
    const runner = new Runner({
      appName: APP_NAME,
      agent: new LlmAgent({name: 'agent', model: llm}),
      sessionService,
      artifactService: new InMemoryArtifactService(),
    });
    const queue = new LiveRequestQueue();
    queue.close();
    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: USER_ID,
      sessionId: SESSION_ID,
      liveRequestQueue: queue,
      liveSessionResumptionHandle: options.liveSessionResumptionHandle,
    })) {
      events.push(event);
    }
    return events;
  }

  describe('sessionResumption.transparent', () => {
    it('is set for a Vertex AI backed Gemini', async () => {
      const llm = new ScriptedGemini({vertexai: true});

      await runLive(llm, {liveSessionResumptionHandle: 'handle-1'});

      expect(llm.requestsSeen[0].liveConnectConfig.sessionResumption).toEqual({
        handle: 'handle-1',
        transparent: true,
      });
    });

    it('is left unset for the Gemini API backend, which rejects it', async () => {
      const llm = new ScriptedGemini({vertexai: false});

      await runLive(llm, {liveSessionResumptionHandle: 'handle-1'});

      expect(llm.requestsSeen[0].liveConnectConfig.sessionResumption).toEqual({
        handle: 'handle-1',
      });
    });

    it('is left unset for a model that is not a Gemini', async () => {
      const llm = new ScriptedLiveLlm([[{turnComplete: true}]]);

      await runLive(llm, {liveSessionResumptionHandle: 'handle-1'});

      expect(llm.requestsSeen[0].liveConnectConfig.sessionResumption).toEqual({
        handle: 'handle-1',
      });
    });

    it('keeps an explicit value the caller already chose', async () => {
      const llm = new ScriptedGemini({vertexai: true});
      const agent = new LlmAgent({name: 'agent', model: llm});
      agent.requestProcessors.push(new TransparentOffProcessor());
      const runner = new Runner({
        appName: APP_NAME,
        agent,
        sessionService,
        artifactService: new InMemoryArtifactService(),
      });
      const queue = new LiveRequestQueue();
      queue.close();

      for await (const _ of runner.runLive({
        userId: USER_ID,
        sessionId: SESSION_ID,
        liveRequestQueue: queue,
        liveSessionResumptionHandle: 'handle-1',
      })) {
        // drain
      }

      expect(llm.requestsSeen[0].liveConnectConfig.sessionResumption).toEqual({
        handle: 'handle-1',
        transparent: false,
      });
    });
  });
});
