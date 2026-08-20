/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Gemini,
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
});

/**
 * A model that needs no credentials, so `newLlm` can construct it.
 *
 * Registration is global and cannot be undone, so every subclass below takes a
 * unique class name and a unique pattern.
 */
abstract class StubLlm extends BaseLlm {
  async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    yield {content: createModelContent(`${this.model} response`)};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new TestLlmConnection();
  }
}

class PrefixOverrideLlm extends StubLlm {
  static override readonly supportedModels = ['prefix-override-only'];
}

class ColonNameLlm extends StubLlm {
  static override readonly supportedModels = ['colon-name-model:v1'];
}

class FirstOverrideLlm extends StubLlm {
  static override readonly supportedModels = ['registry-override-model'];
}

class SecondOverrideLlm extends StubLlm {
  static override readonly supportedModels = ['registry-override-model'];
}

describe('LLMRegistry name resolution', () => {
  beforeAll(() => {
    LLMRegistry.register(PrefixOverrideLlm);
    LLMRegistry.register(ColonNameLlm);
  });

  it('selects the class named by the prefix, skipping regex matching', () => {
    expect(LLMRegistry.resolve('prefixoverride:anything-unregistered')).toBe(
      PrefixOverrideLlm,
    );
  });

  it('strips a matching prefix before construction', () => {
    const llm = LLMRegistry.newLlm('prefixoverride:openai/gpt-4o');

    expect(llm).toBeInstanceOf(PrefixOverrideLlm);
    expect(llm.model).toBe('openai/gpt-4o');
  });

  it('compares the prefix case-insensitively', () => {
    expect(LLMRegistry.resolve('PREFIXOVERRIDE:x')).toBe(PrefixOverrideLlm);
    expect(LLMRegistry.resolve('PrefixOverride:x')).toBe(PrefixOverrideLlm);
  });

  it('accepts a prefix that keeps the trailing Llm', () => {
    expect(LLMRegistry.resolve('PrefixOverrideLlm:x')).toBe(PrefixOverrideLlm);
    expect(LLMRegistry.resolve('prefixoverridellm:x')).toBe(PrefixOverrideLlm);
  });

  it('selects a class whose name has no trailing Llm', () => {
    expect(LLMRegistry.resolve('gemini:gemini-1.5-flash')).toBe(Gemini);
  });

  it('keeps a colon that belongs to the model name', () => {
    expect(LLMRegistry.resolve('colon-name-model:v1')).toBe(ColonNameLlm);
    expect(LLMRegistry.newLlm('colon-name-model:v1').model).toBe(
      'colon-name-model:v1',
    );
  });

  it('treats an empty prefix as no prefix', () => {
    expect(() => LLMRegistry.resolve(':prefix-override-only')).toThrow(
      'Model :prefix-override-only not found.',
    );
  });

  it('throws when neither the prefix nor a regex matches', () => {
    expect(() => LLMRegistry.resolve('nosuchclass:whatever')).toThrow(
      'Model nosuchclass:whatever not found.',
    );
  });

  it('returns the new class when a resolved name is registered again', () => {
    LLMRegistry.register(FirstOverrideLlm);
    expect(LLMRegistry.resolve('registry-override-model')).toBe(
      FirstOverrideLlm,
    );

    LLMRegistry.register(SecondOverrideLlm);
    expect(LLMRegistry.resolve('registry-override-model')).toBe(
      SecondOverrideLlm,
    );
  });
});
