/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for behaviour the ported adk-python suite does not cover: base64 chunk
 * handling, the shape of the request the audio model receives, and the
 * injection seam that keeps `LLMRegistry` out of the way.
 */

import {
  DEFAULT_USER_SIMULATOR_AUDIO_MODEL,
  DEFAULT_USER_SIMULATOR_LANGUAGE_CODE,
  DEFAULT_USER_SIMULATOR_VOICE_NAME,
  LIVE_INPUT_MIME_TYPE,
  LLM_AUDIO_USER_SIMULATOR_TYPE,
  LlmAudioUserSimulator,
  parseLlmAudioUserSimulatorConfig,
  UserSimulatorStatus,
  type Event,
  type NextUserMessage,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {pcm, ramp} from '../../utils/pcm_fixtures.js';
import {
  decode,
  encode,
  ScriptedUserSimulator,
  textMessage,
} from './audio_simulator_fixtures.js';
import {FakeLlm} from './fake_llm.js';

const NO_EVENTS: Event[] = [];

function buildSimulator(result?: NextUserMessage) {
  const audioLlm = new FakeLlm();
  const simulator = new LlmAudioUserSimulator({
    config: parseLlmAudioUserSimulatorConfig({audioModel: 'test-audio-model'}),
    textSimulator: new ScriptedUserSimulator([result ?? textMessage('hello')]),
    audioLlm,
  });
  return {simulator, audioLlm};
}

describe('LlmAudioUserSimulator (adk-js specific)', () => {
  describe('audio chunk handling', () => {
    it('joins streamed chunks after decoding, not as base64 text', async () => {
      const {simulator, audioLlm} = buildSimulator();
      // Four bytes then two: neither decoded length is a multiple of three, so
      // each chunk's base64 carries padding. Joining the encoded strings would
      // leave that padding mid-payload. The bytes are also not valid UTF-8, so
      // a decode that returns a string corrupts them.
      const first = new Uint8Array([0xff, 0xfe, 0x01, 0x04]);
      const second = new Uint8Array([0x80, 0x90]);
      expect(encode(first)).toContain('=');
      expect(encode(second)).toContain('=');
      audioLlm.responses.push(
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: LIVE_INPUT_MIME_TYPE,
                  data: encode(first),
                },
              },
            ],
            role: 'user',
          },
        },
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: LIVE_INPUT_MIME_TYPE,
                  data: encode(second),
                },
              },
            ],
            role: 'user',
          },
        },
      );

      const content = await simulator.toAudioContent('hello');

      expect(decode(content.parts?.[1].inlineData?.data)).toEqual(
        new Uint8Array([0xff, 0xfe, 0x01, 0x04, 0x80, 0x90]),
      );
    });

    it('skips an inlineData part that carries no data', async () => {
      const {simulator, audioLlm} = buildSimulator();
      const audio = new Uint8Array([9, 8, 7, 6]);
      audioLlm.responses.push({
        content: {
          parts: [
            {inlineData: {mimeType: 'audio/l16;rate=24000'}},
            {inlineData: {mimeType: LIVE_INPUT_MIME_TYPE, data: encode(audio)}},
          ],
          role: 'user',
        },
      });

      const content = await simulator.toAudioContent('hello');

      expect(decode(content.parts?.[1].inlineData?.data)).toEqual(audio);
    });

    it('resamples using the last mime type when chunks disagree', async () => {
      const {simulator, audioLlm} = buildSimulator();
      audioLlm.responses.push(
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: LIVE_INPUT_MIME_TYPE,
                  data: encode(pcm(ramp(300))),
                },
              },
            ],
            role: 'user',
          },
        },
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/l16;rate=24000',
                  data: encode(pcm(ramp(300))),
                },
              },
            ],
            role: 'user',
          },
        },
      );

      const content = await simulator.toAudioContent('hello');

      // 600 samples read as 24 kHz become 400 at 16 kHz. Had the first chunk's
      // 16 kHz label won, the 1200 bytes would have passed through untouched.
      expect(decode(content.parts?.[1].inlineData?.data)).toHaveLength(800);
    });
  });

  describe('malformed model output', () => {
    it('reports an error code that arrives with no message', async () => {
      const {simulator, audioLlm} = buildSimulator();
      audioLlm.responses.push({errorCode: 'SAFETY'});

      await expect(simulator.toAudioContent('hello')).rejects.toThrow(
        'Audio generation failed: SAFETY — ',
      );
    });

    it('skips a response that carries no content', async () => {
      const {simulator, audioLlm} = buildSimulator();
      audioLlm.responses.push({}, {content: {role: 'user'}});

      await expect(simulator.toAudioContent('hello')).rejects.toThrow(
        'Audio model returned no audio data',
      );
    });
  });

  describe('the request the audio model receives', () => {
    it('carries the model, the audio config and the text to speak', async () => {
      const {simulator, audioLlm} = buildSimulator();
      audioLlm.responses.push({
        content: {
          parts: [
            {
              inlineData: {
                mimeType: LIVE_INPUT_MIME_TYPE,
                data: encode(new Uint8Array([1, 2])),
              },
            },
          ],
          role: 'user',
        },
      });

      await simulator.toAudioContent('speak this');

      const request = audioLlm.requests[0];
      expect(request.model).toBe('test-audio-model');
      expect(request.contents).toHaveLength(1);
      expect(request.contents[0].role).toBe('user');
      expect(request.contents[0].parts?.[0].text).toBe('speak this');
      const speechConfig = request.config?.speechConfig;
      if (typeof speechConfig !== 'object') {
        expect.fail('the audio config must carry a structured speechConfig');
      }
      expect(speechConfig.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(
        DEFAULT_USER_SIMULATOR_VOICE_NAME,
      );
      expect(speechConfig.languageCode).toBe(
        DEFAULT_USER_SIMULATOR_LANGUAGE_CODE,
      );
    });

    it('carries the default retry policy', async () => {
      const {simulator, audioLlm} = buildSimulator();
      audioLlm.responses.push({
        content: {
          parts: [
            {
              inlineData: {
                mimeType: LIVE_INPUT_MIME_TYPE,
                data: encode(new Uint8Array([1, 2])),
              },
            },
          ],
          role: 'user',
        },
      });

      await simulator.toAudioContent('hello');

      expect(
        audioLlm.requests[0].config?.httpOptions?.retryOptions?.attempts,
      ).toBeGreaterThan(0);
    });
  });

  describe('text extraction', () => {
    it('passes a SUCCESS result carrying no message straight through', async () => {
      const textResult: NextUserMessage = {
        status: UserSimulatorStatus.SUCCESS,
      };
      const {simulator, audioLlm} = buildSimulator(textResult);

      const result = await simulator.getNextUserMessage(NO_EVENTS);

      expect(result).toBe(textResult);
      expect(audioLlm.requests).toHaveLength(0);
    });

    it('does not speak a non-SUCCESS result that carries text', async () => {
      // The status guard alone must stop this. The empty-text guard cannot:
      // this result has text, so it would otherwise reach the audio model.
      const textResult: NextUserMessage = {
        status: UserSimulatorStatus.STOP_SIGNAL_DETECTED,
        userMessage: {parts: [{text: 'goodbye'}], role: 'user'},
      };
      const {simulator, audioLlm} = buildSimulator(textResult);
      // Queued so that a missing guard produces audio rather than an
      // incidental error.
      audioLlm.responses.push({
        content: {
          parts: [
            {
              inlineData: {
                mimeType: LIVE_INPUT_MIME_TYPE,
                data: encode(new Uint8Array([1, 2])),
              },
            },
          ],
          role: 'user',
        },
      });

      const result = await simulator.getNextUserMessage(NO_EVENTS);

      expect(result).toBe(textResult);
      expect(audioLlm.requests).toHaveLength(0);
    });

    it('ignores a part that carries no text', async () => {
      const {simulator, audioLlm} = buildSimulator({
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {
          parts: [
            {
              inlineData: {
                mimeType: 'image/png',
                data: encode(new Uint8Array([1])),
              },
            },
            {text: 'describe this'},
          ],
          role: 'user',
        },
      });
      audioLlm.responses.push({
        content: {
          parts: [
            {
              inlineData: {
                mimeType: LIVE_INPUT_MIME_TYPE,
                data: encode(new Uint8Array([1, 2])),
              },
            },
          ],
          role: 'user',
        },
      });

      await simulator.getNextUserMessage(NO_EVENTS);

      expect(audioLlm.requests[0].contents[0].parts?.[0].text).toBe(
        'describe this',
      );
    });

    it('concatenates the text of every part in order', async () => {
      const {simulator, audioLlm} = buildSimulator({
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {
          parts: [{text: 'Book me '}, {text: 'a flight '}, {text: 'today.'}],
          role: 'user',
        },
      });
      audioLlm.responses.push({
        content: {
          parts: [
            {
              inlineData: {
                mimeType: LIVE_INPUT_MIME_TYPE,
                data: encode(new Uint8Array([1, 2])),
              },
            },
          ],
          role: 'user',
        },
      });

      const result = await simulator.getNextUserMessage(NO_EVENTS);

      expect(result.userMessage?.parts?.[0].text).toBe(
        'Book me a flight today.',
      );
      expect(audioLlm.requests[0].contents[0].parts?.[0].text).toBe(
        'Book me a flight today.',
      );
    });
  });

  describe('a config that did not go through the parser', () => {
    it('applies the defaults to a plain object literal', async () => {
      const audioLlm = new FakeLlm();
      const simulator = new LlmAudioUserSimulator({
        config: {type: LLM_AUDIO_USER_SIMULATOR_TYPE},
        textSimulator: new ScriptedUserSimulator([
          {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED},
        ]),
        audioLlm,
      });
      audioLlm.responses.push({
        content: {
          parts: [
            {
              inlineData: {
                mimeType: LIVE_INPUT_MIME_TYPE,
                data: encode(new Uint8Array([1, 2])),
              },
            },
          ],
          role: 'user',
        },
      });

      const content = await simulator.toAudioContent('hello');

      // The parser fills these; a literal reaches the constructor's own
      // fallbacks instead.
      expect(content.parts).toHaveLength(2);
      const speechConfig = audioLlm.requests[0].config?.speechConfig;
      if (typeof speechConfig !== 'object') {
        expect.fail('the audio config must carry a structured speechConfig');
      }
      expect(speechConfig.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(
        DEFAULT_USER_SIMULATOR_VOICE_NAME,
      );
    });

    it('gives each simulator its own audio configuration object', async () => {
      const textSimulator = new ScriptedUserSimulator([
        {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED},
      ]);
      const first = new FakeLlm();
      const second = new FakeLlm();
      const audioPart = {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: LIVE_INPUT_MIME_TYPE,
                data: encode(new Uint8Array([1, 2])),
              },
            },
          ],
          role: 'user',
        },
      };
      first.responses.push(audioPart);
      second.responses.push(audioPart);

      await new LlmAudioUserSimulator({
        config: {type: LLM_AUDIO_USER_SIMULATOR_TYPE},
        textSimulator,
        audioLlm: first,
      }).toAudioContent('hello');
      await new LlmAudioUserSimulator({
        config: {type: LLM_AUDIO_USER_SIMULATOR_TYPE},
        textSimulator,
        audioLlm: second,
      }).toAudioContent('hello');

      // The retry policy is stamped into the config object. A shared default
      // would make these the same object.
      expect(first.requests[0].config).not.toBe(second.requests[0].config);
    });
  });

  describe('the audio model injection seam', () => {
    it('does not consult LLMRegistry when an audioLlm is injected', () => {
      const config = parseLlmAudioUserSimulatorConfig({});
      expect(config.audioModel).toBe(DEFAULT_USER_SIMULATOR_AUDIO_MODEL);

      // adk-js registers no Cloud Text-to-Speech model, so resolving the
      // default through the registry throws. Constructing without a throw is
      // what proves the registry was never asked.
      expect(
        () =>
          new LlmAudioUserSimulator({
            config,
            textSimulator: new ScriptedUserSimulator([
              {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED},
            ]),
            audioLlm: new FakeLlm(),
          }),
      ).not.toThrow();
    });

    it('resolves the configured model through LLMRegistry when none is injected', () => {
      expect(
        () =>
          new LlmAudioUserSimulator({
            config: parseLlmAudioUserSimulatorConfig({}),
            textSimulator: new ScriptedUserSimulator([
              {status: UserSimulatorStatus.STOP_SIGNAL_DETECTED},
            ]),
          }),
      ).toThrow(/cloud_tts/);
    });
  });
});
