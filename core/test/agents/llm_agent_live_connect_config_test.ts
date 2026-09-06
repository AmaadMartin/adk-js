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
  Session,
  createEvent,
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
  // eslint-disable-next-line require-yield -- it only mutates the request.
  override async *runAsync(
    _invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    llmRequest.liveConnectConfig.sessionResumption = {transparent: false};
  }
}

describe('LlmAgent live connect config', () => {
  let sessionService: InMemorySessionService;
  let session: Session;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  async function seedHistory(): Promise<void> {
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'seed',
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
    });
  }

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

  describe('historyConfig.initialHistoryInClientContent', () => {
    it('is set on the Gemini API backend when history is replayed', async () => {
      await seedHistory();
      const llm = new ScriptedGemini({vertexai: false});

      await runLive(llm);

      expect(llm.requestsSeen[0].liveConnectConfig.historyConfig).toEqual({
        initialHistoryInClientContent: true,
      });
    });

    it('is set on the Vertex AI backend when history is replayed', async () => {
      await seedHistory();
      const llm = new ScriptedGemini({vertexai: true});

      await runLive(llm);

      expect(llm.requestsSeen[0].liveConnectConfig.historyConfig).toEqual({
        initialHistoryInClientContent: true,
      });
    });

    it('keeps an explicit false from the run config', async () => {
      await seedHistory();
      const llm = new ScriptedGemini({vertexai: false});
      const runner = new Runner({
        appName: APP_NAME,
        agent: new LlmAgent({name: 'agent', model: llm}),
        sessionService,
        artifactService: new InMemoryArtifactService(),
      });
      const queue = new LiveRequestQueue();
      queue.close();

      for await (const _ of runner.runLive({
        userId: USER_ID,
        sessionId: SESSION_ID,
        liveRequestQueue: queue,
        runConfig: {historyConfig: {initialHistoryInClientContent: false}},
      })) {
        // drain
      }

      expect(llm.requestsSeen[0].liveConnectConfig.historyConfig).toEqual({
        initialHistoryInClientContent: false,
      });
    });

    it('is left unset when the session is resumed', async () => {
      await seedHistory();
      const llm = new ScriptedGemini({vertexai: false});

      await runLive(llm, {liveSessionResumptionHandle: 'handle-1'});

      expect(
        llm.requestsSeen[0].liveConnectConfig.historyConfig,
      ).toBeUndefined();
    });

    it('is left unset when there is no history to replay', async () => {
      const llm = new ScriptedGemini({vertexai: false});

      await runLive(llm);

      expect(
        llm.requestsSeen[0].liveConnectConfig.historyConfig,
      ).toBeUndefined();
    });
  });

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
