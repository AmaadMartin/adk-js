/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end test for the audio user simulator that exercises the real pipeline
 * (UserSimulatorProvider -> LlmAudioUserSimulator -> audio BaseLlm via the real
 * LLMRegistry) with NO test doubles. The audio backend is a genuine `BaseLlm`
 * subclass registered in the registry -- exactly the provider-agnostic seam a
 * real Cloud TTS / Gemini TTS model plugs into -- so this proves the feature
 * works without mocking any collaborator.
 */

import type {LlmRequest, LlmResponse} from '@google/adk';
import {
  BaseLlm,
  ConversationScenario,
  EvalCase,
  LlmAudioUserSimulator,
  LlmAudioUserSimulatorConfig,
  LLMRegistry,
  Status,
  UserSimulatorProvider,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const AUDIO_MODEL = 'e2e-fake-tts';
const TEXT_MODEL = 'e2e-fake-text';

/**
 * A real (non-mock) audio `BaseLlm` that deterministically "synthesizes" the
 * request text into PCM bytes of the form `pcm:<text>`.
 */
class FakeTtsLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    AUDIO_MODEL,
  ];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const text = (llmRequest.contents ?? [])
      .flatMap((content) => content.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    const pcm = Buffer.from(`pcm:${text}`);
    yield {
      content: {
        role: 'model',
        parts: [
          {inlineData: {mimeType: 'audio/pcm', data: pcm.toString('base64')}},
        ],
      },
    };
  }

  override async connect(): Promise<never> {
    throw new Error('FakeTtsLlm does not support live connections.');
  }
}

/** A real text `BaseLlm` so scenario-driven simulators can resolve a model. */
class FakeTextLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    TEXT_MODEL,
  ];

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: 'ok'}]}};
  }

  override async connect(): Promise<never> {
    throw new Error('FakeTextLlm does not support live connections.');
  }
}

LLMRegistry.register(FakeTtsLlm);
LLMRegistry.register(FakeTextLlm);

describe('Audio user simulator (e2e, no mocks)', () => {
  it('synthesizes a static conversation turn to audio via the provider', async () => {
    const config = new LlmAudioUserSimulatorConfig({audioModel: AUDIO_MODEL});
    const evalCase = new EvalCase({
      evalId: 'e2e-static',
      conversation: [
        {
          invocationId: 'inv1',
          userContent: {role: 'user', parts: [{text: 'Book me a flight.'}]},
        },
      ],
    });

    const simulator = new UserSimulatorProvider(config).provide(evalCase);
    expect(simulator).toBeInstanceOf(LlmAudioUserSimulator);

    const result = await simulator.getNextUserMessage([]);

    expect(result.status).toBe(Status.SUCCESS);
    expect(result.userMessage?.parts).toHaveLength(2);
    expect(result.userMessage?.parts?.[0].text).toBe('Book me a flight.');
    const audioPart = result.userMessage?.parts?.[1];
    expect(audioPart?.inlineData?.mimeType).toBe('audio/pcm');
    expect(
      Buffer.from(audioPart?.inlineData?.data ?? '', 'base64').toString(),
    ).toBe('pcm:Book me a flight.');
  });

  it('synthesizes a scenario starting prompt to audio via the provider', async () => {
    const config = new LlmAudioUserSimulatorConfig({
      model: TEXT_MODEL,
      audioModel: AUDIO_MODEL,
    });
    const evalCase = new EvalCase({
      evalId: 'e2e-scenario',
      conversationScenario: new ConversationScenario({
        startingPrompt: 'Hello there',
        conversationPlan: 'greet the agent',
      }),
    });

    const simulator = new UserSimulatorProvider(config).provide(evalCase);
    expect(simulator).toBeInstanceOf(LlmAudioUserSimulator);

    // The first scenario turn replays the starting prompt (no text-model call),
    // then routes it through the audio backend.
    const result = await simulator.getNextUserMessage([]);

    expect(result.status).toBe(Status.SUCCESS);
    expect(result.userMessage?.parts?.[0].text).toBe('Hello there');
    expect(
      Buffer.from(
        result.userMessage?.parts?.[1].inlineData?.data ?? '',
        'base64',
      ).toString(),
    ).toBe('pcm:Hello there');
  });

  it('emits audio-only content when includeTextWithAudio is false', async () => {
    const config = new LlmAudioUserSimulatorConfig({
      audioModel: AUDIO_MODEL,
      includeTextWithAudio: false,
    });
    const evalCase = new EvalCase({
      evalId: 'e2e-audio-only',
      conversation: [
        {
          invocationId: 'inv1',
          userContent: {role: 'user', parts: [{text: 'Just audio'}]},
        },
      ],
    });

    const simulator = new UserSimulatorProvider(config).provide(evalCase);
    const result = await simulator.getNextUserMessage([]);

    expect(result.status).toBe(Status.SUCCESS);
    expect(result.userMessage?.parts).toHaveLength(1);
    expect(result.userMessage?.parts?.[0].inlineData?.mimeType).toBe(
      'audio/pcm',
    );
  });
});
