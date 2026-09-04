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
  createSession,
  getLogger,
  setLogger,
} from '@google/adk';
import {Content} from '@google/genai';
import {afterEach, describe, expect, it} from 'vitest';

function createContent(role: string, text: string): Content {
  return {role, parts: [{text}]};
}

function createFunctionCallContent(name: string, callId: string): Content {
  return {role: 'model', parts: [{functionCall: {id: callId, name, args: {}}}]};
}

function createFunctionResponseContent(name: string, callId: string): Content {
  return {
    role: 'user',
    parts: [{functionResponse: {id: callId, name, response: {result: 'ok'}}}],
  };
}

function createLlmRequest(contents: Content[]): LlmRequest {
  return {contents, liveConnectConfig: {}, toolsDict: {}};
}

function createCallbackContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'user-1',
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

/** Returns the text of every part, in order. */
function textsOf(contents: Content[]): string[] {
  return contents
    .flatMap((content) => content.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => text !== undefined);
}

/** Returns the function call ids and the function response ids, in order. */
function functionIdsOf(contents: Content[]): {
  callIds: string[];
  responseIds: string[];
} {
  const parts = contents.flatMap((content) => content.parts ?? []);
  return {
    callIds: parts
      .map((part) => part.functionCall?.id)
      .filter((id): id is string => id !== undefined),
    responseIds: parts
      .map((part) => part.functionResponse?.id)
      .filter((id): id is string => id !== undefined),
  };
}

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
    throw new Error('Live connections are not supported by RecordingLlm.');
  }
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
      'user_prompt_1',
      'user_prompt_2',
    ]);
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual([]);
  });

  it('test_no_filtering_when_no_options_provided', async () => {
    const plugin = new ContextFilterPlugin();
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ];
    const llmRequest = createLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(contents);
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
      'user_prompt_2a',
      'user_prompt_2b',
      'model_response_2',
    ]);
  });

  it('test_last_n_invocations_more_than_existing_invocations', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 3});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(contents);
  });

  it('test_filter_function_raises_exception', async () => {
    const recordingLogger = new RecordingLogger();
    setLogger(recordingLogger);
    const plugin = new ContextFilterPlugin({
      customFilter: () => {
        throw new Error('Filter error');
      },
    });
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ];
    const llmRequest = createLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(contents);
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    const {callIds, responseIds} = functionIdsOf(llmRequest.contents);
    expect(responseIds).toEqual(['call_1', 'call_2']);
    expect(callIds).toEqual(['call_1', 'call_2']);
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
      'Do task',
      'Done with tasks',
    ]);
    const {callIds, responseIds} = functionIdsOf(llmRequest.contents);
    expect(responseIds).toEqual(['call_a', 'call_b']);
    expect(callIds).toEqual(['call_a', 'call_b']);
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
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

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
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
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createContent('model', 'model_response_3'),
    ];
    const llmRequest = createLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(contents);
  });

  it('defaults the plugin name, and accepts a supplied one', () => {
    expect(new ContextFilterPlugin().name).toBe('context_filter_plugin');
    expect(new ContextFilterPlugin({name: 'trimmer'}).name).toBe('trimmer');
  });

  it('skips truncation when numInvocationsToKeep is 0, and still filters', async () => {
    const plugin = new ContextFilterPlugin({
      numInvocationsToKeep: 0,
      customFilter: (contents) => contents.filter((c) => c.role === 'user'),
    });
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
      'user_prompt_1',
      'user_prompt_2',
    ]);
  });

  it('truncates a conversation that holds a content with no parts', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      {role: 'model'},
    ]);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual([
      createContent('user', 'user_prompt_2'),
      {role: 'model'},
    ]);
  });

  it('treats a user content with no parts as an invocation start', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      {role: 'user'},
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual([
      {role: 'user'},
      createContent('model', 'model_response_2'),
    ]);
  });

  it('moves the split left to keep a call whose response lands in a later invocation', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createFunctionCallContent('slow_tool', 'call_1'),
      createContent('user', 'user_prompt_2'),
      createFunctionResponseContent('slow_tool', 'call_1'),
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(textsOf(llmRequest.contents)).toEqual([
      'user_prompt_2',
      'model_response_2',
    ]);
    const {callIds, responseIds} = functionIdsOf(llmRequest.contents);
    expect(callIds).toEqual(['call_1']);
    expect(responseIds).toEqual(['call_1']);
  });

  it('ignores a call and a response that carry no id', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      {role: 'model', parts: [{functionCall: {name: 'slow_tool', args: {}}}]},
      createContent('user', 'user_prompt_2'),
      {
        role: 'user',
        parts: [{functionResponse: {name: 'slow_tool', response: {}}}],
      },
      createContent('model', 'model_response_2'),
    ]);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toHaveLength(3);
    expect(textsOf(llmRequest.contents)).toEqual([
      'user_prompt_2',
      'model_response_2',
    ]);
  });

  it('keeps every content when a response can never be paired', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
      createContent('user', 'user_prompt_3'),
      createFunctionResponseContent('vanished_tool', 'call_missing'),
      createContent('model', 'model_response_3'),
    ];
    const llmRequest = createLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual(contents);
  });

  it('uses the empty array a custom filter returns', async () => {
    const plugin = new ContextFilterPlugin({customFilter: () => []});
    const llmRequest = createLlmRequest([
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
    ]);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(llmRequest.contents).toEqual([]);
  });

  it('resolves to undefined on the happy path and on the error path', async () => {
    setLogger(new RecordingLogger());
    const filtering = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const throwing = new ContextFilterPlugin({
      customFilter: () => {
        throw new Error('Filter error');
      },
    });
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
    ];

    await expect(
      filtering.beforeModelCallback({
        callbackContext: createCallbackContext(),
        llmRequest: createLlmRequest([...contents]),
      }),
    ).resolves.toBeUndefined();
    await expect(
      throwing.beforeModelCallback({
        callbackContext: createCallbackContext(),
        llmRequest: createLlmRequest([...contents]),
      }),
    ).resolves.toBeUndefined();
  });

  it('does not truncate the caller\u2019s array in place', async () => {
    const plugin = new ContextFilterPlugin({numInvocationsToKeep: 1});
    const contents = [
      createContent('user', 'user_prompt_1'),
      createContent('model', 'model_response_1'),
      createContent('user', 'user_prompt_2'),
      createContent('model', 'model_response_2'),
    ];
    const llmRequest = createLlmRequest(contents);

    await plugin.beforeModelCallback({
      callbackContext: createCallbackContext(),
      llmRequest,
    });

    expect(contents).toHaveLength(4);
    expect(llmRequest.contents).not.toBe(contents);
  });

  it('truncates the request a runner sends on the third turn', async () => {
    const llm = new RecordingLlm();
    const runner = new InMemoryRunner({
      agent: new LlmAgent({name: 'chat', model: llm}),
      plugins: [new ContextFilterPlugin({numInvocationsToKeep: 1})],
    });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: 'user-1',
    });

    for (const text of ['turn 1', 'turn 2', 'turn 3']) {
      for await (const _event of runner.runAsync({
        userId: 'user-1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text}]},
      })) {
        // Drain the stream so the turn completes before the next one starts.
      }
    }

    expect(llm.sentContents).toHaveLength(3);
    expect(textsOf(llm.sentContents[0])).toEqual(['turn 1']);
    expect(textsOf(llm.sentContents[2])).toEqual(['turn 3']);
  });
});
