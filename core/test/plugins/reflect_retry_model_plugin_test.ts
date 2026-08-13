/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  FunctionTool,
  LlmRequest,
  LlmResponse,
  PluginManager,
  REFLECT_AND_RETRY_RESPONSE_TYPE,
  ReflectAndRetryModelPlugin,
  RESERVED_TOOL_CALL_ERROR_TYPE,
  TrackingScope,
} from '@google/adk';
import {FinishReason, FunctionCall} from '@google/genai';
import {describe, expect, it} from 'vitest';

const LLM_AGENT_SIGNATURE_SYMBOL = Symbol.for('google.adk.llmAgent');
const ADK_HANDLE_MODEL_ERROR = 'adk_handle_model_error';

/** Builds a callback context backed by a fake LlmAgent with a resolvable model. */
function makeCallbackContext(
  modelName: string | undefined,
  invocationId: string,
): Context {
  const agent = {
    [LLM_AGENT_SIGNATURE_SYMBOL]: true,
    canonicalModel: modelName ? {model: modelName} : undefined,
  };
  return {
    invocationContext: {invocationId, agent},
  } as unknown as Context;
}

/** Builds a callback context whose agent is not an LlmAgent. */
function makeNonLlmAgentContext(invocationId: string): Context {
  return {
    invocationContext: {invocationId, agent: {name: 'plain_agent'}},
  } as unknown as Context;
}

function makeLlmRequest(): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}};
}

function malformedResponse(): LlmResponse {
  return {
    errorCode: FinishReason.MALFORMED_FUNCTION_CALL,
    errorMessage: 'The function call is malformed.',
    finishReason: FinishReason.MALFORMED_FUNCTION_CALL,
  };
}

function reservedToolCallResponse(): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{functionCall: {name: ADK_HANDLE_MODEL_ERROR, args: {}}}],
    },
  };
}

function successResponse(): LlmResponse {
  return {content: {role: 'model', parts: [{text: 'All good.'}]}};
}

function firstFunctionCall(
  response: LlmResponse | undefined,
): FunctionCall | undefined {
  return response?.content?.parts?.[0]?.functionCall;
}

describe('ReflectAndRetryModelPlugin', () => {
  describe('initialization', () => {
    // test_plugin_initialization_default
    it('uses the documented defaults', () => {
      const plugin = new ReflectAndRetryModelPlugin();
      expect(plugin.name).toBe('reflect_retry_model_plugin');
      expect(plugin.maxRetries).toBe(3);
      expect(plugin.throwExceptionIfRetryExceeded).toBe(true);
      expect(plugin.scope).toBe(TrackingScope.INVOCATION);
      expect(plugin.onModelErrors).toEqual([
        FinishReason.MALFORMED_FUNCTION_CALL,
      ]);
    });

    it('honors overrides', () => {
      const plugin = new ReflectAndRetryModelPlugin({
        name: 'custom',
        maxRetries: 5,
        throwExceptionIfRetryExceeded: false,
        trackingScope: TrackingScope.GLOBAL,
        onModelErrors: [
          FinishReason.MALFORMED_FUNCTION_CALL,
          FinishReason.SAFETY,
        ],
      });
      expect(plugin.name).toBe('custom');
      expect(plugin.maxRetries).toBe(5);
      expect(plugin.throwExceptionIfRetryExceeded).toBe(false);
      expect(plugin.scope).toBe(TrackingScope.GLOBAL);
      expect(plugin.onModelErrors).toEqual([
        FinishReason.MALFORMED_FUNCTION_CALL,
        FinishReason.SAFETY,
      ]);
    });

    it('rejects a negative maxRetries', () => {
      expect(() => new ReflectAndRetryModelPlugin({maxRetries: -1})).toThrow(
        'max_retries must be a non-negative integer.',
      );
    });

    // test_validate_model_errors_ensures_finish_reason_types
    it('validates that onModelErrors are FinishReason values', () => {
      expect(
        () =>
          new ReflectAndRetryModelPlugin({
            onModelErrors: ['NOT_A_REASON' as FinishReason],
          }),
      ).toThrow('model_error must be a FinishReason, got NOT_A_REASON');
    });
  });

  describe('reserved reflection tool', () => {
    // test_before_model_callback_adds_reflect_tool_to_llm_request
    it('injects the reserved tool and returns undefined', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const llmRequest = makeLlmRequest();

      const result = await plugin.beforeModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmRequest,
      });

      expect(result).toBeUndefined();
      const tool = llmRequest.toolsDict[ADK_HANDLE_MODEL_ERROR];
      expect(tool).toBeInstanceOf(FunctionTool);
      expect(tool.name).toBe(ADK_HANDLE_MODEL_ERROR);
    });

    // test_adk_handle_model_error_format
    it('returns reflection guidance from the tool implementation', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const llmRequest = makeLlmRequest();
      await plugin.beforeModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmRequest,
      });

      const tool = llmRequest.toolsDict[ADK_HANDLE_MODEL_ERROR];
      const result = (await tool.runAsync({
        args: {retry_count: 1},
        toolContext: {} as Context,
      })) as {reflection_guidance?: string};

      expect(result.reflection_guidance).toBeDefined();
      expect(result.reflection_guidance).toContain(
        'retry attempt **1** of **3**',
      );
    });
  });

  describe('error detection', () => {
    // test_check_for_model_error_uses_input_model_errors
    it('retries the configured finish reasons and ignores others', async () => {
      const plugin = new ReflectAndRetryModelPlugin({
        onModelErrors: [
          FinishReason.MALFORMED_FUNCTION_CALL,
          FinishReason.SAFETY,
        ],
      });
      const context = makeCallbackContext('gemini', 'inv-1');

      const malformed = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(malformed)?.name).toBe(ADK_HANDLE_MODEL_ERROR);

      const safety = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: {
          errorCode: FinishReason.SAFETY,
          errorMessage: 'blocked',
          finishReason: FinishReason.SAFETY,
        },
      });
      expect(firstFunctionCall(safety)?.name).toBe(ADK_HANDLE_MODEL_ERROR);

      const recitation = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: {
          errorCode: FinishReason.RECITATION,
          errorMessage: 'blocked',
          finishReason: FinishReason.RECITATION,
        },
      });
      expect(recitation).toBeUndefined();
    });

    // test_check_for_model_error_requires_error_code
    it('does not retry when there is no error code', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const result = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmResponse: {finishReason: FinishReason.MALFORMED_FUNCTION_CALL},
      });
      expect(result).toBeUndefined();
    });

    it('does not retry when the finish reason is missing', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const result = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmResponse: {errorCode: 'SOME_ERROR', errorMessage: 'oops'},
      });
      expect(result).toBeUndefined();
    });
  });

  describe('model name resolution', () => {
    // test_get_model_name_from_context_success (asserted behaviorally elsewhere)
    // test_get_model_name_from_context_requires_llm_agent
    it('throws when the agent is not an LlmAgent', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      await expect(
        plugin.afterModelCallback({
          callbackContext: makeNonLlmAgentContext('inv-1'),
          llmResponse: malformedResponse(),
        }),
      ).rejects.toThrow('Agent model not found.');
    });

    it('throws when the LlmAgent has no resolvable model', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const agent = {
        [LLM_AGENT_SIGNATURE_SYMBOL]: true,
        get canonicalModel(): never {
          throw new Error('No model found for agent.');
        },
      };
      const context = {
        invocationContext: {invocationId: 'inv-1', agent},
      } as unknown as Context;

      await expect(
        plugin.afterModelCallback({
          callbackContext: context,
          llmResponse: malformedResponse(),
        }),
      ).rejects.toThrow('Agent model not found.');
    });
  });

  describe('retry behavior', () => {
    // test_after_model_callback_retries_on_malformed_call
    it('synthesizes a retry function call with no error code', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const result = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmResponse: malformedResponse(),
      });

      expect(result?.errorCode).toBeUndefined();
      const functionCall = firstFunctionCall(result);
      expect(functionCall?.name).toBe(ADK_HANDLE_MODEL_ERROR);
      expect(functionCall?.id).toMatch(/^adk_handle_model_error_/);
      expect(functionCall?.args?.['response_type']).toBe(
        REFLECT_AND_RETRY_RESPONSE_TYPE,
      );
      expect(functionCall?.args?.['finish_reason']).toBe(
        FinishReason.MALFORMED_FUNCTION_CALL,
      );
      expect(functionCall?.args?.['error_type']).toBe(
        FinishReason.MALFORMED_FUNCTION_CALL,
      );
      expect(functionCall?.args?.['error_details']).toBe(
        'The function call is malformed.',
      );
      expect(functionCall?.args?.['retry_count']).toBe(1);
    });

    // test_after_model_callback_can_perform_multiple_retries
    it('increments the retry count on consecutive failures', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const context = makeCallbackContext('gemini', 'inv-1');
      const retryCounts: unknown[] = [];

      for (let i = 0; i < 3; i++) {
        const result = await plugin.afterModelCallback({
          callbackContext: context,
          llmResponse: malformedResponse(),
        });
        retryCounts.push(firstFunctionCall(result)?.args?.['retry_count']);
      }

      expect(retryCounts).toEqual([1, 2, 3]);
    });

    // test_after_model_callback_returns_response_when_retry_limit_reached
    it('returns the failing response when the limit is reached (no throw)', async () => {
      const plugin = new ReflectAndRetryModelPlugin({
        maxRetries: 1,
        throwExceptionIfRetryExceeded: false,
      });
      const context = makeCallbackContext('gemini', 'inv-1');

      const first = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(first)?.name).toBe(ADK_HANDLE_MODEL_ERROR);

      const failing = malformedResponse();
      const second = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: failing,
      });
      expect(second).toEqual(failing);
      expect(second?.errorCode).toBe(FinishReason.MALFORMED_FUNCTION_CALL);
      expect(second?.errorMessage).toBe('The function call is malformed.');
      expect(second?.finishReason).toBe(FinishReason.MALFORMED_FUNCTION_CALL);
    });

    // test_after_model_callback_throws_when_retry_limit_reached
    it('throws when the limit is reached (throw mode)', async () => {
      const plugin = new ReflectAndRetryModelPlugin({maxRetries: 1});
      const context = makeCallbackContext('gemini', 'inv-1');

      await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: malformedResponse(),
      });

      await expect(
        plugin.afterModelCallback({
          callbackContext: context,
          llmResponse: malformedResponse(),
        }),
      ).rejects.toThrow(
        'The model has failed consecutively 1 times and the retry limit has been exceeded.',
      );
    });

    // test_after_model_callback_resets_retry_limit_upon_success
    it('resets the counter after a successful response', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const context = makeCallbackContext('gemini', 'inv-1');

      const first = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(first)?.args?.['retry_count']).toBe(1);
      const second = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(second)?.args?.['retry_count']).toBe(2);

      const success = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: successResponse(),
      });
      expect(success).toBeUndefined();

      const afterReset = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(afterReset)?.args?.['retry_count']).toBe(1);
    });

    it('returns undefined on a success with no prior failures', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const result = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmResponse: successResponse(),
      });
      expect(result).toBeUndefined();
    });
  });

  describe('reserved tool call interception', () => {
    // test_after_model_callback_intercepts_reserved_tool_call
    it('intercepts a direct reserved tool call', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const result = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmResponse: reservedToolCallResponse(),
      });

      const functionCall = firstFunctionCall(result);
      expect(functionCall?.name).toBe(ADK_HANDLE_MODEL_ERROR);
      expect(functionCall?.args?.['error_type']).toBe(
        RESERVED_TOOL_CALL_ERROR_TYPE,
      );
      expect(functionCall?.args?.['finish_reason']).toBe(FinishReason.OTHER);
      expect(functionCall?.args?.['retry_count']).toBe(1);
    });

    // test_after_model_callback_returns_error_response_when_reserved_tool_call_limit_reached
    it('returns an error response when the reserved-call limit is reached', async () => {
      const plugin = new ReflectAndRetryModelPlugin({
        maxRetries: 1,
        throwExceptionIfRetryExceeded: false,
      });
      const context = makeCallbackContext('gemini', 'inv-1');

      const first = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: reservedToolCallResponse(),
      });
      expect(firstFunctionCall(first)?.name).toBe(ADK_HANDLE_MODEL_ERROR);

      const second = await plugin.afterModelCallback({
        callbackContext: context,
        llmResponse: reservedToolCallResponse(),
      });
      expect(second?.errorCode).toBe(RESERVED_TOOL_CALL_ERROR_TYPE);
      expect(second?.errorMessage).toBe(
        'Model attempted to call reserved tool and retry limit was exceeded.',
      );
      expect(second?.content).toBeUndefined();
    });
  });

  describe('scoped failure tracking', () => {
    // test_different_models_have_separate_retry_counters
    it('tracks failures independently per model', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const modelA = makeCallbackContext('model-a', 'inv-1');
      const modelB = makeCallbackContext('model-b', 'inv-1');

      const a1 = await plugin.afterModelCallback({
        callbackContext: modelA,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(a1)?.args?.['retry_count']).toBe(1);

      const b1 = await plugin.afterModelCallback({
        callbackContext: modelB,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(b1)?.args?.['retry_count']).toBe(1);

      const a2 = await plugin.afterModelCallback({
        callbackContext: modelA,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(a2)?.args?.['retry_count']).toBe(2);
    });

    it('preserves other model counters when one model succeeds', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const modelA = makeCallbackContext('model-a', 'inv-1');
      const modelB = makeCallbackContext('model-b', 'inv-1');

      await plugin.afterModelCallback({
        callbackContext: modelA,
        llmResponse: malformedResponse(),
      });
      await plugin.afterModelCallback({
        callbackContext: modelB,
        llmResponse: malformedResponse(),
      });
      // Success for model A must not reset model B's counter.
      await plugin.afterModelCallback({
        callbackContext: modelA,
        llmResponse: successResponse(),
      });

      const b2 = await plugin.afterModelCallback({
        callbackContext: modelB,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(b2)?.args?.['retry_count']).toBe(2);
    });

    // test_invocation_tracking_scope_for_models
    it('isolates counts across invocations for INVOCATION scope', async () => {
      const plugin = new ReflectAndRetryModelPlugin();

      const inv1 = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(inv1)?.args?.['retry_count']).toBe(1);

      const inv2 = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-2'),
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(inv2)?.args?.['retry_count']).toBe(1);
    });

    // test_global_tracking_scope_for_models
    it('shares counts across invocations for GLOBAL scope', async () => {
      const plugin = new ReflectAndRetryModelPlugin({
        trackingScope: TrackingScope.GLOBAL,
      });

      const inv1 = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-1'),
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(inv1)?.args?.['retry_count']).toBe(1);

      const inv2 = await plugin.afterModelCallback({
        callbackContext: makeCallbackContext('gemini', 'inv-2'),
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(inv2)?.args?.['retry_count']).toBe(2);
    });

    it('throws for INVOCATION scope with a missing invocation id', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      await expect(
        plugin.afterModelCallback({
          callbackContext: makeCallbackContext('gemini', ''),
          llmResponse: successResponse(),
        }),
      ).rejects.toThrow('invocationId must be provided for INVOCATION scope');
    });

    it('throws for an unknown tracking scope', async () => {
      const plugin = new ReflectAndRetryModelPlugin({
        trackingScope: 'nonsense' as TrackingScope,
      });
      await expect(
        plugin.afterModelCallback({
          callbackContext: makeCallbackContext('gemini', 'inv-1'),
          llmResponse: malformedResponse(),
        }),
      ).rejects.toThrow('Unknown scope: nonsense');
    });
  });

  // A real end-to-end exercise through the framework's plugin dispatch, with no
  // mocks: a real PluginManager drives the real plugin's before/after model
  // callbacks over a live LlmRequest/LlmResponse.
  describe('end-to-end via PluginManager', () => {
    it('injects the tool, retries a malformed response, then recovers', async () => {
      const plugin = new ReflectAndRetryModelPlugin();
      const pluginManager = new PluginManager([plugin]);
      const callbackContext = makeCallbackContext('gemini', 'inv-e2e');
      const llmRequest = makeLlmRequest();

      const beforeResult = await pluginManager.runBeforeModelCallback({
        callbackContext,
        llmRequest,
      });
      expect(beforeResult).toBeUndefined();
      expect(llmRequest.toolsDict[ADK_HANDLE_MODEL_ERROR]).toBeInstanceOf(
        FunctionTool,
      );

      const retry = await pluginManager.runAfterModelCallback({
        callbackContext,
        llmResponse: malformedResponse(),
      });
      expect(retry?.errorCode).toBeUndefined();
      expect(firstFunctionCall(retry)?.name).toBe(ADK_HANDLE_MODEL_ERROR);
      expect(firstFunctionCall(retry)?.args?.['retry_count']).toBe(1);

      const success = await pluginManager.runAfterModelCallback({
        callbackContext,
        llmResponse: successResponse(),
      });
      expect(success).toBeUndefined();

      // After recovery, the next failure starts counting again from 1.
      const retryAgain = await pluginManager.runAfterModelCallback({
        callbackContext,
        llmResponse: malformedResponse(),
      });
      expect(firstFunctionCall(retryAgain)?.args?.['retry_count']).toBe(1);
    });
  });
});
