/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleLLMVariant, LlmResponse, RealtimeInput} from '@google/adk';
import {
  Blob,
  Content,
  GroundingMetadata,
  LiveServerGoAway,
  LiveServerMessage,
  LiveServerSessionResumptionUpdate,
  Part,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GeminiLlmConnection} from '../../src/models/gemini_llm_connection.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {logger} from '../../src/utils/logger.js';
import {liveServerMessage} from '../utils/live_server_message_test_utils.js';

describe('GeminiLlmConnection', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockSession: any;
  let messageQueue: AsyncQueue<LiveServerMessage>;

  beforeEach(() => {
    mockSession = {
      sendClientContent: vi.fn(),
      sendToolResponse: vi.fn(),
      sendRealtimeInput: vi.fn(),
      close: vi.fn(),
    };
    messageQueue = new AsyncQueue<LiveServerMessage>();
  });

  describe('sendHistory', () => {
    it('should send history with turnComplete based on role for non-Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const history: Content[] = [
        {role: 'user', parts: [{text: 'hello'}]},
        {role: 'model', parts: [{text: 'hi'}]},
      ];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: history,
        turnComplete: false, // last is model
      });
    });

    it('should send history with turnComplete based on role for Gemini 3.x, and not trigger a response', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const history: Content[] = [
        {role: 'user', parts: [{text: 'hello'}]},
        {role: 'model', parts: [{text: 'hi'}]},
      ];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: history,
        turnComplete: false, // last is model
      });
      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
    });

    it('should not send history if empty', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.sendHistory([]);
      expect(mockSession.sendClientContent).not.toHaveBeenCalled();
    });

    it.each([
      ['inlineData', {inlineData: {mimeType: 'audio/pcm', data: 'AAD/AP8='}}],
      [
        'fileData',
        {
          fileData: {
            mimeType: 'audio/pcm',
            fileUri: 'artifact://app/user/session/_adk_live/audio.pcm#1',
          },
        },
      ],
    ])(
      'should filter out an audio-only turn carried by %s',
      async (_name, audioPart: Part) => {
        const connection = new GeminiLlmConnection(mockSession);
        const history: Content[] = [
          {role: 'user', parts: [audioPart]},
          {role: 'model', parts: [{text: 'I heard you'}]},
        ];

        await connection.sendHistory(history);

        expect(mockSession.sendClientContent).toHaveBeenCalledWith({
          turns: [{role: 'model', parts: [{text: 'I heard you'}]}],
          turnComplete: false,
        });
      },
    );

    it('should keep image data in history', async () => {
      const connection = new GeminiLlmConnection(mockSession);
      const imagePart: Part = {
        inlineData: {mimeType: 'image/png', data: 'iVBORw0KGgo='},
      };
      const history: Content[] = [
        {role: 'user', parts: [imagePart]},
        {role: 'model', parts: [{text: 'Nice image!'}]},
      ];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: history,
        turnComplete: false,
      });
    });

    it('should keep the non-audio parts of a mixed turn', async () => {
      const connection = new GeminiLlmConnection(mockSession);
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            {inlineData: {mimeType: 'audio/wav', data: 'AAD/AP8='}},
            {text: 'transcribed text'},
          ],
        },
      ];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [{role: 'user', parts: [{text: 'transcribed text'}]}],
        turnComplete: true,
      });
    });

    it('should send nothing when every turn is audio only', async () => {
      const connection = new GeminiLlmConnection(mockSession);
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            {inlineData: {mimeType: 'audio/pcm', data: 'AAD/AP8='}},
            {
              fileData: {
                mimeType: 'audio/wav',
                fileUri: 'artifact://audio.pcm#1',
              },
            },
          ],
        },
      ];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).not.toHaveBeenCalled();
    });

    it.each(['audio/pcm', 'audio/wav', 'audio/mp3', 'audio/ogg'])(
      'should filter out %s parts',
      async (mimeType) => {
        const connection = new GeminiLlmConnection(mockSession);
        const history: Content[] = [
          {role: 'user', parts: [{inlineData: {mimeType, data: ''}}]},
        ];

        await connection.sendHistory(history);

        expect(mockSession.sendClientContent).not.toHaveBeenCalled();
      },
    );

    it('should derive turnComplete from the filtered history', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live-preview',
      );
      const audioPart: Part = {
        inlineData: {mimeType: 'audio/pcm', data: 'AAD/AP8='},
      };

      // The trailing user turn is audio only, so a model turn ends the
      // filtered history.
      await connection.sendHistory([
        {role: 'user', parts: [{text: 'hi'}]},
        {role: 'model', parts: [{text: 'hello'}]},
        {role: 'user', parts: [audioPart]},
      ]);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [
          {role: 'user', parts: [{text: 'hi'}]},
          {role: 'model', parts: [{text: 'hello'}]},
        ],
        turnComplete: false,
      });

      mockSession.sendClientContent.mockClear();

      // The trailing model turn is audio only, so a user turn ends the
      // filtered history.
      await connection.sendHistory([
        {role: 'user', parts: [{text: 'hi'}]},
        {role: 'model', parts: [audioPart]},
      ]);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [{role: 'user', parts: [{text: 'hi'}]}],
        turnComplete: true,
      });
    });

    it('should trigger the Gemini 3.x Live response after the history', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live-preview',
      );
      const history: Content[] = [
        {role: 'user', parts: [{text: 'hi'}]},
        {role: 'model', parts: [{text: 'hello'}]},
        {role: 'user', parts: [{text: 'how are you?'}]},
      ];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: history,
        turnComplete: true,
      });
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({text: '.'});
      // The trigger must come after the history, otherwise the model responds
      // before it has seen the replayed turns.
      expect(
        mockSession.sendClientContent.mock.invocationCallOrder[0],
      ).toBeLessThan(mockSession.sendRealtimeInput.mock.invocationCallOrder[0]);
    });

    it('should make the Gemini 3.x Live trigger follow the filtered history', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live-preview',
      );
      const audioPart: Part = {
        inlineData: {mimeType: 'audio/pcm', data: 'AAD/AP8='},
      };

      // A model turn ends the filtered history, so nothing triggers.
      await connection.sendHistory([
        {role: 'user', parts: [{text: 'hi'}]},
        {role: 'model', parts: [{text: 'hello'}]},
        {role: 'user', parts: [audioPart]},
      ]);

      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();

      // A user turn ends the filtered history, so the trigger is sent.
      await connection.sendHistory([
        {role: 'user', parts: [{text: 'hi'}]},
        {role: 'model', parts: [audioPart]},
      ]);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({text: '.'});
    });

    it('should not trigger a Gemini 3.x Live response for an empty history', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live-preview',
      );

      await connection.sendHistory([]);

      expect(mockSession.sendClientContent).not.toHaveBeenCalled();
      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
    });

    it.each([
      'gemini-2.5-flash-native-audio-preview-12-2025',
      'gemini-3.5-live-translate-preview',
    ])('should not trigger a response for %s', async (modelVersion) => {
      const connection = new GeminiLlmConnection(mockSession, modelVersion);
      const history: Content[] = [{role: 'user', parts: [{text: 'hi'}]}];

      await connection.sendHistory(history);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: history,
        turnComplete: true,
      });
      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
    });
  });

  describe('sendContent', () => {
    it('should send tool response if first part is functionResponse', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {
        parts: [
          {
            functionResponse: {
              name: 'tool_a',
              response: {result: 'ok'},
              id: '1',
            },
          },
        ],
      };

      await connection.sendContent(content);

      expect(mockSession.sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [content.parts![0].functionResponse],
      });
    });

    it('should use sendRealtimeInput for Gemini 3.x single-part text', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const content: Content = {
        parts: [{text: 'hello'}],
      };

      await connection.sendContent(content);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        text: 'hello',
      });
    });

    it('should use sendClientContent for non-Gemini 3.x single-part text', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {
        parts: [{text: 'hello'}],
      };

      await connection.sendContent(content);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [content],
        turnComplete: true,
      });
    });

    it('should throw error if content has no parts', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await expect(connection.sendContent({})).rejects.toThrow(
        'Content must have parts.',
      );
    });

    it('should send every function response of a tool-only content', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool_a', response: {r: 1}, id: '1'}},
          {functionResponse: {name: 'tool_b', response: {r: 2}, id: '2'}},
        ],
      };

      await connection.sendContent(content);

      expect(mockSession.sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [
          content.parts![0].functionResponse,
          content.parts![1].functionResponse,
        ],
      });
    });

    it('should send a mixed function-response and text content as client content', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {
        role: 'user',
        parts: [
          {functionResponse: {name: 'tool_a', response: {r: 1}, id: '1'}},
          {text: 'and here is why'},
        ],
      };

      await connection.sendContent(content);

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [content],
        turnComplete: true,
      });
      expect(mockSession.sendToolResponse).not.toHaveBeenCalled();
    });

    it('should keep the turn open for a partial content', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {role: 'user', parts: [{text: 'progress'}]};

      await connection.sendContent(content, {partial: true});

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [content],
        turnComplete: false,
      });
    });

    it('should send partial Gemini 3.x text as client content, not realtime input', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live-preview',
      );
      const content: Content = {role: 'user', parts: [{text: 'progress'}]};

      await connection.sendContent(content, {partial: true});

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [content],
        turnComplete: false,
      });
      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
    });
  });

  describe('sendRealtime', () => {
    it('should use sendRealtimeInput with media for non-Gemini 3.x/non-Native-Audio', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const blob: Blob = {mimeType: 'audio/pcm', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        media: blob,
      });
    });

    it('should use sendRealtimeInput with audio for Gemini 3.x audio', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const blob: Blob = {mimeType: 'audio/pcm', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        audio: blob,
      });
    });

    it('should use sendRealtimeInput with video for Gemini 3.x image', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const blob: Blob = {mimeType: 'image/jpeg', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        video: blob,
      });
    });

    it('should use sendRealtimeInput with media for Native Audio model audio', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash-preview-native-audio',
      );
      const blob: Blob = {mimeType: 'audio/pcm', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        media: blob,
      });
    });

    it('should use sendRealtimeInput with audio for Live Translate audio', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.5-live-translate-preview',
      );
      const blob: Blob = {mimeType: 'audio/pcm', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        audio: blob,
      });
    });

    it('should use sendRealtimeInput with video for Live Translate image', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.5-live-translate-preview',
      );
      const blob: Blob = {mimeType: 'image/jpeg', data: 'base64data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        video: blob,
      });
    });

    it('should forward the end of the audio stream', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await connection.sendRealtime({audioStreamEnd: true});

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        audioStreamEnd: true,
      });
    });

    it('should forward an activity start signal', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await connection.sendRealtime({activityStart: {}});

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        activityStart: {},
      });
    });

    it('should forward an activity end signal', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await connection.sendRealtime({activityEnd: {}});

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        activityEnd: {},
      });
    });

    it('should warn and send nothing for an unclassifiable realtime input', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await connection.sendRealtime({});

      expect(warnSpy).toHaveBeenCalledWith(
        'Unary LiveClientRealtimeInput not fully supported yet.',
      );
      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should reject an input that is not an object', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const notAnInput: unknown = 'audio';

      await expect(
        connection.sendRealtime(notAnInput as RealtimeInput),
      ).rejects.toThrow(/Unsupported input type/);
      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
    });

    it('should warn and not send if unknown mime type for Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const blob: Blob = {mimeType: 'text/plain', data: 'data'};

      await connection.sendRealtime(blob);

      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
    });

    it('should forward an activityStart signal', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await connection.sendRealtime({activityStart: {}});

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        activityStart: {},
      });
    });

    it('should forward an activityEnd signal', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await connection.sendRealtime({activityEnd: {}});

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        activityEnd: {},
      });
    });

    it('should forward an audioStreamEnd signal', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await connection.sendRealtime({audioStreamEnd: true});

      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        audioStreamEnd: true,
      });
    });

    it('should warn and send nothing for an empty realtime input', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await connection.sendRealtime({});

      expect(warnSpy).toHaveBeenCalledWith(
        'Unary LiveClientRealtimeInput not fully supported yet.',
      );
      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it.each([
      ['null', null],
      ['a string', 'audio'],
      ['a number', 42],
      ['an object with unknown fields', {frames: ['a']}],
    ])('should throw for %s', async (_name, notAnInput: unknown) => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      await expect(
        connection.sendRealtime(notAnInput as RealtimeInput),
      ).rejects.toThrow(/Unsupported input type/);
      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
    });
  });

  describe('apiBackend', () => {
    it('should default to Vertex AI', () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );

      expect(connection.apiBackend).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should report the backend it was constructed with', () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
        GoogleLLMVariant.GEMINI_API,
      );

      expect(connection.apiBackend).toBe(GoogleLLMVariant.GEMINI_API);
    });
  });

  describe('sendActivityStart', () => {
    it('should send activityStart client message', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.sendActivityStart();
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        activityStart: {},
      });
    });
  });

  describe('sendActivityEnd', () => {
    it('should send activityEnd client message', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.sendActivityEnd();
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        activityEnd: {},
      });
    });
  });

  describe('sendAudioStreamEnd', () => {
    it('should send audioStreamEnd client message', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.sendAudioStreamEnd();
      expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
        audioStreamEnd: true,
      });
    });
  });

  describe('sendContent partial turns', () => {
    it('should leave the turn open for a partial update', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {role: 'user', parts: [{text: 'half a '}]};

      await connection.sendContent(content, {partial: true});

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [content],
        turnComplete: false,
      });
    });

    it('should keep sendClientContent for a partial Gemini 3.x text turn', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
      );
      const content: Content = {role: 'user', parts: [{text: 'half a '}]};

      await connection.sendContent(content, {partial: true});

      expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [content],
        turnComplete: false,
      });
    });

    it('should complete the turn for an explicit partial false', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const content: Content = {role: 'user', parts: [{text: 'whole turn'}]};

      await connection.sendContent(content, {partial: false});

      expect(mockSession.sendClientContent).toHaveBeenCalledWith({
        turns: [content],
        turnComplete: true,
      });
    });
  });

  describe('close', () => {
    it('should close the session', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      await connection.close();
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('receive', () => {
    it('should throw error if message queue is not provided', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
      );
      const generator = connection.receive();
      await expect(generator.next()).rejects.toThrow(
        'Message queue is not initialized.',
      );
    });

    it('should put the live session id on every response', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({setupComplete: {sessionId: 'test-session-id'}}),
      );
      messageQueue.push(
        liveServerMessage({
          serverContent: {modelTurn: {parts: [{text: 'hello'}]}},
        }),
      );
      messageQueue.push(
        liveServerMessage({serverContent: {turnComplete: true}}),
      );
      messageQueue.push(
        liveServerMessage({usageMetadata: {totalTokenCount: 30}}),
      );
      messageQueue.close();

      const responses: LlmResponse[] = [];
      for await (const response of generator) {
        responses.push(response);
      }

      expect(responses.length).toBeGreaterThan(0);
      for (const response of responses) {
        expect(response.liveSessionId).toBe('test-session-id');
      }
    });

    it('should omit the live session id when the server never reports one', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(liveServerMessage({setupComplete: {}}));
      messageQueue.push(
        liveServerMessage({usageMetadata: {totalTokenCount: 30}}),
      );
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).not.toHaveProperty('liveSessionId');
      expect((await generator.next()).done).toBe(true);
    });

    it('should put the live session id on a response flushed at close', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({setupComplete: {sessionId: 'test-session-id'}}),
      );
      messageQueue.push(
        liveServerMessage({
          toolCall: {functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}]},
        }),
      );
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
        liveSessionId: 'test-session-id',
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('should yield usage metadata', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      const usageMetadata = {
        promptTokenCount: 10,
        responseTokenCount: 20,
        totalTokenCount: 30,
      };
      messageQueue.push(liveServerMessage({usageMetadata}));
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
        },
        modelVersion: 'gemini-2.5-flash',
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('should stream text and yield full response on turnComplete', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      // Chunk 1: partial text
      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Hello'}],
            },
          },
        }),
      );

      // Chunk 2: partial text and turnComplete with interrupted and groundingMetadata
      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: ' world!'}],
            },
            turnComplete: true,
            interrupted: false,
            groundingMetadata: {groundingChunks: []} as GroundingMetadata,
          },
        }),
      );

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Hello'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      // The ' world!' part is folded into the flushed full text, so the
      // accumulated text is the next response, including groundingMetadata.
      const res2 = await generator.next();
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Hello world!'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
        groundingMetadata: {groundingChunks: []},
      });

      // Then it yields the turnComplete status with interrupted and groundingMetadata
      const res3 = await generator.next();
      expect(res3.value).toEqual({
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
        interrupted: false,
        groundingMetadata: {groundingChunks: []},
      });

      messageQueue.close();
      expect((await generator.next()).done).toBe(true);
    });

    it('should flush text when transitioning between thought and non-thought', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      // Chunk 1: thought
      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Thinking...', thought: true}],
            },
          },
        }),
      );

      // Chunk 2: transition to text
      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Answer is 42.'}],
            },
          },
        }),
      );

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            turnComplete: true,
          },
        }),
      );

      const res1 = await generator.next(); // yields partial thought
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Thinking...', thought: true}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res2 = await generator.next(); // transitions, flushes 'Thinking...' as full thought
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Thinking...', thought: true}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next(); // yields partial text 'Answer is 42.'
      expect(res3.value).toEqual({
        content: {parts: [{text: 'Answer is 42.'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res4 = await generator.next(); // turnComplete flushes 'Answer is 42.' as full text
      expect(res4.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Answer is 42.'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res5 = await generator.next(); // yields turnComplete
      expect(res5.value).toEqual({
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      });

      messageQueue.close();
      expect((await generator.next()).done).toBe(true);
    });

    it('should handle input transcription partial and finished', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: 'hello', finished: false},
          },
        }),
      );

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: ' world', finished: true},
          },
        }),
      );

      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        inputTranscription: {text: 'hello', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        inputTranscription: {text: ' world', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next();
      expect(res3.value).toEqual({
        inputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should flush pending transcription on interrupted', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            inputTranscription: {text: 'hello', finished: false},
          },
        }),
      );

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            interrupted: true,
          },
        }),
      );
      messageQueue.close();

      const res1 = await generator.next(); // partial transcription
      if (res1.done) {
        throw new Error('Expected a partial transcription response.');
      }
      expect(res1.value.inputTranscription).toEqual({
        text: 'hello',
        finished: false,
      });

      const res2 = await generator.next(); // flush transcription on interrupted
      expect(res2.value).toEqual({
        inputTranscription: {text: 'hello', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next(); // interrupted status
      expect(res3.value).toEqual({
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield groundingMetadata on partial response if turnComplete is not true', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Partial text'}],
            },
            groundingMetadata: {
              groundingChunks: [
                {web: {uri: 'https://google.com', title: 'Google'}},
              ],
            } as GroundingMetadata,
          },
        }),
      );
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Partial text'}]},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
        groundingMetadata: {
          groundingChunks: [
            {web: {uri: 'https://google.com', title: 'Google'}},
          ],
        },
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield standalone groundingMetadata when content is empty and turnComplete is not true', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            groundingMetadata: {
              groundingChunks: [
                {web: {uri: 'https://google.com', title: 'Google'}},
              ],
            } as GroundingMetadata,
            turnComplete: false,
            interrupted: false,
          },
        }),
      );
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        groundingMetadata: {
          groundingChunks: [
            {web: {uri: 'https://google.com', title: 'Google'}},
          ],
        },
        interrupted: false,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should flush accumulated text when receiving a non-text modelTurn part', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      // Push text part
      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Hello'}],
            },
          },
        }),
      );

      // Push non-text part (e.g. functionCall inside modelTurn parts)
      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
            },
          },
        }),
      );
      messageQueue.close();

      // First yield: the partial response for 'Hello'
      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Hello'}]},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      // Second yield: should flush 'Hello' as a full text response
      const res2 = await generator.next();
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Hello'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      // Third yield: the modelTurn response with the functionCall
      const res3 = await generator.next();
      expect(res3.value).toEqual({
        content: {
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should buffer tool calls and yield at turnComplete for non-Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          toolCall: {
            functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
          },
        }),
      );

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            turnComplete: true,
          },
        }),
      );

      // For non-Gemini 3.x, tool call is buffered.
      // So we don't get anything on toolCall message (except if there was text, but there isn't).
      // On turnComplete, it should yield the aggregated tool calls first, then turnComplete.
      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        turnComplete: true,
        modelVersion: 'gemini-2.5-flash',
      });

      messageQueue.close();
      expect((await generator.next()).done).toBe(true);
    });

    it('should yield tool calls immediately for Gemini 3.x', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-3.1-flash-live',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          toolCall: {
            functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
          },
        }),
      );

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-3.1-flash-live',
      });

      messageQueue.close();
      expect((await generator.next()).done).toBe(true);
    });

    it('should yield session resumption update', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      const resumptionUpdate: LiveServerSessionResumptionUpdate = {
        resumable: true,
      };
      messageQueue.push(
        liveServerMessage({sessionResumptionUpdate: resumptionUpdate}),
      );
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        liveSessionResumptionUpdate: resumptionUpdate,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield go away', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      const goAway: LiveServerGoAway = {timeLeft: '10s'};
      messageQueue.push(liveServerMessage({goAway}));
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        goAway,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield pending tool calls on queue close', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          toolCall: {
            functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
          },
        }),
      );
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      });
      expect((await generator.next()).done).toBe(true);
    });

    it('should handle undefined modelVersion in isGemini3xFlashLive check', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        undefined,
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          toolCall: {
            functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
          },
        }),
      );
      messageQueue.close();

      const res = await generator.next();
      expect(res.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield accumulated text on interrupted', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Hello'}],
            },
          },
        }),
      );

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            interrupted: true,
          },
        }),
      );
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Hello'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Hello'}],
        },
        partial: false,
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should yield accumulated text on tool call', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            modelTurn: {
              parts: [{text: 'Hello'}],
            },
          },
        }),
      );

      messageQueue.push(
        liveServerMessage({
          toolCall: {
            functionCalls: [{name: 'tool_a', args: {x: 1}, id: '1'}],
          },
        }),
      );
      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        content: {parts: [{text: 'Hello'}]},
        modelVersion: 'gemini-2.5-flash',
        partial: true,
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        content: {
          role: 'model',
          parts: [{text: 'Hello'}],
        },
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next();
      expect(res3.value).toEqual({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool_a', args: {x: 1}, id: '1'}}],
        },
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should handle output transcription partial and finished', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            outputTranscription: {text: 'hello', finished: false},
          },
        }),
      );

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            outputTranscription: {text: ' world', finished: true},
          },
        }),
      );

      messageQueue.close();

      const res1 = await generator.next();
      expect(res1.value).toEqual({
        outputTranscription: {text: 'hello', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        outputTranscription: {text: ' world', finished: false},
        partial: true,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next();
      expect(res3.value).toEqual({
        outputTranscription: {text: 'hello world', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });

    it('should flush pending output transcription on interrupted', async () => {
      const connection = new GeminiLlmConnection(
        mockSession,
        'gemini-2.5-flash',
        messageQueue,
      );
      const generator = connection.receive();

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            outputTranscription: {text: 'hello', finished: false},
          },
        }),
      );

      messageQueue.push(
        liveServerMessage({
          serverContent: {
            interrupted: true,
          },
        }),
      );
      messageQueue.close();

      const res1 = await generator.next();
      if (res1.done) {
        throw new Error('Expected a partial transcription response.');
      }
      expect(res1.value.outputTranscription).toEqual({
        text: 'hello',
        finished: false,
      });

      const res2 = await generator.next();
      expect(res2.value).toEqual({
        outputTranscription: {text: 'hello', finished: true},
        partial: false,
        modelVersion: 'gemini-2.5-flash',
      });

      const res3 = await generator.next();
      expect(res3.value).toEqual({
        interrupted: true,
        modelVersion: 'gemini-2.5-flash',
      });

      expect((await generator.next()).done).toBe(true);
    });
  });
});
