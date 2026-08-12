/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ExecuteCodeParams} from '@google/adk';
import {BuiltInCodeExecutor, LlmRequest} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const MODEL_ID_CHECK_ENV_VAR = 'ADK_DISABLE_GEMINI_MODEL_ID_CHECK';

describe('BuiltInCodeExecutor', () => {
  let executor: BuiltInCodeExecutor;

  beforeEach(() => {
    executor = new BuiltInCodeExecutor();
    // Pin the escape hatch off so the model-id assertions hold whatever the
    // ambient environment sets.
    vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, undefined);
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

  it('processLlmRequest should add the tool for a non-Gemini model when the model-id check is disabled', () => {
    vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'true');
    const llmRequest: LlmRequest = {
      model: 'internal-model-v1',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest)).not.toThrow();
    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  it('processLlmRequest should still throw when the model is unset and the model-id check is disabled', () => {
    vi.stubEnv(MODEL_ID_CHECK_ENV_VAR, 'true');
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest)).toThrowError(
      'Gemini code execution tool is not supported for model undefined',
    );
  });
});
