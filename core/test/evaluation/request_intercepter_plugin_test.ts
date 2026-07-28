/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {
  LLM_REQUEST_ID_KEY,
  RequestIntercepterPlugin,
} from '../../src/evaluation/request_intercepter_plugin.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';

function makeLlmRequest(): LlmRequest {
  return {
    model: 'test_model',
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

function makeCallbackContext(): Context {
  const invocationContext = {
    session: {state: {}},
    abortSignal: undefined,
  } as unknown as InvocationContext;
  return new Context({invocationContext});
}

describe('RequestIntercepterPlugin', () => {
  it('intercepts a request and couples it with the response', async () => {
    const plugin = new RequestIntercepterPlugin('test_plugin');
    const llmRequest = makeLlmRequest();
    const callbackContext = makeCallbackContext();
    const llmResponse: LlmResponse = {};

    const beforeResult = await plugin.beforeModelCallback({
      callbackContext,
      llmRequest,
    });
    expect(beforeResult).toBeUndefined();
    expect(callbackContext.state.has(LLM_REQUEST_ID_KEY)).toBe(true);
    const requestId = callbackContext.state.get(LLM_REQUEST_ID_KEY);
    expect(typeof requestId).toBe('string');

    const afterResult = await plugin.afterModelCallback({
      callbackContext,
      llmResponse,
    });
    expect(afterResult).toBeUndefined();
    expect(llmResponse.customMetadata).toBeDefined();
    expect(llmResponse.customMetadata?.[LLM_REQUEST_ID_KEY]).toBe(requestId);

    expect(plugin.getModelRequest(llmResponse)).toBe(llmRequest);
  });

  it('preserves existing customMetadata in afterModelCallback', async () => {
    const plugin = new RequestIntercepterPlugin('test_plugin');
    const callbackContext = makeCallbackContext();
    const llmResponse: LlmResponse = {customMetadata: {foo: 'bar'}};

    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: makeLlmRequest(),
    });
    await plugin.afterModelCallback({callbackContext, llmResponse});

    expect(llmResponse.customMetadata?.foo).toBe('bar');
    expect(llmResponse.customMetadata?.[LLM_REQUEST_ID_KEY]).toBeDefined();
  });

  it('does not stamp metadata when no request id is in state', async () => {
    const plugin = new RequestIntercepterPlugin('test_plugin');
    const llmResponse: LlmResponse = {};

    await plugin.afterModelCallback({
      callbackContext: makeCallbackContext(),
      llmResponse,
    });

    expect(llmResponse.customMetadata).toBeUndefined();
  });

  it('getModelRequest returns undefined without metadata', () => {
    const plugin = new RequestIntercepterPlugin('test_plugin');
    expect(plugin.getModelRequest({})).toBeUndefined();
  });

  it('getModelRequest returns undefined for an unknown request id', () => {
    const plugin = new RequestIntercepterPlugin('test_plugin');
    const llmResponse: LlmResponse = {
      customMetadata: {[LLM_REQUEST_ID_KEY]: 'non_existent_id'},
    };
    expect(plugin.getModelRequest(llmResponse)).toBeUndefined();
  });
});
