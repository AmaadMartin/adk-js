/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  parseLlmAudioUserSimulatorConfig,
  parseLlmBackedUserSimulatorConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('parseLlmBackedUserSimulatorConfig', () => {
  it('reads a field written in the adk-python spelling', () => {
    const config = parseLlmBackedUserSimulatorConfig({
      max_allowed_invocations: 5,
      custom_instructions: 'be brief',
      include_function_calls: true,
    });

    expect(config.maxAllowedInvocations).toBe(5);
    expect(config.customInstructions).toBe('be brief');
    expect(config.includeFunctionCalls).toBe(true);
  });

  it('lets the camelCase spelling win over the snake_case one', () => {
    const config = parseLlmBackedUserSimulatorConfig({
      maxAllowedInvocations: 5,
      max_allowed_invocations: 9,
    });

    expect(config.maxAllowedInvocations).toBe(5);
  });

  it('rejects the type of another simulator', () => {
    expect(() =>
      parseLlmBackedUserSimulatorConfig({type: 'llm_audio'}),
    ).toThrowError(InputValidationError);
  });
});

describe('parseLlmAudioUserSimulatorConfig', () => {
  it('reads an audio field written in the adk-python spelling', () => {
    const config = parseLlmAudioUserSimulatorConfig({
      audio_model: 'gemini-2.5-flash-preview-tts',
      include_text_with_audio: false,
    });

    expect(config.audioModel).toBe('gemini-2.5-flash-preview-tts');
    expect(config.includeTextWithAudio).toBe(false);
  });

  it('rejects the type of another simulator', () => {
    expect(() =>
      parseLlmAudioUserSimulatorConfig({type: 'llm_backed'}),
    ).toThrowError(InputValidationError);
  });
});
