/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from google/adk-python tests/unittests/models/test_litellm.py.

import {Content, Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

import {
  CompletionRequest,
  contentToMessageParam,
  functionDeclarationToToolParam,
  getContent,
  LiteLlm,
  LiteLlmClient,
  messageToGenerateContentResponse,
  ModelResponse,
  modelResponseToChunk,
  toLiteLlmRole,
} from '../../src/models/lite_llm.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';

async function* toAsyncIterable(
  items: ModelResponse[],
): AsyncGenerator<ModelResponse> {
  for (const item of items) {
    yield item;
  }
}

const NON_STREAMING_RESPONSE: ModelResponse = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'Test response',
        tool_calls: [
          {
            type: 'function',
            id: 'test_tool_call_id',
            function: {
              name: 'test_function',
              arguments: '{"test_arg": "test_value"}',
            },
          },
        ],
      },
    },
  ],
};

const STREAMING_MODEL_RESPONSE: ModelResponse[] = [
  {choices: [{delta: {role: 'assistant', content: 'zero, '}}]},
  {choices: [{delta: {role: 'assistant', content: 'one, '}}]},
  {choices: [{delta: {role: 'assistant', content: 'two:'}}]},
  {
    choices: [
      {
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              id: 'test_tool_call_id',
              function: {
                name: 'test_function',
                arguments: '{"test_arg": "test_',
              },
            },
          ],
        },
      },
    ],
  },
  {
    choices: [
      {
        delta: {
          role: 'assistant',
          tool_calls: [
            {type: 'function', function: {arguments: 'value"}'}},
          ],
        },
      },
    ],
  },
  {choices: [{finish_reason: 'tool_calls', delta: {}}]},
];

function createRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'Test prompt'}]}],
    config: {
      tools: [
        {
          functionDeclarations: [
            {
              name: 'test_function',
              description: 'Test function description',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  test_arg: {type: Type.STRING},
                },
              },
            },
          ],
        },
      ],
    },
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function createMockClient(): {
  client: LiteLlmClient;
  acompletion: ReturnType<typeof vi.fn>;
  completion: ReturnType<typeof vi.fn>;
} {
  const acompletion = vi.fn(
    async (_request: CompletionRequest) => NON_STREAMING_RESPONSE,
  );
  const completion = vi.fn((_request: CompletionRequest) =>
    toAsyncIterable(STREAMING_MODEL_RESPONSE),
  );
  return {client: {acompletion, completion}, acompletion, completion};
}

async function collect(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of generator) {
    responses.push(response);
  }
  return responses;
}

describe('LiteLlm', () => {
  it('test_generate_content_async', async () => {
    const {client, acompletion} = createMockClient();
    const liteLlm = new LiteLlm({model: 'test_model', llmClient: client});

    const responses = await collect(
      liteLlm.generateContentAsync(createRequest()),
    );

    expect(responses).toHaveLength(1);
    const response = responses[0];
    expect(response.content?.role).toBe('model');
    expect(response.content?.parts?.[0].text).toBe('Test response');
    expect(response.content?.parts?.[1].functionCall?.name).toBe(
      'test_function',
    );
    expect(response.content?.parts?.[1].functionCall?.args).toEqual({
      test_arg: 'test_value',
    });
    expect(response.content?.parts?.[1].functionCall?.id).toBe(
      'test_tool_call_id',
    );

    const request = acompletion.mock.calls[0][0] as CompletionRequest;
    expect(request.model).toBe('test_model');
    expect(request.messages[0]).toEqual({role: 'user', content: 'Test prompt'});
    expect(request.tools?.[0].function.name).toBe('test_function');
    expect(request.tools?.[0].function.description).toBe(
      'Test function description',
    );
    expect(request.tools?.[0].function.parameters).toEqual({
      type: 'object',
      properties: {test_arg: {type: 'string'}},
    });
  });

  it('test_generate_content_async_with_system_instruction', async () => {
    const {client, acompletion} = createMockClient();
    const liteLlm = new LiteLlm({model: 'test_model', llmClient: client});
    const llmRequest = createRequest({
      config: {systemInstruction: 'Test system instruction'},
    });

    const responses = await collect(liteLlm.generateContentAsync(llmRequest));

    expect(responses).toHaveLength(1);
    const request = acompletion.mock.calls[0][0] as CompletionRequest;
    expect(request.messages[0]).toEqual({
      role: 'developer',
      content: 'Test system instruction',
    });
    expect(request.messages[1]).toEqual({role: 'user', content: 'Test prompt'});
  });

  it('test_generate_content_async_with_tool_response', async () => {
    const {client, acompletion} = createMockClient();
    const liteLlm = new LiteLlm({model: 'test_model', llmClient: client});
    const llmRequest = createRequest({
      contents: [
        {role: 'user', parts: [{text: 'Test prompt'}]},
        {
          role: 'tool',
          parts: [
            {
              functionResponse: {
                name: 'test_function',
                id: 'test_tool_call_id',
                response: {result: 'test_result'},
              },
            },
          ],
        },
      ],
      config: {systemInstruction: 'test instruction'},
    });

    await collect(liteLlm.generateContentAsync(llmRequest));

    const request = acompletion.mock.calls[0][0] as CompletionRequest;
    expect(request.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'test_tool_call_id',
      content: '{"result":"test_result"}',
    });
  });

  it('test_generate_content_async_stream', async () => {
    const {client, completion} = createMockClient();
    const liteLlm = new LiteLlm({model: 'test_model', llmClient: client});

    const responses = await collect(
      liteLlm.generateContentAsync(createRequest(), true),
    );

    expect(responses).toHaveLength(4);
    expect(responses[0].content?.parts?.[0].text).toBe('zero, ');
    expect(responses[0].partial).toBe(true);
    expect(responses[1].content?.parts?.[0].text).toBe('one, ');
    expect(responses[2].content?.parts?.[0].text).toBe('two:');
    expect(responses[3].partial).toBe(false);
    expect(responses[3].content?.parts?.[0].functionCall).toEqual({
      id: 'test_tool_call_id',
      name: 'test_function',
      args: {test_arg: 'test_value'},
    });

    const request = completion.mock.calls[0][0] as CompletionRequest;
    expect(request.stream).toBe(true);
    expect(request.messages[0]).toEqual({role: 'user', content: 'Test prompt'});
  });

  it('test_acompletion_additional_args', async () => {
    const {client, acompletion} = createMockClient();
    const liteLlm = new LiteLlm({
      model: 'test_model',
      llmClient: client,
      additionalArgs: {temperature: 0.5, messages: [], tools: [], stream: true},
    });

    await collect(liteLlm.generateContentAsync(createRequest()));

    const request = acompletion.mock.calls[0][0] as CompletionRequest;
    expect(request.additionalArgs).toEqual({temperature: 0.5});
    expect(request.stream).toBeUndefined();
  });

  it('test_completion_additional_args', async () => {
    const {client, completion} = createMockClient();
    const liteLlm = new LiteLlm({
      model: 'test_model',
      llmClient: client,
      additionalArgs: {temperature: 0.5, messages: [], tools: []},
    });

    await collect(liteLlm.generateContentAsync(createRequest(), true));

    const request = completion.mock.calls[0][0] as CompletionRequest;
    expect(request.additionalArgs).toEqual({temperature: 0.5});
    expect(request.stream).toBe(true);
  });

  it('rejects live connections', async () => {
    const {client} = createMockClient();
    const liteLlm = new LiteLlm({model: 'test_model', llmClient: client});
    await expect(liteLlm.connect()).rejects.toThrow(
      'Live connection is not supported',
    );
  });
});

describe('lite_llm conversions', () => {
  it('test_content_to_message_param_user_message', () => {
    const content: Content = {role: 'user', parts: [{text: 'Test prompt'}]};
    expect(contentToMessageParam(content)).toEqual({
      role: 'user',
      content: 'Test prompt',
    });
  });

  it('test_content_to_message_param_assistant_message', () => {
    const content: Content = {
      role: 'assistant',
      parts: [{text: 'Test response'}],
    };
    expect(contentToMessageParam(content)).toEqual({
      role: 'assistant',
      content: 'Test response',
    });
  });

  it('test_content_to_message_param_function_call', () => {
    const content: Content = {
      role: 'assistant',
      parts: [
        {
          functionCall: {
            id: 'test_tool_call_id',
            name: 'test_function',
            args: {test_arg: 'test_value'},
          },
        },
      ],
    };
    const message = contentToMessageParam(content);
    expect(message.role).toBe('assistant');
    expect(message.content).toEqual([]);
    expect(message.role === 'assistant' && message.tool_calls).toEqual([
      {
        type: 'function',
        id: 'test_tool_call_id',
        function: {
          name: 'test_function',
          arguments: '{"test_arg":"test_value"}',
        },
      },
    ]);
  });

  it('test_message_to_generate_content_response_text', () => {
    const response = messageToGenerateContentResponse({
      role: 'assistant',
      content: 'Test response',
    });
    expect(response.content?.role).toBe('model');
    expect(response.content?.parts?.[0].text).toBe('Test response');
  });

  it('test_message_to_generate_content_response_tool_call', () => {
    const response = messageToGenerateContentResponse({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          type: 'function',
          id: 'test_tool_call_id',
          function: {
            name: 'test_function',
            arguments: '{"test_arg": "test_value"}',
          },
        },
      ],
    });
    expect(response.content?.role).toBe('model');
    expect(response.content?.parts?.[0].functionCall).toEqual({
      id: 'test_tool_call_id',
      name: 'test_function',
      args: {test_arg: 'test_value'},
    });
  });

  it('test_get_content_text', () => {
    expect(getContent([{text: 'Test text'}])).toBe('Test text');
  });

  it('test_get_content_image', () => {
    expect(
      getContent([{inlineData: {mimeType: 'image/png', data: 'dGVzdA=='}}]),
    ).toEqual([{type: 'image_url', image_url: 'data:image/png;base64,dGVzdA=='}]);
  });

  it('test_get_content_video', () => {
    expect(
      getContent([{inlineData: {mimeType: 'video/mp4', data: 'dGVzdA=='}}]),
    ).toEqual([{type: 'video_url', video_url: 'data:video/mp4;base64,dGVzdA=='}]);
  });

  it('throws for inline data that is neither image nor video', () => {
    expect(() =>
      getContent([
        {inlineData: {mimeType: 'application/pdf', data: 'dGVzdA=='}},
      ]),
    ).toThrow('does not support this content part');
  });

  it('returns a text part list when there are several parts', () => {
    expect(
      getContent([
        {text: 'Look:'},
        {inlineData: {mimeType: 'image/png', data: 'dGVzdA=='}},
      ]),
    ).toEqual([
      {type: 'text', text: 'Look:'},
      {type: 'image_url', image_url: 'data:image/png;base64,dGVzdA=='},
    ]);
  });

  it('test_to_litellm_role', () => {
    expect(toLiteLlmRole('model')).toBe('assistant');
    expect(toLiteLlmRole('assistant')).toBe('assistant');
    expect(toLiteLlmRole('user')).toBe('user');
    expect(toLiteLlmRole(undefined)).toBe('user');
  });

  it.each<[string, ModelResponse, [unknown, string | null][]]>([
    [
      'message',
      {choices: [{message: {content: 'this is a test'}}]},
      [[{text: 'this is a test'}, null]],
    ],
    [
      'delta',
      {choices: [{delta: {content: 'this is a test'}}]},
      [[{text: 'this is a test'}, null]],
    ],
    [
      'finish reason only',
      {choices: [{finish_reason: 'stop', delta: {}}]},
      [[null, 'stop']],
    ],
    [
      'tool call',
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  type: 'function',
                  id: '1',
                  function: {name: 'test_function', arguments: '{"key": "va'},
                },
              ],
            },
          },
        ],
      },
      [[{id: '1', name: 'test_function', args: '{"key": "va'}, null]],
    ],
    ['empty', {choices: []}, [[null, null]]],
  ])('test_model_response_to_chunk (%s)', (_name, response, expected) => {
    expect([...modelResponseToChunk(response)]).toEqual(expected);
  });

  it('keeps required parameters when converting a function declaration', () => {
    const tool = functionDeclarationToToolParam({
      name: 'lookup',
      parameters: {
        type: Type.OBJECT,
        properties: {
          ids: {type: Type.ARRAY, items: {type: Type.INTEGER}},
        },
        required: ['ids'],
      },
    });
    expect(tool.function).toEqual({
      name: 'lookup',
      description: '',
      parameters: {
        type: 'object',
        properties: {ids: {type: 'array', items: {type: 'integer'}}},
        required: ['ids'],
      },
    });
  });

  it('throws when a function declaration has no name', () => {
    expect(() => functionDeclarationToToolParam({})).toThrow(
      'must have a name',
    );
  });
});
