/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from google/adk-python
// tests/unittests/plugins/test_context_filtering_plugin.py (main).

import {
  Context,
  ContextFilterPlugin,
  InvocationContext,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

function createContent(role: string, text: string): Content {
  return {parts: [{text}], role};
}

function createFunctionCallContent(name: string, callId: string): Content {
  return {
    parts: [{functionCall: {id: callId, name, args: {}}}],
    role: 'model',
  };
}

function createFunctionResponseContent(name: string, callId: string): Content {
  return {
    parts: [{functionResponse: {id: callId, name, response: {result: 'ok'}}}],
    role: 'user',
  };
}

function createLlmRequest(contents: Content[]): LlmRequest {
  return {contents, liveConnectConfig: {}, toolsDict: {}};
}

const callbackContext = new Context({
  invocationContext: new InvocationContext({
    invocationId: 'inv-1',
    session: {
      id: 'session-1',
      appName: 'test-app',
      userId: 'test-user',
      state: {},
      events: [],
      lastUpdateTime: 0,
    },
    pluginManager: new PluginManager(),
  }),
});

/** Collects the text of every part of every content, in order. */
function collectTexts(contents: Content[]): string[] {
  return contents.flatMap((content) =>
    (content.parts ?? []).flatMap((part) => (part.text ? [part.text] : [])),
  );
}

/** Collects the function call ids and the function response ids separately. */
function collectPairIds(contents: Content[]): {
  callIds: Set<string>;
  responseIds: Set<string>;
} {
  const callIds = new Set<string>();
  const responseIds = new Set<string>();
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.functionCall?.id) {
        callIds.add(part.functionCall.id);
      }
      if (part.functionResponse?.id) {
        responseIds.add(part.functionResponse.id);
      }
    }
  }
  return {callIds, responseIds};
}

describe('ContextFilterPlugin', () => {
  it('test_filter_last_n_invocations', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_2',
      'model_response_2',
    ]);
  });

  it('test_filter_with_function', async () => {
    const plugin = new ContextFilterPlugin({
      customFilter: (contents) => contents.filter((c) => c.role !== 'model'),
    });
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(2);
    expect(llmRequest.contents.every((c) => c.role === 'user')).toBe(true);
  });

  it('test_filter_with_function_and_last_n_invocations', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 1,
      customFilter: (contents) => contents.slice(2),
    });
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(0);
  });

  it('test_no_filtering_when_no_options_provided', async () => {
    const plugin = new ContextFilterPlugin();
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ]);
    const originalContents = [...llmRequest.contents];

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual(originalContents);
  });

  it('test_last_n_invocations_with_multiple_user_turns', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2a'),
      createContent('user', 'user_prompt_2b'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_2a',
      'user_prompt_2b',
      'model_response_2',
    ]);
  });

  it('test_last_n_invocations_more_than_existing_invocations', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 3});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ]);
    const originalContents = [...llmRequest.contents];

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual(originalContents);
  });

  it('test_filter_function_raises_exception', async () => {
    const plugin = new ContextFilterPlugin({
      customFilter: () => {
        throw new Error('Filter error');
      },
    });
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ]);
    const originalContents = [...llmRequest.contents];

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual(originalContents);
  });

  it('test_filter_preserves_function_call_response_pairs', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 2});
    const llmRequest = createLlmRequest([
      createContent('user', 'Hello'),
      createContent('model', 'Hi there!'),
      createContent('user', 'I want to know about X'),
      createFunctionCallContent('knowledge_base', 'call_1'),
      createFunctionResponseContent('knowledge_base', 'call_1'),
      createContent('model', 'I found some information...'),
      createContent('user', 'can you explain more about Y'),
      createFunctionCallContent('knowledge_base', 'call_2'),
      createFunctionResponseContent('knowledge_base', 'call_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    const {callIds, responseIds} = collectPairIds(llmRequest.contents);
    expect(responseIds.size).toBeGreaterThan(0);
    for (const responseId of responseIds) {
      expect(callIds).toContain(responseId);
    }
  });

  it('test_filter_with_nested_function_calls', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'Hello'),
      createContent('model', 'Hi!'),
      createContent('user', 'Do task'),
      createFunctionCallContent('tool_a', 'call_a'),
      createFunctionResponseContent('tool_a', 'call_a'),
      createFunctionCallContent('tool_b', 'call_b'),
      createFunctionResponseContent('tool_b', 'call_b'),
      createContent('model', 'Done with tasks'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(collectTexts(llmRequest.contents)).toEqual([
      'Do task',
      'Done with tasks',
    ]);
    const {callIds, responseIds} = collectPairIds(llmRequest.contents);
    expect(responseIds.size).toBeGreaterThan(0);
    for (const responseId of responseIds) {
      expect(callIds).toContain(responseId);
    }
  });

  it('test_last_invocation_with_tool_call_keeps_user_prompt', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createFunctionCallContent('get_weather', 'call_1'),
      createFunctionResponseContent('get_weather', 'call_1'),
      createContent('model', 'final_answer_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_2',
      'final_answer_2',
    ]);
  });

  it('test_filter_with_remove_amount', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 2,
      removeAmount: 1,
    });
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_2',
      'model_response_2',
      'user_prompt_3',
      'model_response_3',
    ]);
  });

  it('test_filter_with_higher_remove_amount', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 3,
      removeAmount: 2,
    });
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
      createContent('user', 'user_prompt_4'),
      createContent('model', 'model_response_4'),
      createContent('user', 'user_prompt_5'),
      createContent('model', 'model_response_5'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_3',
      'model_response_3',
      'user_prompt_4',
      'model_response_4',
      'user_prompt_5',
      'model_response_5',
    ]);
  });

  it('test_invalid_remove_amount', () => {
    expect(
      () => new ContextFilterPlugin({numInvocationsToKeep: 1, removeAmount: 0}),
    ).toThrow('removeAmount must be at least 1.');
    expect(
      () =>
        new ContextFilterPlugin({numInvocationsToKeep: 1, removeAmount: -1}),
    ).toThrow('removeAmount must be at least 1.');
  });

  it('test_filter_remove_amount_with_multiple_user_turns', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 2,
      removeAmount: 1,
    });
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2a'),
      createContent('user', 'user_prompt_2b'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_2a',
      'user_prompt_2b',
      'model_response_2',
      'user_prompt_3',
      'model_response_3',
    ]);
  });

  it('test_filter_bypass_when_under_remove_threshold', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 2,
      removeAmount: 2,
    });
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ]);
    const originalContents = [...llmRequest.contents];

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual(originalContents);
  });
});
