/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ExecuteCodeParams} from '@google/adk';
import {BuiltInCodeExecutor, LlmRequest} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

const MODEL_ID_CHECK_ENV_VAR = 'ADK_DISABLE_GEMINI_MODEL_ID_CHECK';

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}, ...overrides};
}

function withModelIdCheckDisabled(value: string, body: () => void): void {
  const originalValue = process.env[MODEL_ID_CHECK_ENV_VAR];
  process.env[MODEL_ID_CHECK_ENV_VAR] = value;
  try {
    body();
  } finally {
    if (originalValue === undefined) {
      delete process.env[MODEL_ID_CHECK_ENV_VAR];
    } else {
      process.env[MODEL_ID_CHECK_ENV_VAR] = originalValue;
    }
  }
}

describe('BuiltInCodeExecutor', () => {
  let executor: BuiltInCodeExecutor;

  beforeEach(() => {
    executor = new BuiltInCodeExecutor();
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

  it('accepts a Gemini 1.x model', () => {
    const llmRequest = makeRequest({model: 'gemini-1.5-pro'});

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('accepts a non-Gemini model when the model-id check is disabled', () => {
    const llmRequest = makeRequest({model: 'internal-model-v1'});

    withModelIdCheckDisabled('true', () => {
      executor.processLlmRequest(llmRequest);
    });

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('accepts an absent model when the model-id check is disabled', () => {
    const llmRequest = makeRequest();

    withModelIdCheckDisabled('true', () => {
      executor.processLlmRequest(llmRequest);
    });

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('treats "1" as a disabled model-id check', () => {
    const llmRequest = makeRequest({model: 'internal-model-v1'});

    withModelIdCheckDisabled('1', () => {
      executor.processLlmRequest(llmRequest);
    });

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('keeps the tools already on the request', () => {
    const existingTool = {
      functionDeclarations: [{name: 'test_func', description: 'A test func'}],
    };
    const llmRequest = makeRequest({
      model: 'gemini-2.5-flash',
      config: {tools: [existingTool]},
    });

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([
      existingTool,
      {codeExecution: {}},
    ]);
  });

  it('creates the tools array when the config carries none', () => {
    const llmRequest = makeRequest({
      model: 'gemini-2.5-flash',
      config: {temperature: 0.1},
    });

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('appends to an empty tools array', () => {
    const llmRequest = makeRequest({
      model: 'gemini-2.5-flash',
      config: {tools: []},
    });

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('accepts a Vertex path-form Gemini model id', () => {
    const llmRequest = makeRequest({
      model:
        'projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash',
    });

    executor.processLlmRequest(llmRequest);

    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('throws for a non-Gemini model', () => {
    const llmRequest = makeRequest({model: 'claude-3-sonnet'});

    expect(() => executor.processLlmRequest(llmRequest)).toThrowError(
      'Gemini code execution tool is not supported for model claude-3-sonnet',
    );
  });

  it('leaves a rejected request unmutated', () => {
    const llmRequest = makeRequest({model: 'claude-3-sonnet'});

    expect(() => executor.processLlmRequest(llmRequest)).toThrow();

    expect(llmRequest.config).toBeUndefined();
  });
});
