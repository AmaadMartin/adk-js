/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/evaluation/simulation/test_llm_audio_user_simulator.py`
 * from google/adk-python at commit a119dd77. Each `it` keeps the name of the
 * Python test it ports.
 */

import {
  createEvent,
  InputValidationError,
  LIVE_INPUT_MIME_TYPE,
  LlmAudioUserSimulator,
  parseLlmAudioUserSimulatorConfig,
  StaticUserSimulator,
  UserSimulatorStatus,
  type Event,
  type NextUserMessage,
  type UserSimulator,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeLlm} from './fake_llm.js';

const INPUT_EVENTS: Event[] = [
  createEvent({
    author: 'user',
    content: {parts: [{text: 'Can you help me?'}], role: 'user'},
    invocationId: 'inv1',
  }),
];

/** Encodes bytes the way `@google/genai` carries them in `Blob.data`. */
function encode(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString('base64');
}

function decode(data: string | undefined): Uint8Array {
  return new Uint8Array(Buffer.from(data ?? '', 'base64'));
}

/** Builds little-endian signed 16-bit PCM bytes from integer samples. */
function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

/** Builds an audio LLM response carrying one `inlineData` audio part. */
function audioResponse(
  data: Uint8Array | string = 'AUDIO_BYTES',
  mimeType = 'audio/pcm',
) {
  return {
    content: {
      parts: [{inlineData: {mimeType, data: encode(data)}}],
      role: 'user',
    },
  };
}

/** A wrapped simulator that replays one scripted result per call. */
class ScriptedUserSimulator implements UserSimulator {
  callCount = 0;

  constructor(private readonly results: NextUserMessage[]) {}

  async getNextUserMessage(_events: Event[]): Promise<NextUserMessage> {
    this.callCount++;
    return this.results[Math.min(this.callCount - 1, this.results.length - 1)];
  }
}

function textMessage(text: string): NextUserMessage {
  return {
    status: UserSimulatorStatus.SUCCESS,
    userMessage: {parts: [{text}], role: 'user'},
  };
}

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
