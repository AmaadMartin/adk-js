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
  LlmResponse,
} from '@google/adk';
import {createModelContent} from '@google/genai';
import {MockLlmConnection} from '../../mock_llm_connection.js';
import {readModelResponse} from './lib/asset_reader.js';

class MockLlm extends BaseLlm {
  constructor({model}: {model: string}) {
    super({model});
  }
  static override readonly supportedModels = ['test-llm-model'];
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: createModelContent(await readModelResponse())};
  }
  async connect(): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

LLMRegistry.register(MockLlm);

export const rootAgent = new LlmAgent({
  name: 'dependency_import_meta_agent',
  model: 'test-llm-model',
  description: 'Agent whose dependency reads an asset next to itself',
});
