/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConversationScenario,
  LlmAudioUserSimulator,
  LlmAudioUserSimulatorConfig,
  LlmBackedUserSimulator,
  LlmBackedUserSimulatorConfig,
  LLMRegistry,
  LlmResponse,
  NextUserMessage,
  StaticUserSimulator,
  Status,
  UserSimulator,
} from '@google/adk';
import type {SpeechConfig} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The default voice constants are shared with the Cloud TTS module; they port
// adk-python module privates and so are deliberately not in the public API
// (same convention as `summarizeConversation` in the user-simulator subsystem).
import {
  DEFAULT_LANGUAGE_CODE,
  DEFAULT_VOICE_NAME,
} from '../../../src/evaluation/simulation/cloud_tts_llm.js';

/** Yields each item from `items` as an async generator. */
async function* toAsyncIter(items: LlmResponse[]): AsyncGenerator<LlmResponse> {
  for (const item of items) {
    yield item;
  }
}

/** Builds a SUCCESS NextUserMessage carrying a single text part. */
function textMessage(text: string): NextUserMessage {
  return new NextUserMessage({
    status: Status.SUCCESS,
    userMessage: {parts: [{text}], role: 'user'},
  });
}

/**
 * Builds a mock audio LLM response with an inline_data audio part. `data` is the
 * decoded audio; it is base64-encoded to match `@google/genai` Blob semantics.
 */
function audioResponse(data: string, mimeType = 'audio/pcm'): LlmResponse {
  return {
    content: {
      role: 'user',
      parts: [
        {inlineData: {mimeType, data: Buffer.from(data).toString('base64')}},
      ],
    },
  };
}

/** White-box view of the simulator's private composition state. */
interface Internals {
  textSimulator: UserSimulator;
  audioLlm: {generateContentAsync: ReturnType<typeof vi.fn>};
  generateAudio(text: string): Promise<{audioBytes: Buffer; mimeType: string}>;
}

function internals(simulator: LlmAudioUserSimulator): Internals {
  return simulator as unknown as Internals;
}

describe('LlmAudioUserSimulatorConfig', () => {
  it('carries the expected discriminator and audio defaults', () => {
    const config = new LlmAudioUserSimulatorConfig();
    expect(config.type).toBe('llm_audio');
    expect(config.model).toBe('gemini-2.5-flash');
    expect(config.audioModel).toBe('cloud_tts');
    expect(config.includeTextWithAudio).toBe(true);
  });

  it('defaults the voice to the Cloud TTS module constants', () => {
    // Locks the two files together: the default speech config must stay in
    // sync with the fallback `extractVoiceConfig` applies when none is set.
    const speechConfig = new LlmAudioUserSimulatorConfig()
      .audioModelConfiguration.speechConfig as SpeechConfig;
    expect(speechConfig.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(
      DEFAULT_VOICE_NAME,
    );
    expect(speechConfig.languageCode).toBe(DEFAULT_LANGUAGE_CODE);
  });

  it('validates custom instructions against the required placeholders', () => {
    expect(
      new LlmAudioUserSimulatorConfig().customInstructions,
    ).toBeUndefined();

    const valid =
      '{{ stop_signal }} {{ conversation_plan }} {{ conversation_history }}';
    expect(
      new LlmAudioUserSimulatorConfig({customInstructions: valid})
        .customInstructions,
    ).toBe(valid);

    expect(
      () =>
        new LlmAudioUserSimulatorConfig({
          customInstructions: 'missing formatting placeholders',
        }),
    ).toThrow('custom_instructions must contain');
  });

  it('accepts every field provided explicitly', () => {
    const modelConfiguration = {temperature: 0.5};
    const audioModelConfiguration = {speechConfig: {languageCode: 'fr-FR'}};
    const config = new LlmAudioUserSimulatorConfig({
      type: 'llm_audio',
      model: 'custom-model',
      modelConfiguration,
      maxAllowedInvocations: 5,
      customInstructions: undefined,
      includeFunctionCalls: true,
      audioModel: 'custom-audio',
      audioModelConfiguration,
      includeTextWithAudio: false,
    });
    expect(config.model).toBe('custom-model');
    expect(config.modelConfiguration).toBe(modelConfiguration);
    expect(config.maxAllowedInvocations).toBe(5);
    expect(config.includeFunctionCalls).toBe(true);
    expect(config.audioModel).toBe('custom-audio');
    expect(config.audioModelConfiguration).toBe(audioModelConfiguration);
    expect(config.includeTextWithAudio).toBe(false);
  });

  it('rejects a mismatched type discriminator', () => {
    expect(
      () =>
        new LlmAudioUserSimulatorConfig({
          type: 'something_else' as 'llm_audio',
        }),
    ).toThrow("`type` must be 'llm_audio'.");
  });
});

describe('LlmAudioUserSimulator', () => {
  let audioLlm: {generateContentAsync: ReturnType<typeof vi.fn>};

  function makeScenario(): ConversationScenario {
    return new ConversationScenario({
      startingPrompt: 'Hello',
      conversationPlan: 'test plan',
    });
  }

  function makeSimulator(
    config = new LlmAudioUserSimulatorConfig({
      model: 'test-model',
      audioModel: 'test-audio-model',
    }),
  ): LlmAudioUserSimulator {
    const textSimulator = new LlmBackedUserSimulator({
      config: new LlmBackedUserSimulatorConfig({model: 'test-model'}),
      conversationScenario: makeScenario(),
    });
    return new LlmAudioUserSimulator({config, textSimulator});
  }

  beforeEach(() => {
    audioLlm = {generateContentAsync: vi.fn()};
    // resolve returns a class whose construction yields the shared mock audio
    // LLM (a JS constructor that returns an object yields that object).
    vi.spyOn(LLMRegistry, 'resolve').mockReturnValue(function AudioLlm() {
      return audioLlm;
    } as unknown as ReturnType<typeof LLMRegistry.resolve>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('construction', () => {
    it('composes the injected text simulator and resolved audio LLM', () => {
      const simulator = makeSimulator();
      expect(internals(simulator).textSimulator).toBeInstanceOf(
        LlmBackedUserSimulator,
      );
      expect(internals(simulator).audioLlm).toBe(audioLlm);
    });

    it('can wrap a StaticUserSimulator', () => {
      const conversation = [
        {
          invocationId: 'inv1',
          userContent: {parts: [{text: 'Hello!'}], role: 'user'},
        },
      ];
      const textSimulator = new StaticUserSimulator({
        staticConversation: conversation,
      });
      const simulator = new LlmAudioUserSimulator({
        config: new LlmAudioUserSimulatorConfig({
          audioModel: 'test-audio-model',
        }),
        textSimulator,
      });
      const wrapped = internals(simulator).textSimulator;
      expect(wrapped).toBeInstanceOf(StaticUserSimulator);
      expect((wrapped as StaticUserSimulator).staticConversation).toEqual(
        conversation,
      );
    });
  });

  describe('getNextUserMessage', () => {
    it('returns both a text part and an audio part on success', async () => {
      const simulator = makeSimulator();
      vi.spyOn(
        internals(simulator).textSimulator,
        'getNextUserMessage',
      ).mockResolvedValue(textMessage('Book me a flight.'));
      audioLlm.generateContentAsync.mockReturnValue(
        toAsyncIter([audioResponse('WAV', 'audio/pcm')]),
      );

      const result = await simulator.getNextUserMessage([]);

      expect(result.status).toBe(Status.SUCCESS);
      expect(result.userMessage?.role).toBe('user');
      expect(result.userMessage?.parts).toHaveLength(2);
      expect(result.userMessage?.parts?.[0].text).toBe('Book me a flight.');
      expect(
        Buffer.from(
          result.userMessage?.parts?.[1].inlineData?.data ?? '',
          'base64',
        ),
      ).toEqual(Buffer.from('WAV'));
      expect(result.userMessage?.parts?.[1].inlineData?.mimeType).toBe(
        'audio/pcm',
      );
    });

    it('returns only the audio part when includeTextWithAudio is false', async () => {
      const simulator = makeSimulator(
        new LlmAudioUserSimulatorConfig({
          model: 'test-model',
          audioModel: 'test-audio-model',
          includeTextWithAudio: false,
        }),
      );
      vi.spyOn(
        internals(simulator).textSimulator,
        'getNextUserMessage',
      ).mockResolvedValue(textMessage('Book me a flight.'));
      audioLlm.generateContentAsync.mockReturnValue(
        toAsyncIter([audioResponse('WAV')]),
      );

      const result = await simulator.getNextUserMessage([]);

      expect(result.status).toBe(Status.SUCCESS);
      expect(result.userMessage?.parts).toHaveLength(1);
      expect(
        Buffer.from(
          result.userMessage?.parts?.[0].inlineData?.data ?? '',
          'base64',
        ),
      ).toEqual(Buffer.from('WAV'));
    });

    it('passes through a non-SUCCESS text result unchanged', async () => {
      const simulator = makeSimulator();
      const textResult = new NextUserMessage({
        status: Status.TURN_LIMIT_REACHED,
      });
      vi.spyOn(
        internals(simulator).textSimulator,
        'getNextUserMessage',
      ).mockResolvedValue(textResult);

      const result = await simulator.getNextUserMessage([]);

      expect(result).toBe(textResult);
      expect(audioLlm.generateContentAsync).not.toHaveBeenCalled();
    });

    it('passes through a SUCCESS result whose message has no parts', async () => {
      const simulator = makeSimulator();
      const textResult = new NextUserMessage({
        status: Status.SUCCESS,
        userMessage: {role: 'user'},
      });
      vi.spyOn(
        internals(simulator).textSimulator,
        'getNextUserMessage',
      ).mockResolvedValue(textResult);

      const result = await simulator.getNextUserMessage([]);

      expect(result).toBe(textResult);
      expect(audioLlm.generateContentAsync).not.toHaveBeenCalled();
    });

    it('passes through a SUCCESS result whose parts carry no text', async () => {
      const simulator = makeSimulator();
      const textResult = new NextUserMessage({
        status: Status.SUCCESS,
        userMessage: {
          parts: [{inlineData: {mimeType: 'audio/pcm', data: 'eA=='}}],
          role: 'user',
        },
      });
      vi.spyOn(
        internals(simulator).textSimulator,
        'getNextUserMessage',
      ).mockResolvedValue(textResult);

      const result = await simulator.getNextUserMessage([]);

      expect(result).toBe(textResult);
      expect(audioLlm.generateContentAsync).not.toHaveBeenCalled();
    });
  });

  describe('generateAudio', () => {
    it('aggregates the audio bytes and mime type from the stream', async () => {
      const simulator = makeSimulator();
      audioLlm.generateContentAsync.mockReturnValue(
        toAsyncIter([audioResponse('HELLO', 'audio/wav')]),
      );

      const {audioBytes, mimeType} =
        await internals(simulator).generateAudio('hello');

      expect(audioBytes).toEqual(Buffer.from('HELLO'));
      expect(mimeType).toBe('audio/wav');
    });

    it('throws when a response carries an error code', async () => {
      const simulator = makeSimulator();
      audioLlm.generateContentAsync.mockReturnValue(
        toAsyncIter([{errorCode: 'SAFETY', errorMessage: 'blocked'}]),
      );

      await expect(internals(simulator).generateAudio('hello')).rejects.toThrow(
        'Audio generation failed: SAFETY',
      );
    });

    it('throws when no audio data is returned', async () => {
      const simulator = makeSimulator();
      audioLlm.generateContentAsync.mockReturnValue(
        toAsyncIter([{content: {role: 'user', parts: [{text: 'not audio'}]}}]),
      );

      await expect(internals(simulator).generateAudio('hello')).rejects.toThrow(
        'Audio model returned no audio data',
      );
    });
  });

  describe('toAudioContent', () => {
    it('converts text into a text+audio user Content', async () => {
      const simulator = makeSimulator();
      audioLlm.generateContentAsync.mockReturnValue(
        toAsyncIter([audioResponse('WAV', 'audio/pcm')]),
      );

      const content = await simulator.toAudioContent('Hello there');

      expect(content.role).toBe('user');
      expect(content.parts).toHaveLength(2);
      expect(content.parts?.[0].text).toBe('Hello there');
      expect(
        Buffer.from(content.parts?.[1].inlineData?.data ?? '', 'base64'),
      ).toEqual(Buffer.from('WAV'));
    });
  });

  it('has no simulation evaluator', () => {
    expect(() => makeSimulator().getSimulationEvaluator()).toThrow();
  });
});
