/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end coverage for the advanced live-flow parity features, wired together
 * with real (non-mocked) in-memory services to prove the units cooperate:
 *   1. fan-out of live requests to active streaming tools,
 *   2. persistence of user content + state delta to the session,
 *   3. input/output audio caching with flush-on-control-event, and
 *   4. voice-activity passthrough from the live server message stream.
 */

import {
  ActiveStreamingTool,
  AudioCacheManager,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LiveRequest,
  LiveRequestQueue,
  LlmAgent,
  PluginManager,
  RunConfig,
  Session,
  createEvent,
  fanOutLiveRequest,
  handleControlEventFlush,
  persistLiveRequest,
} from '@google/adk';
import {VoiceActivityType} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {ScopedArtifactService} from '../../../core/src/artifacts/scoped_artifact_service.js';
import {LiveResponseAggregator} from '../../../core/src/utils/live_connection_utils.js';

const APP_NAME = 'live-e2e-app';
const USER_ID = 'live-e2e-user';
const MODEL_VERSION = 'gemini-2.0-flash-live';

function toBase64(text: string): string {
  return Buffer.from(text).toString('base64');
}

async function setup(runConfig?: RunConfig): Promise<{
  context: InvocationContext;
  session: Session;
  artifactService: ScopedArtifactService;
}> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const artifactService = new ScopedArtifactService(
    new InMemoryArtifactService(),
    APP_NAME,
    USER_ID,
    session.id,
  );
  const context = new InvocationContext({
    invocationId: 'live-invocation',
    agent: new LlmAgent({name: 'live_agent'}),
    session,
    sessionService,
    artifactService,
    runConfig,
    pluginManager: new PluginManager(),
  });
  return {context, session, artifactService};
}

describe('Live-flow parity features (end-to-end, no mocks)', () => {
  it('fans out a user turn to a streaming tool and persists it with state', async () => {
    const {context, session} = await setup();
    const toolQueue = new LiveRequestQueue();
    context.activeStreamingTools = {
      searchTool: new ActiveStreamingTool({stream: toolQueue}),
    };

    const liveRequest: LiveRequest = {
      content: {role: 'user', parts: [{text: 'What is the weather?'}]},
      stateDelta: {lastQuery: 'weather'},
    };

    // Send path: fan out before persisting (matching the flow order).
    fanOutLiveRequest(context, liveRequest);
    await persistLiveRequest(context, liveRequest);

    // Item 1: the streaming tool observed the exact live request.
    const received = await toolQueue.get();
    expect(received).toBe(liveRequest);

    // Item 2: the session gained a single user turn carrying the state delta.
    expect(session.events).toHaveLength(1);
    expect(session.events[0].author).toBe('user');
    expect(session.events[0].content?.parts?.[0].text).toBe(
      'What is the weather?',
    );
    expect(session.events[0].actions.stateDelta).toEqual({
      lastQuery: 'weather',
    });
    expect(session.state['lastQuery']).toBe('weather');
  });

  it('caches input and output audio and flushes artifacts on turn complete', async () => {
    const {context, session, artifactService} = await setup({
      saveInputBlobsAsArtifacts: true,
    });
    const audioCacheManager = new AudioCacheManager();
    const aggregator = new LiveResponseAggregator(MODEL_VERSION);

    // Send path: cache the user's input audio (gated on the run config).
    const inputBlob = {data: toBase64('user-audio'), mimeType: 'audio/pcm'};
    if (context.runConfig?.saveInputBlobsAsArtifacts) {
      audioCacheManager.cacheAudio(context, inputBlob, 'input');
    }

    // Receive path: model audio flows through the aggregator and is cached.
    const audioMessage = {
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: toBase64('model-audio'),
                mimeType: 'audio/pcm',
              },
            },
          ],
        },
      },
    };
    for (const response of aggregator.processMessage(audioMessage)) {
      const firstPart = response.content?.parts?.[0];
      if (
        context.runConfig?.saveInputBlobsAsArtifacts &&
        firstPart?.inlineData?.mimeType?.startsWith('audio/')
      ) {
        audioCacheManager.cacheAudio(
          context,
          {
            data: firstPart.inlineData.data,
            mimeType: firstPart.inlineData.mimeType,
          },
          'output',
        );
      }
    }

    expect(context.inputRealtimeCache).toHaveLength(1);
    expect(context.outputRealtimeCache).toHaveLength(1);

    // Control event: turn complete flushes both caches.
    const flushed = await handleControlEventFlush(
      context,
      {turnComplete: true},
      audioCacheManager,
    );
    for (const event of flushed) {
      await context.sessionService!.appendEvent({session, event});
    }

    expect(flushed).toHaveLength(2);
    expect(context.inputRealtimeCache).toEqual([]);
    expect(context.outputRealtimeCache).toEqual([]);

    // The artifacts were really persisted to the artifact service.
    const keys = await artifactService.listArtifactKeys();
    expect(keys).toHaveLength(2);

    // The session gained audio events referencing those artifacts via fileData.
    const audioEvents = session.events.filter(
      (event) => event.content?.parts?.[0].fileData,
    );
    expect(audioEvents).toHaveLength(2);
    expect(audioEvents[0].content?.parts?.[0].fileData?.fileUri).toContain(
      '_adk_live/',
    );
  });

  it('surfaces a voice-activity signal from the live server message stream', async () => {
    const {context} = await setup();
    const aggregator = new LiveResponseAggregator(MODEL_VERSION);
    const voiceMessage = {
      voiceActivity: {
        voiceActivityType: VoiceActivityType.ACTIVITY_START,
        audioOffset: '0.5s',
      },
    };

    const events: Event[] = [];
    for (const response of aggregator.processMessage(voiceMessage)) {
      if (!response.voiceActivity) {
        continue;
      }
      const modelResponseEvent = createEvent({
        invocationId: context.invocationId,
        author: context.agent.name,
      });
      modelResponseEvent.voiceActivity = response.voiceActivity;
      events.push(modelResponseEvent);
    }

    expect(events).toHaveLength(1);
    expect(events[0].voiceActivity).toEqual(voiceMessage.voiceActivity);
  });
});
