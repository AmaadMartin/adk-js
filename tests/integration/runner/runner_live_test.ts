/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemoryRunner,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
} from '@google/adk';
import {Modality} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'InMemoryRunner';
const USER_ID = 'live_user';
const SESSION_ID = 'live_session';

/**
 * A live agent that drains the invocation's {@link LiveRequestQueue} and echoes
 * each content request back as a model event, terminating when the queue closes.
 *
 * It overrides `runLiveImpl` directly and never contacts a real model, so the
 * test exercises the full `Runner.runLive` lifecycle through the public
 * `InMemoryRunner` API with no external services.
 */
class EchoLiveAgent extends LlmAgent {
  constructor() {
    super({name: 'echo_live_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const queue = context.liveRequestQueue;
    if (!queue) {
      throw new Error('Expected a liveRequestQueue on the invocation context.');
    }
    for await (const request of queue) {
      if (request.close) {
        break;
      }
      const text = request.content?.parts?.[0]?.text ?? '';
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: `echo: ${text}`}]},
      });
    }
  }
}

/**
 * A live agent that, for each realtime audio blob pushed onto the queue, streams
 * back a raw inline-audio model event (which must NOT be persisted) followed by
 * its text transcription (which must be persisted). After the queue closes it
 * emits a saved-artifact `fileData` reference and a tool call, both of which are
 * persisted. Exercises the media-persistence gating end-to-end via the public
 * `InMemoryRunner` API with no external services.
 */
class MediaLiveAgent extends LlmAgent {
  constructor() {
    super({name: 'media_live_agent', model: 'gemini-2.5-flash'});
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const queue = context.liveRequestQueue;
    if (!queue) {
      throw new Error('Expected a liveRequestQueue on the invocation context.');
    }
    for await (const request of queue) {
      if (request.close) {
        break;
      }
      if (!request.blob) {
        continue;
      }
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {
          role: 'model',
          parts: [
            {inlineData: {mimeType: request.blob.mimeType, data: 'AAAA'}},
          ],
        },
      });
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: 'transcription: hello'}]},
      });
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [
          {fileData: {fileUri: 'gs://bucket/turn', mimeType: 'audio/pcm'}},
        ],
      },
    });
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'summarize', args: {}}}],
      },
    });
  }
}

/**
 * A multi-agent live root that captures the `RunConfig` it is invoked with, so a
 * test can assert that `runLive` applied the multi-agent transcription defaults.
 */
class TranscriptionCapturingRootAgent extends LlmAgent {
  capturedInputTranscription?: object;
  capturedOutputTranscription?: object;

  constructor() {
    super({
      name: 'root_live_agent',
      model: 'gemini-2.5-flash',
      subAgents: [
        new LlmAgent({name: 'sub_live_agent', model: 'gemini-2.5-flash'}),
      ],
    });
  }

  protected override async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.capturedInputTranscription =
      context.runConfig?.inputAudioTranscription;
    this.capturedOutputTranscription =
      context.runConfig?.outputAudioTranscription;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ready'}]},
    });
    const queue = context.liveRequestQueue;
    if (queue) {
      for await (const request of queue) {
        if (request.close) {
          break;
        }
      }
    }
  }
}

describe('Runner.runLive integration', () => {
  it('streams and persists echoed events driven by the live queue', async () => {
    const runner = new InMemoryRunner({agent: new EchoLiveAgent()});
    await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const liveRequestQueue = new LiveRequestQueue();

    const collected: Event[] = [];
    const consumed = (async () => {
      for await (const event of runner.runLive({
        userId: USER_ID,
        sessionId: SESSION_ID,
        liveRequestQueue,
      })) {
        collected.push(event);
      }
    })();

    // Drive input into the same queue the agent is draining, then end the loop.
    liveRequestQueue.sendContent({role: 'user', parts: [{text: 'hello'}]});
    liveRequestQueue.sendContent({role: 'user', parts: [{text: 'world'}]});
    liveRequestQueue.close();

    await consumed;

    // Events are streamed back to the caller...
    expect(collected.map((e) => e.content?.parts?.[0]?.text)).toEqual([
      'echo: hello',
      'echo: world',
    ]);

    // ...and persisted (non-partial) to the in-memory session.
    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(session!.events.map((e) => e.content?.parts?.[0]?.text)).toEqual([
      'echo: hello',
      'echo: world',
    ]);
    expect(session!.events.every((e) => e.author === 'echo_live_agent')).toBe(
      true,
    );
  });

  it('drops raw inline audio from the session but persists transcription, fileData and tool events', async () => {
    const runner = new InMemoryRunner({agent: new MediaLiveAgent()});
    await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const liveRequestQueue = new LiveRequestQueue();
    const collected: Event[] = [];
    const consumed = (async () => {
      for await (const event of runner.runLive({
        userId: USER_ID,
        sessionId: SESSION_ID,
        liveRequestQueue,
      })) {
        collected.push(event);
      }
    })();

    // Send a raw audio blob, then end the live stream.
    liveRequestQueue.sendRealtime({data: 'AAAA', mimeType: 'audio/pcm'});
    liveRequestQueue.close();

    await consumed;

    const firstPartKind = (event: Event): string => {
      const part = event.content?.parts?.[0];
      if (part?.inlineData) return `inline:${part.inlineData.mimeType}`;
      if (part?.text) return `text:${part.text}`;
      if (part?.fileData) return `file:${part.fileData.fileUri}`;
      if (part?.functionCall) return `call:${part.functionCall.name}`;
      return 'unknown';
    };

    // All four events are streamed to the caller, including the raw audio.
    expect(collected.map(firstPartKind)).toEqual([
      'inline:audio/pcm',
      'text:transcription: hello',
      'file:gs://bucket/turn',
      'call:summarize',
    ]);

    // The raw inline-audio event is not persisted; the rest are.
    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(session!.events.map(firstPartKind)).toEqual([
      'text:transcription: hello',
      'file:gs://bucket/turn',
      'call:summarize',
    ]);
  });

  it('defaults transcription configs for a multi-agent live root so transfers keep context', async () => {
    const rootAgent = new TranscriptionCapturingRootAgent();
    const runner = new InMemoryRunner({agent: rootAgent});
    await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    const liveRequestQueue = new LiveRequestQueue();
    const consumed = (async () => {
      for await (const _event of runner.runLive({
        userId: USER_ID,
        sessionId: SESSION_ID,
        liveRequestQueue,
        runConfig: {responseModalities: [Modality.AUDIO]},
      })) {
        // drain
      }
    })();

    liveRequestQueue.close();
    await consumed;

    // Because the root has sub-agents and AUDIO is a modality, both the input
    // and output transcription configs are defaulted, so a transferred-to
    // sub-agent receives the model's text transcription as context.
    expect(rootAgent.capturedInputTranscription).toEqual({});
    expect(rootAgent.capturedOutputTranscription).toEqual({});
  });
});
