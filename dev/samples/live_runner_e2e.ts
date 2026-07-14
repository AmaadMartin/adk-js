/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  Runner,
} from '@google/adk';

/**
 * A sample LlmAgent configured for bidirectional live voice/text interactions.
 */
export const rootAgent = new LlmAgent({
  name: 'live_assistant_agent',
  model: 'gemini-2.5-flash',
  description:
    'An interactive bidirectional voice and text streaming assistant.',
  instruction:
    'You are a helpful live assistant. You listen to user text or audio inputs and respond concisely.',
});

/**
 * Demonstrates running a live bidirectional streaming flow with `Runner.runLive()`
 * and `LiveRequestQueue`.
 */
export async function runLiveSample(): Promise<void> {
  console.log('--- Starting Bidirectional Live Runner Sample ---');

  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    appName: 'live_sample_app',
    agent: rootAgent,
    sessionService,
  });

  const session = await sessionService.createSession({
    appName: 'live_sample_app',
    userId: 'sample_user',
  });

  const liveRequestQueue = new LiveRequestQueue();

  // In a real application, user inputs (mic audio, text box) would be pushed asynchronously.
  // Here we simulate sending text and PCM audio chunks in the background.
  setTimeout(() => {
    console.log('[Client] Sending initial user greeting text...');
    liveRequestQueue.sendContent({
      role: 'user',
      parts: [{text: 'Hello! Can you hear my live audio stream?'}],
    });
  }, 100);

  setTimeout(() => {
    console.log('[Client] Sending simulated audio chunk...');
    liveRequestQueue.sendRealtime({
      data: 'U2ltdWxhdGVkIFBDTSBBdWRpbyBEYXRh', // base64 representation
      mimeType: 'audio/pcm',
    });
  }, 300);

  setTimeout(() => {
    console.log('[Client] Closing live request queue...');
    liveRequestQueue.close();
  }, 1000);

  try {
    // Consume live events emitted by the runner as the model streams responses.
    for await (const event of runner.runLive({
      session,
      liveRequestQueue,
    })) {
      if (event.inputTranscription) {
        console.log(
          `[Model Input Transcription] ${event.inputTranscription.text}`,
        );
      }
      if (event.outputTranscription) {
        console.log(
          `[Model Output Transcription${event.partial ? ' (partial)' : ''}] ${event.outputTranscription.text}`,
        );
      }
      if (event.content?.parts?.length) {
        for (const part of event.content.parts) {
          if (part.text) {
            console.log(`[Model Text Response] ${part.text}`);
          } else if (part.inlineData) {
            console.log(
              `[Model Audio Stream Chunk] MIME: ${part.inlineData.mimeType}, Length: ${part.inlineData.data?.length ?? 0} bytes`,
            );
          }
        }
      }
    }
  } catch (error) {
    console.error('[Live Runner Error]', error);
  }

  console.log('--- Bidirectional Live Runner Sample Completed ---');
}

// If executed standalone via node/ts-node, run the sample if API key is set or inform the user.
if (
  (typeof require !== 'undefined' && require.main === module) ||
  process.argv.some((arg) => arg.endsWith('live_runner_e2e.ts'))
) {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.log(
      'Note: Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable to run against live Gemini API.',
    );
  } else {
    runLiveSample().catch((err) => console.error(err));
  }
}
