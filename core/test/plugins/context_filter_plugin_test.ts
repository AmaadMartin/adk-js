/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The cases named `test_*` are ported from google/adk-python
// tests/unittests/plugins/test_context_filtering_plugin.py (main), keeping the
// reference names. The rest are added here.

import {
  BaseLlm,
  BaseLlmConnection,
  Context,
  ContextFilterPlugin,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  LogLevel,
  Logger,
  PluginManager,
  getLogger,
  setLogger,
} from '@google/adk';
import {Content} from '@google/genai';
import {afterEach, describe, expect, it} from 'vitest';

/** Collects the `error` calls the plugin makes, and drops everything else. */
class RecordingLogger implements Logger {
  readonly errorCalls: unknown[][] = [];

  log(_level: LogLevel, ..._args: unknown[]): void {}
  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  warn(..._args: unknown[]): void {}
  setLogLevel(_level: LogLevel): void {}

  error(...args: unknown[]): void {
    this.errorCalls.push(args);
  }
}

/** Records the contents of every request the runner sends. */
class RecordingLlm extends BaseLlm {
  readonly sentContents: Content[][] = [];

  constructor() {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.sentContents.push(request.contents);
    yield {content: {role: 'model', parts: [{text: 'ack'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

function createContent(role: string, text: string): Content {
  return {parts: [{text}], role};
}

/** Three complete invocations, enough to trip the default threshold. */
function threeInvocations(): Content[] {
  return [
    createContent('user', 'user_prompt_1'),
    createContent('model', 'model_response_1'),
    createContent('user', 'user_prompt_2'),
    createContent('model', 'model_response_2'),
    createContent('user', 'user_prompt_3'),
    createContent('model', 'model_response_3'),
  ];
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
  const previousLogger = getLogger();

  afterEach(() => {
    setLogger(previousLogger);
  });

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
    const recordingLogger = new RecordingLogger();
    setLogger(recordingLogger);
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
    expect(recordingLogger.errorCalls).toHaveLength(1);
    expect(recordingLogger.errorCalls[0][0]).toBe(
      'Failed to reduce context for request',
    );
    expect(recordingLogger.errorCalls[0][1]).toBeInstanceOf(Error);
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

  it('defaults the plugin name to context_filter_plugin', () => {
    expect(new ContextFilterPlugin().name).toBe('context_filter_plugin');
  });

  it('uses the supplied plugin name', () => {
    expect(new ContextFilterPlugin({name: 'my_filter'}).name).toBe('my_filter');
  });

  it('skips truncation when numInvocationsToKeep is 0 but still filters', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 0,
      customFilter: (contents) => contents.filter((c) => c.role !== 'model'),
    });
    const llmRequest = createLlmRequest(threeInvocations());

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents.map((c) => c.parts?.[0].text)).toEqual([
      'user_prompt_1',
      'user_prompt_2',
      'user_prompt_3',
    ]);
  });

  it('tolerates a content without parts while truncating', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      {role: 'model'},
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents.map((c) => c.parts?.[0].text)).toEqual([
      'user_prompt_2',
      'model_response_2',
    ]);
  });

  it('treats a user content without parts as an invocation start', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      {role: 'user'},
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents.map((c) => c.parts?.[0].text)).toEqual([
      undefined,
      'model_response_2',
    ]);
  });

  it('ignores a function call and response that carry no id', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      {parts: [{functionCall: {name: 'tool_a', args: {}}}], role: 'model'},
      {
        parts: [{functionResponse: {name: 'tool_a', response: {result: 'ok'}}}],
        role: 'user',
      },
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(4);
    expect(llmRequest.contents[0].parts?.[0].text).toBe('user_prompt_2');
  });

  it('moves the split left to keep a call made in an earlier invocation', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      {
        parts: [{functionCall: {id: 'call_1', name: 'tool_a', args: {}}}],
        role: 'model',
      },
      createContent('user', 'user_prompt_3'),
      {
        parts: [
          {
            functionResponse: {
              id: 'call_1',
              name: 'tool_a',
              response: {result: 'ok'},
            },
          },
        ],
        role: 'user',
      },
      createContent('model', 'model_response_3'),
    ]);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toHaveLength(4);
    expect(llmRequest.contents[0].parts?.[0].functionCall?.id).toBe('call_1');
  });

  it('keeps every content when a response can never be paired', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const contents: Content[] = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      {
        parts: [
          {functionResponse: {id: 'orphan', name: 'tool_a', response: {}}},
        ],
        role: 'user',
      },
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createLlmRequest(contents);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual(contents);
  });

  it('accepts an empty array from the custom filter', async () => {
    const plugin = new ContextFilterPlugin({customFilter: () => []});
    const llmRequest = createLlmRequest(threeInvocations());

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(llmRequest.contents).toEqual([]);
  });

  it('resolves to undefined on the happy path and on the error path', async () => {
    const llmRequest = createLlmRequest(threeInvocations());
    const okResult = await new ContextFilterPlugin({
      numInvocationsToKeep: 1,
    }).beforeModelCallback({callbackContext, llmRequest});
    const failResult = await new ContextFilterPlugin({
      customFilter: () => {
        throw new Error('Filter error');
      },
    }).beforeModelCallback({callbackContext, llmRequest});

    expect(okResult).toBeUndefined();
    expect(failResult).toBeUndefined();
  });

  it('does not truncate the caller\u2019s array in place', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const contents = threeInvocations();
    const llmRequest = createLlmRequest(contents);

    await plugin.beforeModelCallback({callbackContext, llmRequest});

    expect(contents).toHaveLength(6);
    expect(llmRequest.contents).toHaveLength(2);
  });

  it('trims the history a runner sends on the third turn', async () => {
    const model = new RecordingLlm();
    const runner = new InMemoryRunner({
      agent: new LlmAgent({name: 'chat_agent', model}),
      plugins: [new ContextFilterPlugin({numInvocationsToKeep: 1})],
    });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'test_user',
    });

    for (const text of ['turn one', 'turn two', 'turn three']) {
      for await (const _event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text}]},
      })) {
        // Drain the stream so the turn completes.
      }
    }

    expect(model.sentContents).toHaveLength(3);
    expect(model.sentContents[2].map((c) => c.parts?.[0].text)).toEqual([
      'turn three',
    ]);
  });
});
