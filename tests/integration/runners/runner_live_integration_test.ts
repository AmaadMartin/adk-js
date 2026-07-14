/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {Blob, Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

class IntegrationMockLlmConnection implements BaseLlmConnection {
  sentContents: Content[] = [];
  sentRealtime: Blob[] = [];
  responsesToYield: LlmResponse[] = [];
  closed = false;

  async sendHistory(_history: Content[]): Promise<void> {}

  async sendContent(content: Content): Promise<void> {
    this.sentContents.push(content);
  }

  async sendRealtime(blob: Blob): Promise<void> {
    this.sentRealtime.push(blob);
  }

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for (const resp of this.responsesToYield) {
      yield resp;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class IntegrationMockLlm extends BaseLlm {
  connections: IntegrationMockLlmConnection[] = [];

  constructor() {
    super({model: 'gemini-2.5-flash'});
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    const conn = new IntegrationMockLlmConnection();
    conn.responsesToYield = [
      {
        content: {
          role: 'model',
          parts: [{text: 'Hello from live model audio transcription'}],
        },
      },
      {
        outputTranscription: {
          text: 'Hello from live model audio transcription',
        },
        partial: false,
      },
    ];
    this.connections.push(conn);
    return conn;
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: 'Fallback'}]}};
  }
}

describe('Runner.runLive Integration Test', () => {
  it('runs an in-memory live streaming session with LlmAgent and LiveRequestQueue, saving non-partial events to session', async () => {
    const sessionService = new InMemorySessionService();
    const mockLlm = new IntegrationMockLlm();
    const agent = new LlmAgent({
      name: 'live_integration_agent',
      model: mockLlm,
      instruction: 'You are a live assistant.',
    });

    const runner = new Runner({
      appName: 'integration_app',
      agent,
      sessionService,
    });

    const session = await sessionService.createSession({
      appName: 'integration_app',
      userId: 'user_live_int',
    });

    const liveRequestQueue = new LiveRequestQueue();

    // Launch streaming
    const runPromise = (async () => {
      const events: Event[] = [];
      for await (const event of runner.runLive({
        session,
        liveRequestQueue,
      })) {
        events.push(event);
      }
      return events;
    })();

    // Client sends user text and audio stream
    liveRequestQueue.sendContent({
      role: 'user',
      parts: [{text: 'Hi let us speak!'}],
    });
    liveRequestQueue.sendRealtime({
      data: 'pcm_audio_chunk_1',
      mimeType: 'audio/pcm',
    });
    liveRequestQueue.sendRealtime({
      data: 'pcm_audio_chunk_2',
      mimeType: 'audio/pcm',
    });
    liveRequestQueue.close();

    const yieldedEvents = await runPromise;
    expect(yieldedEvents.length).toBeGreaterThanOrEqual(2);
    expect(yieldedEvents[0].content?.parts?.[0].text).toBe(
      'Hello from live model audio transcription',
    );
    expect(yieldedEvents[1].outputTranscription?.text).toBe(
      'Hello from live model audio transcription',
    );

    const conn = mockLlm.connections[0];
    expect(conn.sentContents.length).toBe(1);
    expect(conn.sentContents[0].parts?.[0].text).toBe('Hi let us speak!');
    expect(conn.sentRealtime.length).toBe(2);
    expect(conn.closed).toBe(true);

    // Verify session persistence
    const updatedSession = await sessionService.getSession({
      appName: 'integration_app',
      userId: 'user_live_int',
      sessionId: session.id,
    });
    expect(updatedSession?.events).toBeDefined();
    // User message sent via sendContent is appended to session, plus non-partial model responses
    expect(updatedSession!.events.length).toBeGreaterThanOrEqual(2);
    expect(
      updatedSession!.events.some(
        (e) =>
          e.author === 'user' &&
          e.content?.parts?.[0].text === 'Hi let us speak!',
      ),
    ).toBe(true);
    expect(
      updatedSession!.events.some(
        (e) =>
          e.author === 'live_integration_agent' &&
          e.content?.parts?.[0].text ===
            'Hello from live model audio transcription',
      ),
    ).toBe(true);
  });
});
