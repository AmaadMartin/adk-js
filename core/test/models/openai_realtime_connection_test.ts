/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob, Content} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  contentToRealtimeItems,
  OpenAiRealtimeConnection,
  OpenAiRealtimeServerEvent,
} from '../../src/models/openai_realtime_connection.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';

const MODEL = 'gpt-realtime';

describe('OpenAiRealtimeConnection', () => {
  let mockWs: {send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>};
  let messageQueue: AsyncQueue<OpenAiRealtimeServerEvent>;

  beforeEach(() => {
    mockWs = {send: vi.fn(), close: vi.fn()};
    messageQueue = new AsyncQueue<OpenAiRealtimeServerEvent>();
  });

  /** Parses the JSON frames sent to the socket, in order. */
  function sentEvents(): Array<Record<string, unknown>> {
    return mockWs.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
    );
  }

  function newConnection(): OpenAiRealtimeConnection {
    return new OpenAiRealtimeConnection(mockWs, MODEL, messageQueue);
  }

  describe('sendHistory', () => {
    it('sends an item per turn and a trailing response.create when last role is user', async () => {
      const history: Content[] = [
        {role: 'model', parts: [{text: 'hi'}]},
        {role: 'user', parts: [{text: 'hello there'}]},
      ];

      await newConnection().sendHistory(history);

      const events = sentEvents();
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{type: 'input_text', text: 'hi'}],
        },
      });
      expect(events[1]).toEqual({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{type: 'input_text', text: 'hello there'}],
        },
      });
      expect(events[2]).toEqual({type: 'response.create'});
    });

    it('omits response.create when the last role is not user', async () => {
      const history: Content[] = [
        {role: 'user', parts: [{text: 'hello'}]},
        {role: 'model', parts: [{text: 'hi'}]},
      ];

      await newConnection().sendHistory(history);

      const events = sentEvents();
      expect(events).toHaveLength(2);
      expect(events.some((e) => e['type'] === 'response.create')).toBe(false);
    });

    it('sends nothing for empty history', async () => {
      await newConnection().sendHistory([]);
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('sends nothing when history has no sendable content', async () => {
      await newConnection().sendHistory([{role: 'user', parts: [{}]}]);
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe('sendContent', () => {
    it('sends a message item then response.create for text', async () => {
      await newConnection().sendContent({role: 'user', parts: [{text: 'hi'}]});

      expect(sentEvents()).toEqual([
        {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{type: 'input_text', text: 'hi'}],
          },
        },
        {type: 'response.create'},
      ]);
    });

    it('sends a function_call_output item per response then response.create', async () => {
      await newConnection().sendContent({
        parts: [
          {functionResponse: {id: 'call_1', name: 'f', response: {ok: true}}},
          {functionResponse: {id: 'call_2', name: 'g', response: {n: 1}}},
        ],
      });

      expect(sentEvents()).toEqual([
        {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: 'call_1',
            output: JSON.stringify({ok: true}),
          },
        },
        {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: 'call_2',
            output: JSON.stringify({n: 1}),
          },
        },
        {type: 'response.create'},
      ]);
    });

    it('throws when content has no parts', async () => {
      await expect(newConnection().sendContent({role: 'user'})).rejects.toThrow(
        'Content must have parts.',
      );
    });
  });

  describe('sendRealtime', () => {
    it('appends audio blobs to the input buffer', async () => {
      const blob: Blob = {mimeType: 'audio/pcm', data: 'BASE64AUDIO'};
      await newConnection().sendRealtime(blob);

      expect(sentEvents()).toEqual([
        {type: 'input_audio_buffer.append', audio: 'BASE64AUDIO'},
      ]);
    });

    it('drops non-audio blobs without sending', async () => {
      const blob: Blob = {mimeType: 'image/png', data: 'BASE64IMAGE'};
      await newConnection().sendRealtime(blob);
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it('drops blobs with an unknown mime type', async () => {
      await newConnection().sendRealtime({data: 'x'});
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('closes the underlying socket', async () => {
      await newConnection().close();
      expect(mockWs.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('receive', () => {
    it('streams output text deltas as partial and flushes the accumulated text on done', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'response.output_text.delta', delta: 'Hello'});
      messageQueue.push({type: 'response.text.delta', delta: ' world'});
      messageQueue.push({type: 'response.output_text.done'});
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        partial: true,
        content: {role: 'model', parts: [{text: 'Hello'}]},
        modelVersion: MODEL,
      });
      expect((await generator.next()).value).toEqual({
        partial: true,
        content: {role: 'model', parts: [{text: ' world'}]},
        modelVersion: MODEL,
      });
      expect((await generator.next()).value).toEqual({
        partial: false,
        content: {role: 'model', parts: [{text: 'Hello world'}]},
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('falls back to the done event text when no deltas were streamed', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'response.output_text.done', text: 'Full text'});
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        partial: false,
        content: {role: 'model', parts: [{text: 'Full text'}]},
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('yields output audio deltas as inline data', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'response.output_audio.delta', delta: 'AUDIO1'});
      messageQueue.push({type: 'response.audio.delta', delta: 'AUDIO2'});
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        content: {
          role: 'model',
          parts: [{inlineData: {mimeType: 'audio/pcm', data: 'AUDIO1'}}],
        },
        modelVersion: MODEL,
      });
      expect((await generator.next()).value).toEqual({
        content: {
          role: 'model',
          parts: [{inlineData: {mimeType: 'audio/pcm', data: 'AUDIO2'}}],
        },
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('yields output audio transcript deltas', async () => {
      const generator = newConnection().receive();

      messageQueue.push({
        type: 'response.output_audio_transcript.delta',
        delta: 'spoken',
      });
      messageQueue.push({
        type: 'response.audio_transcript.delta',
        delta: ' words',
      });
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        partial: true,
        outputTranscription: {text: 'spoken', finished: false},
        modelVersion: MODEL,
      });
      expect((await generator.next()).value).toEqual({
        partial: true,
        outputTranscription: {text: ' words', finished: false},
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('yields input transcription delta then completed', async () => {
      const generator = newConnection().receive();

      messageQueue.push({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'he',
      });
      messageQueue.push({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'hello',
      });
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        partial: true,
        inputTranscription: {text: 'he', finished: false},
        modelVersion: MODEL,
      });
      expect((await generator.next()).value).toEqual({
        partial: false,
        inputTranscription: {text: 'hello', finished: true},
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('defaults an empty transcript when completion omits one', async () => {
      const generator = newConnection().receive();

      messageQueue.push({
        type: 'conversation.item.input_audio_transcription.completed',
      });
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        partial: false,
        inputTranscription: {text: '', finished: true},
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('emits function calls then turnComplete with usage on response.done', async () => {
      const generator = newConnection().receive();

      messageQueue.push({
        type: 'response.done',
        response: {
          output: [
            {
              type: 'function_call',
              name: 'get_weather',
              call_id: 'call_1',
              arguments: JSON.stringify({location: 'London'}),
            },
            {type: 'message', role: 'assistant'},
          ],
          usage: {input_tokens: 5, output_tokens: 7, total_tokens: 12},
        },
      });
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'get_weather',
                args: {location: 'London'},
              },
            },
          ],
        },
        modelVersion: MODEL,
      });
      expect((await generator.next()).value).toEqual({
        turnComplete: true,
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 7,
          totalTokenCount: 12,
        },
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('yields only turnComplete on an empty response.done', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'response.done'});
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        turnComplete: true,
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('defaults missing token counts to zero on response.done', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'response.done', response: {usage: {}}});
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        turnComplete: true,
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('defaults empty args for a function call without arguments', async () => {
      const generator = newConnection().receive();

      messageQueue.push({
        type: 'response.done',
        response: {output: [{type: 'function_call', name: 'f', call_id: 'c'}]},
      });
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'c', name: 'f', args: {}}}],
        },
        modelVersion: MODEL,
      });
      expect((await generator.next()).value).toEqual({
        turnComplete: true,
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('flushes empty output text when the done event has no text', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'response.output_text.done'});
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        partial: false,
        content: {role: 'model', parts: [{text: ''}]},
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('rejects when function call arguments are malformed', async () => {
      const generator = newConnection().receive();

      messageQueue.push({
        type: 'response.done',
        response: {
          output: [
            {type: 'function_call', name: 'f', call_id: 'c', arguments: '{bad'},
          ],
        },
      });

      await expect(generator.next()).rejects.toThrow(
        'Failed to parse arguments: {bad',
      );
    });

    it('maps speech_started to an interruption', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'input_audio_buffer.speech_started'});
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        interrupted: true,
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('maps a nested error event to an error response', async () => {
      const generator = newConnection().receive();

      messageQueue.push({
        type: 'error',
        error: {code: 'invalid_request_error', message: 'bad input'},
      });
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        errorCode: 'invalid_request_error',
        errorMessage: 'bad input',
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('maps a flat error event and defaults a missing code', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'error', message: 'oops'});
      messageQueue.close();

      expect((await generator.next()).value).toEqual({
        errorCode: 'UNKNOWN',
        errorMessage: 'oops',
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('ignores unrecognized server events', async () => {
      const generator = newConnection().receive();

      messageQueue.push({type: 'response.created'});
      messageQueue.push({type: 'input_audio_buffer.speech_started'});
      messageQueue.close();

      // The unknown event yields nothing; the next known event is surfaced.
      expect((await generator.next()).value).toEqual({
        interrupted: true,
        modelVersion: MODEL,
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('surfaces a socket error pushed onto the queue', async () => {
      const generator = newConnection().receive();

      messageQueue.error(new Error('socket boom'));

      await expect(generator.next()).rejects.toThrow('socket boom');
    });

    it('omits modelVersion when none was provided', async () => {
      const connection = new OpenAiRealtimeConnection(
        mockWs,
        undefined,
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push({type: 'input_audio_buffer.speech_started'});
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({interrupted: true});
      expect(
        (res.value as {modelVersion?: string}).modelVersion,
      ).toBeUndefined();
    });
  });

  describe('contentToRealtimeItems', () => {
    it('maps a user text part to an input_text message item', () => {
      expect(
        contentToRealtimeItems({role: 'user', parts: [{text: 'hi'}]}),
      ).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{type: 'input_text', text: 'hi'}],
        },
      ]);
    });

    it('maps the model role to assistant', () => {
      expect(
        contentToRealtimeItems({role: 'model', parts: [{text: 'yo'}]}),
      ).toEqual([
        {
          type: 'message',
          role: 'assistant',
          content: [{type: 'input_text', text: 'yo'}],
        },
      ]);
    });

    it('defaults a missing role to user', () => {
      expect(contentToRealtimeItems({parts: [{text: 'hey'}]})).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{type: 'input_text', text: 'hey'}],
        },
      ]);
    });

    it('maps audio inline data to input_audio', () => {
      expect(
        contentToRealtimeItems({
          role: 'user',
          parts: [{inlineData: {mimeType: 'audio/pcm', data: 'A'}}],
        }),
      ).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{type: 'input_audio', audio: 'A'}],
        },
      ]);
    });

    it('maps image inline data to an input_image data URL', () => {
      expect(
        contentToRealtimeItems({
          role: 'user',
          parts: [{inlineData: {mimeType: 'image/png', data: 'IMG'}}],
        }),
      ).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [
            {type: 'input_image', image_url: 'data:image/png;base64,IMG'},
          ],
        },
      ]);
    });

    it('maps file data with a URI to an input_image', () => {
      expect(
        contentToRealtimeItems({
          role: 'user',
          parts: [
            {fileData: {mimeType: 'image/png', fileUri: 'https://x/y.png'}},
          ],
        }),
      ).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{type: 'input_image', image_url: 'https://x/y.png'}],
        },
      ]);
    });

    it('maps a function call to a function_call item', () => {
      expect(
        contentToRealtimeItems({
          role: 'model',
          parts: [{functionCall: {id: 'c1', name: 'f', args: {a: 1}}}],
        }),
      ).toEqual([
        {
          type: 'function_call',
          name: 'f',
          call_id: 'c1',
          arguments: JSON.stringify({a: 1}),
        },
      ]);
    });

    it('serializes empty args for a function call without args', () => {
      expect(
        contentToRealtimeItems({
          role: 'model',
          parts: [{functionCall: {id: 'c1', name: 'f'}}],
        }),
      ).toEqual([
        {type: 'function_call', name: 'f', call_id: 'c1', arguments: '{}'},
      ]);
    });

    it('maps a function response to a function_call_output item', () => {
      expect(
        contentToRealtimeItems({
          parts: [{functionResponse: {id: 'c1', name: 'f', response: {ok: 1}}}],
        }),
      ).toEqual([
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({ok: 1}),
        },
      ]);
    });

    it('serializes empty output for a function response without a response', () => {
      expect(
        contentToRealtimeItems({parts: [{functionResponse: {id: 'c1'}}]}),
      ).toEqual([{type: 'function_call_output', call_id: 'c1', output: '{}'}]);
    });

    it('emits function items and a message item for mixed content', () => {
      expect(
        contentToRealtimeItems({
          role: 'user',
          parts: [
            {functionResponse: {id: 'c1', response: {ok: 1}}},
            {text: 'and here is context'},
          ],
        }),
      ).toEqual([
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({ok: 1}),
        },
        {
          type: 'message',
          role: 'user',
          content: [{type: 'input_text', text: 'and here is context'}],
        },
      ]);
    });

    it('returns nothing for unsupported parts', () => {
      expect(contentToRealtimeItems({role: 'user', parts: [{}]})).toEqual([]);
    });

    it('returns nothing when parts are absent', () => {
      expect(contentToRealtimeItems({role: 'user'})).toEqual([]);
    });
  });
});
