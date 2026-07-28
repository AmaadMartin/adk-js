/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local, no-mock end-to-end test for `claude-*` model resolution.
 *
 * Importing `@google/adk` side-effect-registers {@link AnthropicLlm}, so a bare
 * Claude string drives an {@link LlmAgent} the same way a bare Gemini string
 * does: resolved through the public {@link LLMRegistry} and constructed for
 * real. A placeholder API key suffices because construction is offline (the
 * Anthropic API is only contacted when generating).
 */

import {AnthropicLlm, LlmAgent} from '@google/adk';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const API_KEY_ENV_VARIABLE_NAME = 'ANTHROPIC_API_KEY';

describe('claude model resolution E2E (public @google/adk registry)', () => {
  let previousApiKey: string | undefined;

  beforeAll(() => {
    previousApiKey = process.env[API_KEY_ENV_VARIABLE_NAME];
    process.env[API_KEY_ENV_VARIABLE_NAME] = 'placeholder-not-a-real-key';
  });

  afterAll(() => {
    if (previousApiKey === undefined) {
      delete process.env[API_KEY_ENV_VARIABLE_NAME];
    } else {
      process.env[API_KEY_ENV_VARIABLE_NAME] = previousApiKey;
    }
  });

  it('drives an LlmAgent from a bare claude model string', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: 'claude-3-5-sonnet-20241022',
    });

    const model = agent.canonicalModel;
    expect(model).toBeInstanceOf(AnthropicLlm);
    expect(model.model).toBe('claude-3-5-sonnet-20241022');
  });
});
