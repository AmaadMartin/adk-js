/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlmRequestProcessor,
  createSession,
  Event,
  Gemini,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {Modality} from '@google/genai';
import {describe, expect, it} from 'vitest';

// This harness drives a real Gemini Live session through LlmAgent.runLive end
// to end. It is skipped unless ADK_RUN_LIVE_E2E is explicitly set, so the
// standard test run (including CI) never requires live credentials. To run it
// manually, authenticate for Vertex AI and set:
//   ADK_RUN_LIVE_E2E=true GCP_PROJECT=<project> GCP_LOCATION=<location>
const runLiveE2e = process.env.ADK_RUN_LIVE_E2E === 'true';

const LIVE_MODEL = 'gemini-live-2.5-flash-native-audio';

/**
 * Configures the live connect config for a text-in / audio-out turn with output
 * transcription enabled. Real live runs are configured via RunConfig once
 * Runner.runLive is wired; this processor stands in for that here.
 */
class LiveConfigProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield
  async *runAsync(
    _invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    llmRequest.liveConnectConfig.responseModalities = [Modality.AUDIO];
    llmRequest.liveConnectConfig.outputAudioTranscription = {};
    llmRequest.config = {
      ...llmRequest.config,
      systemInstruction:
        'You are a helpful assistant. Answer concisely in one sentence.',
    };
  }
}

describe.skipIf(!runLiveE2e)('LlmAgent.runLive Gemini Live E2E', () => {
  const project =
    process.env.GCP_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    'placeholder-project';
  const location = process.env.GCP_LOCATION || 'us-central1';

  it('runs a short text turn end to end and streams transcribed output', async () => {
    const agent = new LlmAgent({
      name: 'live_e2e_agent',
      model: new Gemini({model: LIVE_MODEL, vertexai: true, project, location}),
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      requestProcessors: [new LiveConfigProcessor()],
    });

    const queue = new LiveRequestQueue();
    const context = new InvocationContext({
      invocationId: 'inv_live_e2e',
      session: createSession({id: 'session-e2e', appName: 'live-e2e'}),
      agent,
      pluginManager: new PluginManager(),
      liveRequestQueue: queue,
    });

    queue.sendContent({parts: [{text: 'Hello Gemini Live! What is 2 + 2?'}]});

    let transcript = '';
    let sawTurnComplete = false;
    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
      if (event.outputTranscription?.text) {
        transcript += event.outputTranscription.text;
      }
      for (const part of event.content?.parts ?? []) {
        if (part.text) {
          transcript += part.text;
        }
      }
      if (event.turnComplete) {
        sawTurnComplete = true;
        queue.close();
      }
    }

    expect(events.length).toBeGreaterThan(0);
    expect(sawTurnComplete).toBe(true);
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript.toLowerCase()).toMatch(/4|four/);
  }, 45000);
});
