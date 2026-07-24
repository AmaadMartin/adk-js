/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {afterEach, describe, expect, it} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {ContextFilterPlugin} from '../../src/plugins/context_filter_plugin.js';
import {Logger, resetLogger, setLogger} from '../../src/utils/logger.js';

// The plugin never reads the callback context, so a minimal cast suffices.
const callbackContext = {} as unknown as Context;

function createContent(role: string, text: string): Content {
  return {role, parts: [{text}]};
}

function createFunctionCallContent(name: string, callId: string): Content {
  return {
    role: 'model',
    parts: [{functionCall: {id: callId, name, args: {}}}],
  };
}

function createFunctionResponseContent(name: string, callId: string): Content {
  return {
    role: 'user',
    parts: [{functionResponse: {id: callId, name, response: {result: 'ok'}}}],
  };
}

function makeLlmRequest(contents: Content[]): LlmRequest {
  return {contents} as unknown as LlmRequest;
}

/** Collects every `part.text` across the request contents. */
function collectTexts(contents: Content[]): string[] {
  const texts: string[] = [];
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.text) {
        texts.push(part.text);
      }
    }
  }
  return texts;
}

/** Collects the sets of function_call ids and function_response ids present. */
function collectCallAndResponseIds(contents: Content[]): {
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

function isSubset(subset: Set<string>, superset: Set<string>): boolean {
  return [...subset].every((value) => superset.has(value));
}

describe('ContextFilterPlugin', () => {
  afterEach(() => {
    resetLogger();
  });

  it('truncates the context to the last N invocations', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(2);
    expect(llmRequest.contents[0].parts?.[0].text).toBe('user_prompt_2');
    expect(llmRequest.contents[1].parts?.[0].text).toBe('model_response_2');
  });

  it('applies a custom filter function to the context', async () => {
    const plugin = new ContextFilterPlugin({
      customFilter: (contents) => contents.filter((c) => c.role !== 'model'),
    });
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(2);
    expect(llmRequest.contents.every((c) => c.role === 'user')).toBe(true);
  });

  it('applies truncation before the custom filter', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 1,
      customFilter: (contents) => contents.slice(2),
    });
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    // Truncation keeps the last invocation (2 contents); slice(2) empties it.
    expect(llmRequest.contents).toHaveLength(0);
  });

  it('does not filter when no options are provided', async () => {
    const plugin = new ContextFilterPlugin();
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ];
    const llmRequest = makeLlmRequest(contents);
    const originalContents = [...contents];

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual(originalContents);
  });

  it('treats consecutive user turns as a single invocation', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2a'),
      createContent('user', 'user_prompt_2b'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(3);
    expect(llmRequest.contents[0].parts?.[0].text).toBe('user_prompt_2a');
    expect(llmRequest.contents[1].parts?.[0].text).toBe('user_prompt_2b');
    expect(llmRequest.contents[2].parts?.[0].text).toBe('model_response_2');
  });

  it('does not filter when keep count exceeds existing invocations', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 3});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = makeLlmRequest(contents);
    const originalContents = [...contents];

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual(originalContents);
  });

  it('leaves contents untouched when the custom filter throws', async () => {
    const errorCalls: string[] = [];
    const captureLogger: Logger = {
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (...args: unknown[]) => {
        errorCalls.push(args.map((a) => String(a)).join(' '));
      },
    };
    setLogger(captureLogger);

    const plugin = new ContextFilterPlugin({
      customFilter: () => {
        throw new Error('Filter error');
      },
    });
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ];
    const llmRequest = makeLlmRequest(contents);
    const originalContents = [...contents];

    await expect(
      plugin.beforeModelCallback({callbackContext, llmRequest}),
    ).resolves.toBeUndefined();

    expect(llmRequest.contents).toEqual(originalContents);
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]).toContain('Failed to reduce context for request');
  });

  it('preserves function_call/function_response pairs (google/adk-python#4027)', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 2});
    const llmRequest = makeLlmRequest([
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

    const {callIds, responseIds} = collectCallAndResponseIds(
      llmRequest.contents,
    );
    expect(isSubset(responseIds, callIds)).toBe(true);
  });

  it('avoids orphans across nested function calls', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = makeLlmRequest([
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

    const texts = collectTexts(llmRequest.contents);
    expect(texts).toContain('Do task');
    expect(texts).toContain('Done with tasks');
    expect(texts).not.toContain('Hello');
    expect(texts).not.toContain('Hi!');

    const {callIds, responseIds} = collectCallAndResponseIds(
      llmRequest.contents,
    );
    expect(isSubset(responseIds, callIds)).toBe(true);
  });

  it('keeps the user prompt of a multi-turn tool-call invocation', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createFunctionCallContent('get_weather', 'call_1'),
      createFunctionResponseContent('get_weather', 'call_1'),
      createContent('model', 'final_answer_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    const texts = collectTexts(llmRequest.contents);
    expect(texts).toContain('user_prompt_2');
    expect(texts).toContain('final_answer_2');
  });

  it('honors removeAmount when removing additional invocations', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 2,
      removeAmount: 1,
    });
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(4);
    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_2',
      'model_response_2',
      'user_prompt_3',
      'model_response_3',
    ]);
  });

  it('honors a higher removeAmount', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 3,
      removeAmount: 2,
    });
    const llmRequest = makeLlmRequest([
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

    expect(llmRequest.contents).toHaveLength(6);
    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_3',
      'model_response_3',
      'user_prompt_4',
      'model_response_4',
      'user_prompt_5',
      'model_response_5',
    ]);
  });

  it('throws when removeAmount is less than 1', () => {
    expect(
      () => new ContextFilterPlugin({numInvocationsToKeep: 1, removeAmount: 0}),
    ).toThrow('removeAmount must be at least 1');
    expect(
      () =>
        new ContextFilterPlugin({numInvocationsToKeep: 1, removeAmount: -1}),
    ).toThrow('removeAmount must be at least 1');
  });

  it('honors removeAmount with multiple user turns per invocation', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 2,
      removeAmount: 1,
    });
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2a'),
      createContent('user', 'user_prompt_2b'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(5);
    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_2a',
      'user_prompt_2b',
      'model_response_2',
      'user_prompt_3',
      'model_response_3',
    ]);
  });

  it('bypasses filtering under the remove threshold', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 2,
      removeAmount: 2,
    });
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ];
    const llmRequest = makeLlmRequest(contents);
    const originalContents = [...contents];

    // keep=2 + remove=2 => threshold 4; only 3 invocations exist.
    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual(originalContents);
  });

  // adk-js-specific coverage add-ons.

  it('defaults the plugin name to context_filter_plugin', () => {
    expect(new ContextFilterPlugin().name).toBe('context_filter_plugin');
  });

  it('accepts a custom plugin name', () => {
    expect(new ContextFilterPlugin({name: 'custom'}).name).toBe('custom');
  });

  it('skips truncation when numInvocationsToKeep is 0 but still filters', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 0,
      customFilter: (contents) => contents.filter((c) => c.role !== 'model'),
    });
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(2);
    expect(llmRequest.contents.every((c) => c.role === 'user')).toBe(true);
  });

  it('tolerates contents without parts during truncation', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      {role: 'model'}, // no parts
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(2);
    expect(llmRequest.contents[0].parts?.[0].text).toBe('user_prompt_3');
    expect(llmRequest.contents[1].parts).toBeUndefined();
  });

  it('ignores function parts that lack ids during pairing checks', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = makeLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      {role: 'model', parts: [{functionCall: {name: 'tool'}}]},
      {role: 'user', parts: [{functionResponse: {name: 'tool'}}]},
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    // Truncation keeps the last invocation starting at user_prompt_2.
    expect(collectTexts(llmRequest.contents)).toEqual([
      'user_prompt_2',
      'model_response_2',
    ]);
  });

  it('falls back to keeping all contents when a response is orphaned', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      // A function_response whose matching function_call is absent everywhere.
      createFunctionResponseContent('ghost_tool', 'orphan_call'),
    ];
    const llmRequest = makeLlmRequest(contents);
    const originalContents = [...contents];

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    // The orphan forces the split index to 0, so nothing is dropped.
    expect(llmRequest.contents).toEqual(originalContents);
  });
});
