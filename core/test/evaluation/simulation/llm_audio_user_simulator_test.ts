/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/evaluation/simulation/test_llm_audio_user_simulator.py`
 * from google/adk-python at commit a119dd77. Each ported `it` keeps the name of
 * the Python test it ports; the `adk-js specific` group at the end covers
 * behaviour the reference suite does not.
 */

import {
  createEvent,
  DEFAULT_USER_SIMULATOR_AUDIO_MODEL,
  DEFAULT_USER_SIMULATOR_LANGUAGE_CODE,
  DEFAULT_USER_SIMULATOR_VOICE_NAME,
  InputValidationError,
  LIVE_INPUT_MIME_TYPE,
  LLM_AUDIO_USER_SIMULATOR_TYPE,
  LlmAudioUserSimulator,
  parseLlmAudioUserSimulatorConfig,
  StaticUserSimulator,
  UserSimulatorStatus,
  type Event,
  type NextUserMessage,
  type UserSimulator,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {pcm, ramp} from '../../utils/pcm_fixtures.js';
import {
  audioResponse,
  decode,
  encode,
  ScriptedUserSimulator,
  textMessage,
} from './audio_simulator_fixtures.js';
import {FakeLlm} from './fake_llm.js';

const INPUT_EVENTS: Event[] = [
  createEvent({
    author: 'user',
    content: {parts: [{text: 'Can you help me?'}], role: 'user'},
    invocationId: 'inv1',
  }),
];

/** Builds a simulator wrapping a scripted text simulator and a fake model. */
function buildSimulator(params: {
  textResults?: NextUserMessage[];
  textSimulator?: UserSimulator;
  includeTextWithAudio?: boolean;
}) {
  const audioLlm = new FakeLlm();
  const textSimulator =
    params.textSimulator ??
    new ScriptedUserSimulator(
      params.textResults ?? [textMessage('Book me a flight.')],
    );
  const simulator = new LlmAudioUserSimulator({
    config: parseLlmAudioUserSimulatorConfig({
      audioModel: 'test-audio-model',
      ...(params.includeTextWithAudio === undefined
        ? {}
        : {includeTextWithAudio: params.includeTextWithAudio}),
    }),
    textSimulator,
    audioLlm,
  });
  return {simulator, audioLlm, textSimulator};
}

describe('LlmAudioUserSimulator', () => {
  describe('config', () => {
    it('test_config_defaults', () => {
      const config = parseLlmAudioUserSimulatorConfig({});

      expect(config.type).toBe('llm_audio');
      expect(config.model).toBe('gemini-2.5-flash');
      expect(config.audioModel).toBe('cloud_tts');
      expect(config.includeTextWithAudio).toBe(true);
    });

    it('test_config_custom_instructions_validation', () => {
      expect(
        parseLlmAudioUserSimulatorConfig({customInstructions: undefined})
          .customInstructions,
      ).toBeUndefined();

      const validInstructions =
        '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}';
      expect(
        parseLlmAudioUserSimulatorConfig({
          customInstructions: validInstructions,
        }).customInstructions,
      ).toBe(validInstructions);

      expect(() =>
        parseLlmAudioUserSimulatorConfig({
          customInstructions: 'missing formatting placeholders',
        }),
      ).toThrow(InputValidationError);
    });
  });

  describe('construction', () => {
    // Adapted: adk-js forbids reading a private member from a test, so this
    // asserts the composition through behaviour instead.
    it('test_init_composes_text_simulator_and_audio_llm', async () => {
      const {simulator, audioLlm, textSimulator} = buildSimulator({});
      audioLlm.responses.push(audioResponse('WAV'));

      await simulator.getNextUserMessage(INPUT_EVENTS);

      expect((textSimulator as ScriptedUserSimulator).callCount).toBe(1);
      expect(audioLlm.requests).toHaveLength(1);
      expect(audioLlm.requests[0].model).toBe('test-audio-model');
    });

    it('test_init_with_static_user_simulator', async () => {
      const {simulator, audioLlm} = buildSimulator({
        textSimulator: new StaticUserSimulator([
          {
            invocationId: 'inv1',
            userContent: {parts: [{text: 'Hello!'}], role: 'user'},
          },
        ]),
      });
      audioLlm.responses.push(audioResponse('WAV'));

      const result = await simulator.getNextUserMessage(INPUT_EVENTS);

      expect(result.status).toBe(UserSimulatorStatus.SUCCESS);
      expect(result.userMessage?.parts?.[0].text).toBe('Hello!');
      expect(audioLlm.requests[0].contents[0].parts?.[0].text).toBe('Hello!');
    });
  });

  describe('getNextUserMessage', () => {
    it('test_success_with_text_and_audio', async () => {
      const {simulator, audioLlm} = buildSimulator({});
      audioLlm.responses.push(audioResponse('WAV', 'audio/pcm'));

      const result = await simulator.getNextUserMessage(INPUT_EVENTS);

      expect(result.status).toBe(UserSimulatorStatus.SUCCESS);
      expect(result.userMessage?.role).toBe('user');
      expect(result.userMessage?.parts).toHaveLength(2);
      expect(result.userMessage?.parts?.[0].text).toBe('Book me a flight.');
      const audioPart = result.userMessage?.parts?.[1];
      expect(decode(audioPart?.inlineData?.data)).toEqual(
        new Uint8Array(Buffer.from('WAV')),
      );
      expect(audioPart?.inlineData?.mimeType).toBe(LIVE_INPUT_MIME_TYPE);
    });

    it('test_success_audio_only', async () => {
      const {simulator, audioLlm} = buildSimulator({
        includeTextWithAudio: false,
      });
      audioLlm.responses.push(audioResponse('WAV'));

      const result = await simulator.getNextUserMessage(INPUT_EVENTS);

      expect(result.status).toBe(UserSimulatorStatus.SUCCESS);
      expect(result.userMessage?.parts).toHaveLength(1);
      expect(decode(result.userMessage?.parts?.[0].inlineData?.data)).toEqual(
        new Uint8Array(Buffer.from('WAV')),
      );
    });

    it('test_passthrough_non_success_status', async () => {
      const textResult: NextUserMessage = {
        status: UserSimulatorStatus.TURN_LIMIT_REACHED,
      };
      const {simulator, audioLlm} = buildSimulator({textResults: [textResult]});

      const result = await simulator.getNextUserMessage(INPUT_EVENTS);

      expect(result).toBe(textResult);
      expect(audioLlm.requests).toHaveLength(0);
    });

    it('test_passthrough_empty_text', async () => {
      const textResult: NextUserMessage = {
        status: UserSimulatorStatus.SUCCESS,
        userMessage: {parts: [], role: 'user'},
      };
      const {simulator, audioLlm} = buildSimulator({textResults: [textResult]});

      const result = await simulator.getNextUserMessage(INPUT_EVENTS);

      expect(result).toBe(textResult);
      expect(audioLlm.requests).toHaveLength(0);
    });
  });

  describe('generateAudio', () => {
    // Adapted: `generateAudio` is private, so these drive it through the
    // public `toAudioContent`.
    it('test_returns_bytes_and_mime_type', async () => {
      const {simulator, audioLlm} = buildSimulator({});
      // 24 kHz in the mime type is what makes the resample observable: the
      // reported rate, not the default, drove the output length.
      audioLlm.responses.push(
        audioResponse(pcm([0, 100, 200, 300]), 'audio/l16;rate=24000'),
      );

      const content = await simulator.toAudioContent('hello');

      const audio = decode(content.parts?.[1].inlineData?.data);
      expect(audio).toHaveLength(4);
      expect(new DataView(audio.buffer).getInt16(2, true)).toBe(150);
    });

    it('test_error_code_raises', async () => {
      const {simulator, audioLlm} = buildSimulator({});
      audioLlm.responses.push({errorCode: 'SAFETY', errorMessage: 'blocked'});

      await expect(simulator.toAudioContent('hello')).rejects.toThrow(
        /Audio generation failed: SAFETY/,
      );
    });

    it('test_no_audio_data_raises', async () => {
      const {simulator, audioLlm} = buildSimulator({});
      audioLlm.responses.push({
        content: {parts: [{text: 'not audio'}], role: 'user'},
      });

      await expect(simulator.toAudioContent('hello')).rejects.toThrow(
        /Audio model returned no audio data/,
      );
    });
  });

  describe('toAudioContent', () => {
    it('test_to_audio_content', async () => {
      const {simulator, audioLlm} = buildSimulator({});
      audioLlm.responses.push(audioResponse('WAV', 'audio/pcm'));

      const content = await simulator.toAudioContent('Hello there');

      expect(content.role).toBe('user');
      expect(content.parts).toHaveLength(2);
      expect(content.parts?.[0].text).toBe('Hello there');
      expect(decode(content.parts?.[1].inlineData?.data)).toEqual(
        new Uint8Array(Buffer.from('WAV')),
      );
    });

    it('test_to_audio_content_resamples_to_live_input_rate', async () => {
      const {simulator, audioLlm} = buildSimulator({});
      const ttsPcm = pcm(Array.from({length: 600}, (_unused, i) => i));
      audioLlm.responses.push(audioResponse(ttsPcm, 'audio/l16;rate=24000'));

      const content = await simulator.toAudioContent('Hello there');

      const audioPart = content.parts?.[1];
      expect(audioPart?.inlineData?.mimeType).toBe(LIVE_INPUT_MIME_TYPE);
      expect(decode(audioPart?.inlineData?.data)).toHaveLength(400 * 2);
    });
  });

  describe('misc', () => {
    it('test_get_simulation_evaluator_not_implemented', () => {
      const {simulator} = buildSimulator({});

      expect(() => simulator.getSimulationEvaluator()).toThrow(
        'LlmAudioUserSimulator has no simulation evaluator.',
      );
    });
  });
});

const NO_EVENTS: Event[] = [];

function buildScriptedSimulator(result?: NextUserMessage) {
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
      const {simulator, audioLlm} = buildScriptedSimulator();
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
      const {simulator, audioLlm} = buildScriptedSimulator();
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
      const {simulator, audioLlm} = buildScriptedSimulator();
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
      const {simulator, audioLlm} = buildScriptedSimulator();
      audioLlm.responses.push({errorCode: 'SAFETY'});

      await expect(simulator.toAudioContent('hello')).rejects.toThrow(
        'Audio generation failed: SAFETY — ',
      );
    });

    it('skips a response that carries no content', async () => {
      const {simulator, audioLlm} = buildScriptedSimulator();
      audioLlm.responses.push({}, {content: {role: 'user'}});

      await expect(simulator.toAudioContent('hello')).rejects.toThrow(
        'Audio model returned no audio data',
      );
    });
  });

  describe('the request the audio model receives', () => {
    it('carries the model, the audio config and the text to speak', async () => {
      const {simulator, audioLlm} = buildScriptedSimulator();
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
      const {simulator, audioLlm} = buildScriptedSimulator();
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
      const {simulator, audioLlm} = buildScriptedSimulator(textResult);

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
      const {simulator, audioLlm} = buildScriptedSimulator(textResult);
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
      const {simulator, audioLlm} = buildScriptedSimulator({
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
      const {simulator, audioLlm} = buildScriptedSimulator({
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
