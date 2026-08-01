/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ExecuteCodeParams} from '@google/adk';
import {BuiltInCodeExecutor, LlmRequest} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

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

  it('processLlmRequest should attach codeExecution for an EAP model', () => {
    const llmRequest: LlmRequest = {
      model: 'gemini-flash-early-exp',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    expect(() => executor.processLlmRequest(llmRequest)).not.toThrow();
    expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
  });

  describe('extended model id forms', () => {
    const supportedModels = [
      'gemini/gemini-2.5-flash',
      'models/gemini-2.5-pro',
      'apigee/vertex_ai/v1beta/gemini-2.5-flash',
    ];

    for (const model of supportedModels) {
      it(`processLlmRequest should attach codeExecution for model: ${model}`, () => {
        const llmRequest: LlmRequest = {
          model,
          contents: [],
          toolsDict: {},
          liveConnectConfig: {},
        };
        expect(() => executor.processLlmRequest(llmRequest)).not.toThrow();
        expect(llmRequest.config?.tools).toEqual([{codeExecution: {}}]);
      });
    }

    const unsupportedModels = [
      'openrouter/anthropic/claude-sonnet-4',
      'openrouter/google/gemini-1.5-pro:online',
    ];

    for (const model of unsupportedModels) {
      it(`processLlmRequest should throw error for model: ${model}`, () => {
        const llmRequest: LlmRequest = {
          model,
          contents: [],
          toolsDict: {},
          liveConnectConfig: {},
        };
        expect(() => executor.processLlmRequest(llmRequest)).toThrowError(
          `Gemini code execution tool is not supported for model ${model}`,
        );
      });
    }
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
});
