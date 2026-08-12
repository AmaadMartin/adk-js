/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ExecuteCodeParams} from '@google/adk';
import {BuiltInCodeExecutor, LlmRequest} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const MODEL_ID_CHECK_ENV_VAR = 'ADK_DISABLE_GEMINI_MODEL_ID_CHECK';

function createLlmRequest(model?: string): LlmRequest {
  return {model, contents: [], toolsDict: {}, liveConnectConfig: {}};
}

describe('BuiltInCodeExecutor', () => {
  let executor: BuiltInCodeExecutor;

  beforeEach(() => {
    executor = new BuiltInCodeExecutor();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('executeCode should return dummy values', async () => {
    const result = await executor.executeCode(
      {} as unknown as ExecuteCodeParams,
    );
    expect(result).toEqual({
      stdout: '',
      stderr: '',
      outputFiles: [],
    });
  });

  it('processLlmRequest should throw error if model is not provided', () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest)).toThrowError(
      'Gemini code execution tool is not supported for model undefined',
    );
  });

  it('processLlmRequest should not throw error if model is valid', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest)).not.toThrow();
    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('processLlmRequest should throw error if model is invalid', () => {
    const llmRequest: LlmRequest = {
      model: 'invalid-model',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest)).toThrowError(
      'Gemini code execution tool is not supported for model invalid-model',
    );
  });

  it.each([
    'gemini-live-2.5-flash-native-audio',
    'gemini-flash-early-exp',
    'gemini-3-pro-preview',
  ])('processLlmRequest should add the tool for %s', (model) => {
    const llmRequest = createLlmRequest(model);

    expect(() => executor.processLlmRequest(llmRequest)).not.toThrow();
    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('processLlmRequest should throw error for a non-Gemini model', () => {
    const llmRequest = createLlmRequest('claude-3-5-sonnet');

    expect(() => executor.processLlmRequest(llmRequest)).toThrowError(
      'Gemini code execution tool is not supported for model claude-3-5-sonnet',
    );
    expect(llmRequest.config).toBeUndefined();
  });

  it('processLlmRequest should add the tool for a non-Gemini model when the model-id check is disabled', () => {
    vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'true');
    const llmRequest = createLlmRequest('internal-model-v1');

    expect(() => executor.processLlmRequest(llmRequest)).not.toThrow();
    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('processLlmRequest should add the tool for an unset model when the model-id check is disabled', () => {
    vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'true');
    const llmRequest = createLlmRequest();

    expect(() => executor.processLlmRequest(llmRequest)).not.toThrow();
    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('processLlmRequest should keep the tools the request already has', () => {
    const llmRequest: LlmRequest = {
      ...createLlmRequest('gemini-2.5-flash'),
      config: {tools: [{googleSearch: {}}]},
    };

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([
      {googleSearch: {}},
      {codeExecution: {}},
    ]);
  });
});
