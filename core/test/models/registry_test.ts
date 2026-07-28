/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AnthropicLlm,
  BaseLlm,
  BaseLlmConnection,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';

import {
  Blob,
  Content,
  createModelContent,
  GenerateContentResponse,
} from '@google/genai';

class TestLlmConnection implements BaseLlmConnection {
  async sendHistory(_history: Content[]): Promise<void> {
    return Promise.resolve();
  }

  async sendContent(_content: Content): Promise<void> {}

  async sendRealtime(_blob: Blob): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {}

  async close(): Promise<void> {}
}

class TestLlmModel extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }

  static override readonly supportedModels = ['test-llm-model'];

  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const generateContentResponse = new GenerateContentResponse();

    generateContentResponse.candidates = [
      {content: createModelContent('test-llm-model-response')},
    ];
    const candidate = generateContentResponse.candidates[0];

    yield {
      content: candidate.content,
      groundingMetadata: candidate.groundingMetadata,
      usageMetadata: generateContentResponse.usageMetadata,
      finishReason: candidate.finishReason,
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new TestLlmConnection();
  }
}

describe('LLMRegistry', () => {
  beforeAll(() => {
    LLMRegistry.register(TestLlmModel);
  });

  it('resolves model to LLM class', () => {
    expect(LLMRegistry.newLlm('test-llm-model')).toBeInstanceOf(TestLlmModel);
  });

  it('resolves the provided as a string model correctly in LlmAgent', () => {
    const agent = new LlmAgent({name: 'test_agent', model: 'test-llm-model'});

    expect(agent.canonicalModel).toBeInstanceOf(TestLlmModel);
  });

  it('resolves the provided as class model correctly in LlmAgent', () => {
    const agent = new LlmAgent({
      name: 'test_agent',
      model: new TestLlmModel({model: 'test-llm-model'}),
    });

    expect(agent.canonicalModel).toBeInstanceOf(TestLlmModel);
  });

  it('resolves a claude-3 model string to the AnthropicLlm class', () => {
    expect(LLMRegistry.resolve('claude-3-5-sonnet-20241022')).toBe(
      AnthropicLlm,
    );
  });

  it('resolves a claude 4 model string to the AnthropicLlm class', () => {
    expect(LLMRegistry.resolve('claude-sonnet-4-20250514')).toBe(AnthropicLlm);
  });

  it('exposes supportedModels matching the adk-python patterns', () => {
    expect(AnthropicLlm.supportedModels).toEqual([
      /claude-3-.*/,
      /claude-.*-4.*/,
    ]);
  });
});
