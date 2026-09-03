/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Context,
  ContextFilterPlugin,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

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

function createLlmRequest(contents: Content[]): LlmRequest {
  return {contents, liveConnectConfig: {}, toolsDict: {}};
}

const callbackContext = {
  agentName: 'test_agent',
  invocationId: 'inv-1',
} as unknown as Context;

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

describe('ContextFilterPlugin edge cases', () => {
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
