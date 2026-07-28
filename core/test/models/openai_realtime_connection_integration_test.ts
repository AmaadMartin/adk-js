/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the OpenAI Realtime live path. It exercises the full
 * `ChatCompletionsLlm.connect() -> sendContent / sendRealtime -> receive() ->
 * close()` loop that a live runner drives, running the real `connect()` and
 * `OpenAiRealtimeConnection` code against an in-process fake WebSocket that
 * scripts a realistic server-event sequence. No network and no library mocks:
 * only the socket transport is simulated (there is no live OpenAI endpoint in
 * CI), so the connection logic runs exactly as it would in production.
 *
 * Manual end-to-end verification against a real endpoint (not run in CI, needs
 * a key) is documented in the PR description: construct
 * `new ChatCompletionsLlm({model: 'gpt-realtime', baseURL:
 * 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY})`, call
 * `connect()`, `sendContent` a text turn, and log `receive()` until
 * `turnComplete`. See the OpenAI Realtime WebSocket / conversations guides.
 */

import {Blob, Content} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {ChatCompletionsLlm, LlmRequest, LlmResponse} from '@google/adk';

/**
 * An in-process WebSocket stub that scripts a server. It records outbound
 * frames, opens on a microtask (so `connect()` installs its handlers first),
 * and lets the test push server events and close the socket.
 */
class ScriptedRealtimeSocket {
  static last: ScriptedRealtimeSocket | undefined;

  readonly url: string;
  readonly protocols?: string | string[];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: {data: string}) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  readonly sentFrames: Array<Record<string, unknown>> = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    ScriptedRealtimeSocket.last = this;
    queueMicrotask(() => this.onopen?.({}));
  }

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.onclose?.({});
  }

  /** Delivers a scripted server event, then closes the socket. */
  emitScriptAndClose(events: Array<Record<string, unknown>>): void {
    for (const event of events) {
      this.onmessage?.({data: JSON.stringify(event)});
    }
    this.onclose?.({});
  }
}

/** Collects every response yielded by an `LlmResponse` generator. */
async function collect(
  generator: AsyncGenerator<LlmResponse, void, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of generator) {
    responses.push(response);
  }
  return responses;
}

describe('OpenAI Realtime connection (integration)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    ScriptedRealtimeSocket.last = undefined;
  });

  it('drives a full voice turn end to end through the live connection', async () => {
    vi.stubGlobal('WebSocket', ScriptedRealtimeSocket);

    const llm = new ChatCompletionsLlm({
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-realtime',
      apiKey: 'sk-test',
    });

    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
      config: {systemInstruction: 'You are a helpful voice assistant.'},
    };

    // 1) connect(): opens the socket and sends the initial session.update.
    const connection = await llm.connect(request);
    const socket = ScriptedRealtimeSocket.last!;
    expect(socket.url).toBe(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime',
    );
    expect(socket.sentFrames[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime',
        instructions: 'You are a helpful voice assistant.',
        output_modalities: ['audio', 'text'],
      },
    });

    // 2) Outbound: a text turn plus a streamed audio frame.
    const userTurn: Content = {
      role: 'user',
      parts: [{text: "What's the weather?"}],
    };
    await connection.sendContent(userTurn);
    const audio: Blob = {mimeType: 'audio/pcm', data: 'QkFTRTY0QVVESU8='};
    await connection.sendRealtime(audio);

    expect(socket.sentFrames.slice(1)).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{type: 'input_text', text: "What's the weather?"}],
        },
      },
      {type: 'response.create'},
      {type: 'input_audio_buffer.append', audio: 'QkFTRTY0QVVESU8='},
    ]);

    // 3) Inbound: a scripted server turn, then close.
    const generator = connection.receive();
    socket.emitScriptAndClose([
      {type: 'session.created'}, // lifecycle event, ignored
      {type: 'response.output_audio_transcript.delta', delta: 'Sunny'},
      {type: 'response.output_text.delta', delta: "It's "},
      {type: 'response.output_text.delta', delta: 'sunny.'},
      {type: 'response.output_audio.delta', delta: 'QVVESU9DSFVOSw=='},
      {type: 'response.output_text.done'},
      {
        type: 'response.done',
        response: {
          output: [],
          usage: {input_tokens: 11, output_tokens: 4, total_tokens: 15},
        },
      },
    ]);

    const responses = await collect(generator);

    expect(responses).toEqual([
      {
        partial: true,
        outputTranscription: {text: 'Sunny', finished: false},
        modelVersion: 'gpt-realtime',
      },
      {
        partial: true,
        content: {role: 'model', parts: [{text: "It's "}]},
        modelVersion: 'gpt-realtime',
      },
      {
        partial: true,
        content: {role: 'model', parts: [{text: 'sunny.'}]},
        modelVersion: 'gpt-realtime',
      },
      {
        content: {
          role: 'model',
          parts: [
            {inlineData: {mimeType: 'audio/pcm', data: 'QVVESU9DSFVOSw=='}},
          ],
        },
        modelVersion: 'gpt-realtime',
      },
      {
        partial: false,
        content: {role: 'model', parts: [{text: "It's sunny."}]},
        modelVersion: 'gpt-realtime',
      },
      {
        turnComplete: true,
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 4,
          totalTokenCount: 15,
        },
        modelVersion: 'gpt-realtime',
      },
    ]);

    // 4) close() closes the underlying socket.
    let closed = false;
    socket.onclose = () => {
      closed = true;
    };
    await connection.close();
    expect(closed).toBe(true);
  });

  it('completes a function-call round trip over the live connection', async () => {
    vi.stubGlobal('WebSocket', ScriptedRealtimeSocket);

    const llm = new ChatCompletionsLlm({
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-realtime',
      apiKey: 'sk-test',
    });

    const connection = await llm.connect({
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    });
    const socket = ScriptedRealtimeSocket.last!;

    // The model asks for a tool call, the client returns the result.
    const receiveCall = connection.receive();
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'response.done',
        response: {
          output: [
            {
              type: 'function_call',
              name: 'get_weather',
              call_id: 'call_42',
              arguments: JSON.stringify({location: 'Paris'}),
            },
          ],
        },
      }),
    });
    socket.close();

    const firstTurn = await collect(receiveCall);
    expect(firstTurn).toEqual([
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_42',
                name: 'get_weather',
                args: {location: 'Paris'},
              },
            },
          ],
        },
        modelVersion: 'gpt-realtime',
      },
      {turnComplete: true, modelVersion: 'gpt-realtime'},
    ]);

    // The client replies with the function output.
    await connection.sendContent({
      parts: [
        {
          functionResponse: {
            id: 'call_42',
            name: 'get_weather',
            response: {temperature: '18C'},
          },
        },
      ],
    });

    expect(socket.sentFrames.slice(1)).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call_42',
          output: JSON.stringify({temperature: '18C'}),
        },
      },
      {type: 'response.create'},
    ]);
  });
});
