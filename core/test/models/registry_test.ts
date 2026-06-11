/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {beforeAll, describe, expect, it, vi} from 'vitest';

import {
  Blob,
  Content,
  createModelContent,
  GenerateContentResponse,
} from '@google/genai';

import {logger} from '../../src/utils/logger.js';

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

  it('throws an error if model is not found during resolve', () => {
    expect(() => LLMRegistry.resolve('non-existent-model')).toThrow(
      'Model non-existent-model not found.',
    );
  });

  it('logs info when registering an already registered model', () => {
    const loggerSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    LLMRegistry.register(TestLlmModel);
    expect(loggerSpy).toHaveBeenCalled();
    loggerSpy.mockRestore();
  });

  it('evicts LRU cache items when cache exceeds max size', () => {
    // LLMRegistry.resolveCache has maxSize 32.
    // Let's register a set of models so we can resolve them.
    for (let i = 0; i < 35; i++) {
      class TempModel extends BaseLlm {
        constructor({model}: {model: string}) {
          super({model});
        }
        static override readonly supportedModels = [`temp-model-${i}`];
        async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {}
        async connect(): Promise<BaseLlmConnection> {
          return new TestLlmConnection();
        }
      }
      LLMRegistry.register(TempModel);
    }

    // Resolve 35 models to trigger eviction
    for (let i = 0; i < 35; i++) {
      expect(LLMRegistry.resolve(`temp-model-${i}`)).toBeDefined();
    }
  });
});
