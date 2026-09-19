/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python reference tests for the labs OpenAI Responses model, ported.
 *
 * Source: `tests/unittests/labs/openai/test_openai_responses_llm.py` on
 * adk-python `main` at commit `a119dd77`. Each `it(...)` title is the Python
 * test name, verbatim, so the two suites can be compared by name. Two of the
 * 48 Python tests are not here:
 * `test_enforce_strict_openai_schema_handles_nested_refs`, which
 * `openai_schema_test.ts` already covers, and
 * `test_response_parsing_accepts_openai_sdk_response_types`, which has no
 * counterpart because every fixture below is already an SDK type.
 */

import {
  AzureOpenAIResponsesLlm,
  LlmRequest,
  LlmResponse,
  OpenAIResponsesClient,
  OpenAIResponsesLlm,
  OpenAIResponsesLlmParams,
  ResponsesRequestBodyWithExtras,
} from '@google/adk';
import {
  Content,
  FinishReason,
  FunctionCallingConfigMode,
  GenerateContentConfig,
  Language,
  Outcome,
  ThinkingLevel,
  Type,
} from '@google/genai';
import type {OpenAI} from 'openai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  contentToResponseInputItems,
  functionDeclarationToResponseTool,
  loadsJsonObject,
  responseToLlmResponse,
  toolChoice,
} from '../../src/models/openai_responses_converters.js';
import {requireSyncApiKey} from '../../src/models/openai_responses_llm.js';
import {logger} from '../../src/utils/logger.js';

import {
  argumentsDeltaEvent,
  argumentsDoneEvent,
  completedEvent,
  createdEvent,
  failedEvent,
  FakeResponsesClient,
  functionCallItem,
  incompleteEvent,
  itemAddedEvent,
  itemDoneEvent,
  makeResponse,
  makeUsage,
  messageItem,
  reasoningItem,
  summaryDeltaEvent,
  summaryDoneEvent,
  textDeltaEvent,
} from './openai_responses_test_doubles.js';

const defaultClient = vi.hoisted(() => ({
  instance: undefined as OpenAIResponsesClient | undefined,
}));

const openAiConstructor = vi.hoisted(() =>
  vi.fn(function OpenAI(this: unknown) {
    return defaultClient.instance;
  }),
);

vi.mock('openai', () => ({OpenAI: openAiConstructor}));

/**
 * The Responses types the port names.
 *
 * This replaces the Python test that asserts the SDK exports each symbol: a
 * missing type is a compile error here, which is the same drift signal.
 */
type RequiredResponsesTypes = [
  OpenAI.Responses.EasyInputMessage,
  OpenAI.Responses.FunctionTool,
  OpenAI.Responses.Response,
  OpenAI.Responses.ResponseFunctionToolCall,
  OpenAI.Responses.ResponseIncludable,
  OpenAI.Responses.ResponseInputContent,
  OpenAI.Responses.ResponseInputFile,
  OpenAI.Responses.ResponseInputImage,
  OpenAI.Responses.ResponseInputItem,
  OpenAI.Responses.ResponseInputText,
  OpenAI.Responses.ResponseOutputMessage,
  OpenAI.Responses.ResponseOutputRefusal,
  OpenAI.Responses.ResponseOutputText,
  OpenAI.Responses.ResponseReasoningItem,
  OpenAI.Responses.ResponseStreamEvent,
  OpenAI.Responses.ResponseUsage,
  OpenAI.Responses.ServiceTier,
  OpenAI.Responses.Tool,
  OpenAI.Reasoning,
];

/** Drains an ADK response stream. */
async function collect(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

/** Builds a one-turn user request. */
function userRequest(
  config: GenerateContentConfig = {},
  overrides: Partial<LlmRequest> = {},
): LlmRequest {
  return {
    model: 'gpt-5',
    contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    config,
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

/**
 * Returns the body the model sent for one request.
 *
 * adk-python asserts on `_get_response_create_kwargs` directly. That method is
 * private here, so the assertions run against what an injected client received
 * instead.
 */
async function sentBody(
  params: OpenAIResponsesLlmParams,
  llmRequest: LlmRequest,
): Promise<ResponsesRequestBodyWithExtras> {
  const client = new FakeResponsesClient({
    response: makeResponse({status: 'completed'}),
  });
  const llm = new OpenAIResponsesLlm({...params, client});
  await collect(llm.generateContentAsync(llmRequest));
  return client.body;
}

/** Runs a streamed generation against a canned event list. */
async function streamed(
  params: OpenAIResponsesLlmParams,
  events: OpenAI.Responses.ResponseStreamEvent[],
): Promise<LlmResponse[]> {
  const client = new FakeResponsesClient({events});
  const llm = new OpenAIResponsesLlm({...params, client});
  return collect(llm.generateContentAsync(userRequest(), true));
}

describe('OpenAIResponsesLlm', () => {
  beforeEach(() => {
    openAiConstructor.mockClear();
    defaultClient.instance = new FakeResponsesClient({
      response: makeResponse({status: 'completed'}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('test_openai_responses_package_exports_required_types', () => {
    const declaredTypeCount: RequiredResponsesTypes['length'] = 19;
    expect(declaredTypeCount).toBe(19);
  });

  it('test_request_kwargs_use_responses_api_shape', async () => {
    const body = await sentBody(
      {
        model: 'gpt-5',
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoning: {effort: 'medium'},
      },
      {
        model: 'gpt-5-mini',
        previousInteractionId: 'resp_previous',
        contents: [
          {role: 'user', parts: [{text: 'What is the weather?'}]},
          {
            role: 'tool',
            parts: [
              {
                functionResponse: {
                  id: 'call_weather',
                  name: 'get_weather',
                  response: {temperature: '70 F'},
                },
              },
            ],
          },
        ],
        config: {
          systemInstruction: 'You are concise.',
          temperature: 0.2,
          topP: 0.9,
          maxOutputTokens: 128,
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_weather',
                  description: 'Get weather',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {location: {type: Type.STRING}},
                    required: ['location'],
                  },
                },
              ],
            },
          ],
        },
        liveConnectConfig: {},
        toolsDict: {},
      },
    );

    expect(body.model).toBe('gpt-5-mini');
    expect(body.instructions).toBe('You are concise.');
    expect(body.previous_response_id).toBe('resp_previous');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.max_output_tokens).toBe(128);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.reasoning).toEqual({effort: 'medium'});
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'What is the weather?'}],
      },
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        output: '{"temperature":"70 F"}',
      },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: {location: {type: 'string'}},
          required: ['location'],
        },
        strict: false,
      },
    ]);
  });

  it('test_content_mapping_preserves_model_tool_calls_and_reasoning', () => {
    const content: Content = {
      role: 'model',
      parts: [
        {text: 'Need weather first.', thought: true},
        {
          functionCall: {
            id: 'call_123',
            name: 'get_weather',
            args: {location: 'Paris'},
          },
        },
        {text: 'Hi'},
      ],
    };

    expect(contentToResponseInputItems(content)).toEqual([
      {
        type: 'function_call',
        call_id: 'call_123',
        name: 'get_weather',
        arguments: '{"location":"Paris"}',
      },
      {type: 'message', role: 'assistant', content: 'Hi'},
    ]);
  });

  it('test_content_mapping_preserves_reasoning_signature', () => {
    const content: Content = {
      role: 'model',
      parts: [
        {
          text: 'Need weather first.',
          thought: true,
          thoughtSignature: 'encrypted_reasoning',
        },
        {thought: true, thoughtSignature: 'redacted_reasoning'},
      ],
    };

    expect(contentToResponseInputItems(content)).toEqual([]);
  });

  it('test_content_mapping_sanitizes_function_call_ids_per_request', async () => {
    const content: Content = {
      role: 'model',
      parts: [
        {functionCall: {id: 'invalid id!', name: 'tool', args: {}}},
        {
          functionResponse: {
            id: 'invalid id!',
            name: 'tool',
            response: {result: 'ok'},
          },
        },
        {functionCall: {name: 'tool', args: {}}},
        {functionCall: {name: 'tool', args: {}}},
      ],
    };

    const body = await sentBody({}, userRequest({}, {contents: [content]}));

    expect(body.input).toEqual([
      expect.objectContaining({call_id: 'call_adk_fallback_0'}),
      expect.objectContaining({call_id: 'call_adk_fallback_0'}),
      expect.objectContaining({call_id: 'call_adk_fallback_1'}),
      expect.objectContaining({call_id: 'call_adk_fallback_2'}),
    ]);
  });

  it('test_function_response_serializes_mcp_content_as_text', () => {
    const content: Content = {
      role: 'tool',
      parts: [
        {
          functionResponse: {
            id: 'call_123',
            name: 'tool',
            response: {
              content: [
                {type: 'text', text: 'first'},
                {type: 'text', text: 'second'},
              ],
            },
          },
        },
      ],
    };

    expect(contentToResponseInputItems(content)).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'first\nsecond',
      },
    ]);
  });

  it('test_image_and_file_parts_use_responses_content_types', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {inlineData: {data: 'aW1hZ2U=', mimeType: 'image/png'}},
        {
          inlineData: {
            data: 'aGVsbG8=',
            mimeType: 'text/plain',
            displayName: 'a.txt',
          },
        },
        {fileData: {fileUri: 'file-abc', mimeType: 'application/pdf'}},
        {
          fileData: {
            fileUri: 'https://example.com/doc.pdf',
            mimeType: 'application/pdf',
          },
        },
        {
          fileData: {
            fileUri: 'https://example.com/image.png',
            mimeType: 'image/png',
          },
        },
      ],
    };

    expect(contentToResponseInputItems(content)).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            detail: 'auto',
            image_url: 'data:image/png;base64,aW1hZ2U=',
          },
          {
            type: 'input_file',
            filename: 'a.txt',
            file_data: 'data:text/plain;base64,aGVsbG8=',
          },
          {type: 'input_file', file_id: 'file-abc'},
          {type: 'input_file', file_url: 'https://example.com/doc.pdf'},
          {
            type: 'input_image',
            detail: 'auto',
            image_url: 'https://example.com/image.png',
          },
        ],
      },
    ]);
  });

  it('test_assistant_media_is_filtered', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const content: Content = {
      role: 'model',
      parts: [
        {text: 'before'},
        {inlineData: {data: 'aW1hZ2U=', mimeType: 'image/png'}},
        {text: 'after'},
      ],
    };

    expect(contentToResponseInputItems(content)).toEqual([
      {type: 'message', role: 'assistant', content: 'before'},
      {type: 'message', role: 'assistant', content: 'after'},
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Media data is not supported in Responses assistant turns.',
    );
  });

  it('test_code_parts_are_preserved_as_text', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {executableCode: {language: Language.PYTHON, code: 'print(1)'}},
        {codeExecutionResult: {output: '1', outcome: Outcome.OUTCOME_OK}},
      ],
    };

    const items = contentToResponseInputItems(content);

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {type: 'input_text', text: 'Code:```python\nprint(1)\n```'},
          {
            type: 'input_text',
            text: 'Execution Result:```code_output\n1\n```',
          },
        ],
      },
    ]);
  });

  it('test_function_declaration_uses_responses_tool_shape', () => {
    const tool = functionDeclarationToResponseTool({
      name: 'search',
      description: 'Search docs',
      parametersJsonSchema: {
        type: 'OBJECT',
        properties: {query: {type: 'STRING'}},
      },
    });

    expect(tool).toEqual({
      type: 'function',
      name: 'search',
      description: 'Search docs',
      parameters: {type: 'object', properties: {query: {type: 'string'}}},
      strict: false,
    });
  });

  it('test_function_declaration_to_response_tool_parameters_json_schema_ignores_parameters_required', () => {
    const tool = functionDeclarationToResponseTool({
      name: 'custom_tool',
      description: 'Tool with both schemas',
      parameters: {type: Type.OBJECT, required: ['legacy_param']},
      parametersJsonSchema: {
        type: 'object',
        properties: {query: {type: 'string'}},
      },
    });

    expect(tool.parameters).not.toHaveProperty('required');
  });

  it('test_function_declaration_to_response_tool_prefers_parameters_json_schema_over_parameters', () => {
    const tool = functionDeclarationToResponseTool({
      name: 'custom_tool',
      description: 'Tool with both schemas',
      parameters: {
        type: Type.OBJECT,
        properties: {legacy_param: {type: Type.STRING}},
        required: ['legacy_param'],
      },
      parametersJsonSchema: {
        type: 'object',
        properties: {query: {type: 'string'}},
        required: ['query'],
      },
    });

    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {query: {type: 'string'}},
      required: ['query'],
    });
  });

  it('test_function_declaration_without_a_name_is_rejected', () => {
    expect(() => functionDeclarationToResponseTool({description: 'x'})).toThrow(
      'FunctionDeclaration must have a name.',
    );
  });

  it('test_structured_output_uses_responses_text_format', async () => {
    const body = await sentBody(
      {},
      userRequest({
        responseJsonSchema: {
          title: 'Answer',
          type: 'object',
          properties: {answer: {type: 'string'}},
        },
      }),
    );

    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'Answer',
        strict: true,
        schema: {
          title: 'Answer',
          type: 'object',
          properties: {answer: {type: 'string'}},
          additionalProperties: false,
          required: ['answer'],
        },
      },
    });
  });

  it('test_thinking_config_zero_budget_maps_to_minimal_reasoning', async () => {
    const body = await sentBody(
      {reasoning: {effort: 'medium'}},
      userRequest({thinkingConfig: {thinkingBudget: 0}}),
    );

    expect(body.reasoning).toEqual({effort: 'minimal', summary: 'concise'});
  });

  it.each([
    [ThinkingLevel.MINIMAL, 'minimal'],
    [ThinkingLevel.LOW, 'low'],
    [ThinkingLevel.MEDIUM, 'medium'],
    [ThinkingLevel.HIGH, 'high'],
    [ThinkingLevel.THINKING_LEVEL_UNSPECIFIED, 'medium'],
  ])(
    'test_thinking_config_level_maps_to_openai_reasoning_effort (%s)',
    async (thinkingLevel, effort) => {
      const body = await sentBody(
        {},
        userRequest({thinkingConfig: {thinkingLevel}}),
      );

      expect(body.reasoning).toEqual({effort, summary: 'concise'});
    },
  );

  it('test_thinking_config_level_takes_precedence_over_budget', async () => {
    const body = await sentBody(
      {},
      userRequest({
        thinkingConfig: {thinkingBudget: 0, thinkingLevel: ThinkingLevel.HIGH},
      }),
    );

    expect(body.reasoning).toEqual({effort: 'high', summary: 'concise'});
  });

  it('test_thinking_config_automatic_uses_medium_concise_reasoning', async () => {
    const body = await sentBody(
      {reasoning: {effort: 'high'}},
      userRequest({thinkingConfig: {thinkingBudget: -1}}),
    );

    expect(body.reasoning).toEqual({effort: 'medium', summary: 'concise'});
  });

  it('test_thinking_config_none_budget_raises', async () => {
    const llm = new OpenAIResponsesLlm({
      client: new FakeResponsesClient({response: makeResponse({})}),
    });

    await expect(
      collect(llm.generateContentAsync(userRequest({thinkingConfig: {}}))),
    ).rejects.toThrow(/^thinking_budget must be set explicitly/);
  });

  it('test_thinking_config_positive_budget_uses_medium_concise_reasoning', async () => {
    const body = await sentBody(
      {},
      userRequest({thinkingConfig: {thinkingBudget: 1024}}),
    );

    expect(body.reasoning).toEqual({effort: 'medium', summary: 'concise'});
  });

  it('test_response_parsing_maps_text_reasoning_tool_calls_and_usage', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        id: 'resp_123',
        status: 'completed',
        usage: makeUsage({
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: {cache_write_tokens: 0, cached_tokens: 3},
          output_tokens_details: {reasoning_tokens: 4},
        }),
        output: [
          reasoningItem({
            id: 'rs_1',
            summary: [{type: 'summary_text', text: 'Think.'}],
            encrypted_content: 'encrypted',
          }),
          messageItem('Calling a tool.'),
          functionCallItem({
            call_id: 'call_123',
            name: 'get_weather',
            arguments: '{"location": "Paris"}',
          }),
        ],
      }),
      {includeResponseMetadata: true},
    );

    expect(llmResponse.interactionId).toBe('resp_123');
    expect(llmResponse.modelVersion).toBe('gpt-5');
    expect(llmResponse.finishReason).toBe(FinishReason.STOP);
    expect(llmResponse.usageMetadata).toEqual({
      promptTokenCount: 11,
      candidatesTokenCount: 7,
      totalTokenCount: 18,
      cachedContentTokenCount: 3,
      thoughtsTokenCount: 4,
    });
    expect(llmResponse.content?.parts).toEqual([
      {text: 'Think.', thought: true, thoughtSignature: 'encrypted'},
      {text: 'Calling a tool.'},
      {
        functionCall: {
          id: 'call_123',
          name: 'get_weather',
          args: {location: 'Paris'},
        },
      },
    ]);
    expect(llmResponse.customMetadata).toEqual({
      openai_response: expect.objectContaining({
        id: 'resp_123',
        status: 'completed',
        reasoning: [{encrypted_content: 'encrypted', id: 'rs_1'}],
      }),
    });
  });

  it('test_response_parsing_preserves_redacted_reasoning', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        status: 'completed',
        output: [reasoningItem({encrypted_content: 'encrypted_only'})],
      }),
      {includeResponseMetadata: true},
    );

    expect(llmResponse.content?.parts).toEqual([
      {thought: true, thoughtSignature: 'encrypted_only'},
    ]);
  });

  it('test_generate_content_async_calls_responses_create', async () => {
    const client = new FakeResponsesClient({
      response: makeResponse({
        id: 'resp_123',
        status: 'completed',
        output: [messageItem('Hello')],
      }),
    });
    const llm = new OpenAIResponsesLlm({model: 'gpt-5', client});

    const responses = await collect(llm.generateContentAsync(userRequest()));

    expect(client.body.model).toBe('gpt-5');
    expect(client.body.stream).toBe(false);
    expect(responses[0].content?.parts?.[0].text).toBe('Hello');
    expect(responses[0].interactionId).toBe('resp_123');
  });

  it('test_generate_content_async_can_skip_response_metadata', async () => {
    const client = new FakeResponsesClient({
      response: makeResponse({
        status: 'completed',
        usage: makeUsage({input_tokens: 1, output_tokens: 2, total_tokens: 3}),
        output: [messageItem('Hello')],
      }),
    });
    const llm = new OpenAIResponsesLlm({
      client,
      includeResponseMetadata: false,
    });

    const responses = await collect(llm.generateContentAsync(userRequest()));

    expect(responses[0].customMetadata).toBeUndefined();
    expect(responses[0].usageMetadata?.totalTokenCount).toBe(3);
  });

  it('test_streaming_generation_yields_partials_and_final_response', async () => {
    const client = new FakeResponsesClient({
      events: [
        createdEvent(makeResponse({id: 'resp_stream'})),
        summaryDeltaEvent(0, 'Think'),
        textDeltaEvent(1, 'Hel'),
        textDeltaEvent(1, 'lo'),
        completedEvent(
          makeResponse({
            id: 'resp_stream',
            status: 'completed',
            output: [
              reasoningItem({summary: [{type: 'summary_text', text: 'Think'}]}),
              messageItem('Hello'),
            ],
          }),
        ),
      ],
    });
    const llm = new OpenAIResponsesLlm({client});

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(client.body.stream).toBe(true);
    expect(responses[0].partial).toBe(true);
    expect(responses[0].content?.parts?.[0]).toEqual({
      text: 'Think',
      thought: true,
    });
    expect(responses[1].partial).toBe(true);
    expect(responses[1].content).toBeUndefined();
    expect(responses[1].customMetadata).toEqual({
      openai_response: {
        stream_event: {
          type: 'response.output_text.delta',
          reasoning_done: true,
          output_index: 1,
          item_id: 'msg_1',
        },
      },
    });
    expect(responses[2].content?.parts?.[0].text).toBe('Hel');
    expect(responses[3].content?.parts?.[0].text).toBe('lo');
    expect(responses[4].partial).toBeUndefined();
    expect(responses[4].content?.parts?.[0].thought).toBe(true);
    expect(responses[4].content?.parts?.[1].text).toBe('Hello');
  });

  it('test_streaming_generation_can_skip_response_metadata', async () => {
    const responses = await streamed({includeResponseMetadata: false}, [
      createdEvent(makeResponse({id: 'resp_stream'})),
      summaryDeltaEvent(0, 'Think'),
      textDeltaEvent(1, 'Hello'),
      completedEvent(
        makeResponse({
          id: 'resp_stream',
          status: 'completed',
          output: [
            reasoningItem({summary: [{type: 'summary_text', text: 'Think'}]}),
            messageItem('Hello'),
          ],
        }),
      ),
    ]);

    expect(responses.map((response) => response.customMetadata)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(responses[0].content?.parts?.[0].thought).toBe(true);
    expect(responses[1].content?.parts?.[0].text).toBe('Hello');
    expect(responses[2].partial).toBeUndefined();
  });

  it('test_streaming_generation_fallback_preserves_output_item_order', async () => {
    const responses = await streamed({}, [
      createdEvent(makeResponse({id: 'resp_stream'})),
      itemAddedEvent(0, reasoningItem({id: 'rs_1'})),
      summaryDeltaEvent(0, 'Think'),
      summaryDoneEvent(0, 'Think'),
      itemAddedEvent(1, messageItem('', 'msg_1')),
      textDeltaEvent(1, 'Hel'),
      textDeltaEvent(1, 'lo'),
      itemAddedEvent(2, reasoningItem({id: 'rs_2'})),
      summaryDeltaEvent(2, 'Again'),
      itemAddedEvent(3, messageItem('', 'msg_2')),
      textDeltaEvent(3, 'Bye'),
    ]);

    const final = responses[responses.length - 1];
    expect(final.partial).toBe(false);
    expect(
      final.content?.parts?.map((part) => [part.text, part.thought]),
    ).toEqual([
      ['Think', true],
      ['Hello', undefined],
      ['Again', true],
      ['Bye', undefined],
    ]);
    expect(
      responses
        .map((response) => response.customMetadata?.['openai_response'])
        .filter((metadata) => metadata !== undefined),
    ).toEqual([
      {
        stream_event: {
          type: 'response.reasoning_summary_text.done',
          reasoning_done: true,
          output_index: 0,
          item_id: 'rs_0',
          summary_index: 0,
        },
      },
      {
        stream_event: {
          type: 'response.output_item.added',
          reasoning_done: true,
          output_index: 3,
        },
      },
    ]);
  });

  it('test_streaming_generation_aggregates_function_call_without_completed_event', async () => {
    const responses = await streamed({}, [
      itemAddedEvent(
        0,
        functionCallItem({
          call_id: 'call_123',
          name: 'get_weather',
          arguments: '',
        }),
      ),
      argumentsDeltaEvent(0, '{"location"'),
      argumentsDeltaEvent(0, ': "Paris"}'),
    ]);

    expect(responses).toHaveLength(1);
    expect(responses[0].finishReason).toBe(FinishReason.STOP);
    expect(responses[0].content?.parts?.[0].functionCall).toEqual({
      id: 'call_123',
      name: 'get_weather',
      args: {location: 'Paris'},
    });
  });

  it('test_streaming_generation_uses_function_arguments_done_event', async () => {
    const responses = await streamed({}, [
      itemAddedEvent(
        0,
        functionCallItem({
          call_id: 'call_123',
          name: 'get_weather',
          arguments: '',
        }),
      ),
      argumentsDoneEvent(0, '{"location": "Paris"}'),
    ]);

    expect(responses[0].content?.parts?.[0].functionCall).toEqual({
      id: 'call_123',
      name: 'get_weather',
      args: {location: 'Paris'},
    });
  });

  it('test_streaming_generation_failed_event_is_terminal', async () => {
    const responses = await streamed({}, [
      textDeltaEvent(0, 'partial'),
      failedEvent(makeResponse({id: 'resp_123', status: 'failed'})),
    ]);

    expect(responses).toHaveLength(2);
    expect(responses[0].partial).toBe(true);
    expect(responses[1].finishReason).toBe(FinishReason.OTHER);
    expect(responses[1].errorCode).toBe(FinishReason.OTHER);
  });

  it('test_azure_client_uses_openai_v1_base_url', async () => {
    const llm = new AzureOpenAIResponsesLlm({
      model: 'deployment',
      azureEndpoint: 'https://example.openai.azure.com/',
      apiKey: 'test-key',
    });

    await collect(llm.generateContentAsync(userRequest()));

    expect(openAiConstructor).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'test-key',
      baseURL: 'https://example.openai.azure.com/openai/v1/',
    });
  });

  it('test_provided_client_is_used', async () => {
    const client = new FakeResponsesClient({
      response: makeResponse({status: 'completed'}),
    });
    const llm = new OpenAIResponsesLlm({client});

    await collect(llm.generateContentAsync(userRequest()));

    expect(client.calls).toHaveLength(1);
    expect(openAiConstructor).not.toHaveBeenCalled();
  });

  it('test_default_client_built_with_resolved_api_key', async () => {
    const llm = new OpenAIResponsesLlm({apiKey: 'test-key'});

    await collect(llm.generateContentAsync(userRequest()));

    expect(openAiConstructor).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'test-key',
    });
  });

  it('test_api_key_callable_is_resolved', async () => {
    const llm = new OpenAIResponsesLlm({apiKey: () => 'dynamic-key'});

    await collect(llm.generateContentAsync(userRequest()));

    expect(openAiConstructor).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'dynamic-key',
    });
  });

  it('test_async_api_key_callable_raises', () => {
    expect(() => requireSyncApiKey(Promise.resolve('k'))).toThrow(
      /^Async api_key/,
    );
  });

  it('test_azure_api_key_env_fallback', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'env-key');
    const llm = new AzureOpenAIResponsesLlm({
      model: 'deployment',
      azureEndpoint: 'https://example.openai.azure.com/',
    });

    await collect(llm.generateContentAsync(userRequest()));

    expect(openAiConstructor).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'env-key',
      baseURL: 'https://example.openai.azure.com/openai/v1/',
    });
  });

  it('test_extra_request_args_override_and_merge_extra_body', async () => {
    // adk-python nests stop sequences under `extra_body`, which is an
    // openai-python transport concept. `openai` serializes the body object as
    // it is given, so both live at the top level here and the same wire fields
    // come out.
    const body = await sentBody(
      {extraRequestArgs: {temperature: 0.9, foo: 'bar'}},
      userRequest({temperature: 0.1, stopSequences: ['STOP']}),
    );

    expect(body.temperature).toBe(0.9);
    expect(body['stop']).toEqual(['STOP']);
    expect(body['foo']).toBe('bar');
  });

  it('test_structured_output_schema_name_is_sanitized', async () => {
    const body = await sentBody(
      {},
      userRequest({
        responseJsonSchema: {
          title: 'My Schema!',
          type: 'object',
          properties: {x: {type: 'integer'}},
        },
      }),
    );

    expect(body.text?.format).toMatchObject({name: 'My_Schema_'});
  });

  it('test_structured_output_preserves_any_of_for_genai_schema', async () => {
    const body = await sentBody(
      {},
      userRequest({
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            anyOfChoice: {
              anyOf: [{type: Type.STRING}, {type: Type.INTEGER}],
            },
          },
        },
      }),
    );

    expect(body.text?.format).toMatchObject({
      schema: expect.objectContaining({
        properties: {
          anyOfChoice: {
            anyOf: [{type: 'string'}, {type: 'integer'}],
          },
        },
      }),
    });
  });

  it.each([
    [FunctionCallingConfigMode.ANY, 'required'],
    [FunctionCallingConfigMode.NONE, 'none'],
    [FunctionCallingConfigMode.AUTO, 'auto'],
  ])('test_tool_choice_maps_function_calling_mode (%s)', (mode, expected) => {
    expect(toolChoice({toolConfig: {functionCallingConfig: {mode}}})).toBe(
      expected,
    );
  });

  it('test_response_parsing_incomplete_max_tokens_sets_error', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        status: 'incomplete',
        incomplete_details: {reason: 'max_output_tokens'},
      }),
      {includeResponseMetadata: true},
    );

    expect(llmResponse.finishReason).toBe(FinishReason.MAX_TOKENS);
    expect(llmResponse.errorCode).toBe(FinishReason.MAX_TOKENS);
    expect(llmResponse.errorMessage).toContain('max_output_tokens');
  });

  it('test_response_parsing_failed_status_sets_error', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        status: 'failed',
        error: {code: 'server_error', message: 'boom'},
      }),
      {includeResponseMetadata: true},
    );

    expect(llmResponse.finishReason).toBe(FinishReason.OTHER);
    expect(llmResponse.errorCode).toBe(FinishReason.OTHER);
    expect(llmResponse.errorMessage).toContain('boom');
  });

  it('test_response_parsing_maps_refusal_to_prefixed_text', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        status: 'completed',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{type: 'refusal', refusal: 'I cannot help.'}],
          },
        ],
      }),
      {includeResponseMetadata: true},
    );

    expect(llmResponse.content?.parts?.[0].text).toBe(
      'OpenAI refusal: I cannot help.',
    );
  });

  it('test_loads_json_object_handles_malformed_arguments', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(loadsJsonObject('not json')).toEqual({});
    expect(loadsJsonObject('[1, 2]')).toEqual({});
    expect(loadsJsonObject('')).toEqual({});
    expect(loadsJsonObject('{"a": 1}')).toEqual({a: 1});
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Failed to parse Responses API function arguments as JSON.',
    );
  });

  it('test_code_parts_handle_missing_inner_fields', () => {
    const items = contentToResponseInputItems({
      role: 'user',
      parts: [{executableCode: {language: Language.PYTHON}}],
    });

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'Code:```python\n\n```'}],
      },
    ]);
  });

  it('test_streaming_incomplete_event_sets_max_tokens', async () => {
    const responses = await streamed({}, [
      textDeltaEvent(0, 'Hi'),
      incompleteEvent(
        makeResponse({
          id: 'resp_stream',
          status: 'incomplete',
          incomplete_details: {reason: 'max_output_tokens'},
          output: [messageItem('Hi')],
        }),
      ),
    ]);

    expect(responses[responses.length - 1].finishReason).toBe(
      FinishReason.MAX_TOKENS,
    );
  });

  it('test_streaming_output_item_done_uses_done_item_text', async () => {
    const responses = await streamed({}, [
      itemAddedEvent(0, messageItem('', 'msg_1')),
      itemDoneEvent(0, messageItem('Done text', 'msg_1')),
    ]);

    expect(responses[responses.length - 1].content?.parts?.[0].text).toBe(
      'Done text',
    );
  });

  it('test_model_options_reach_the_request_body', async () => {
    const body = await sentBody(
      {
        parallelToolCalls: false,
        truncation: 'auto',
        serviceTier: 'flex',
      },
      userRequest({
        toolConfig: {
          functionCallingConfig: {mode: FunctionCallingConfigMode.ANY},
        },
      }),
    );

    expect(body.parallel_tool_calls).toBe(false);
    expect(body.truncation).toBe('auto');
    expect(body.service_tier).toBe('flex');
    expect(body.tool_choice).toBe('required');
  });

  it('test_a_tool_that_declares_no_functions_is_skipped', async () => {
    const body = await sentBody(
      {},
      userRequest({
        tools: [{googleSearch: {}}, {functionDeclarations: undefined}],
      }),
    );

    expect(body.tools).toBeUndefined();
  });

  it('test_the_request_falls_back_to_the_configured_model', async () => {
    const client = new FakeResponsesClient({
      response: makeResponse({status: 'completed'}),
    });
    const llm = new OpenAIResponsesLlm({model: 'gpt-5-mini', client});

    await collect(
      llm.generateContentAsync({
        contents: [{role: 'user', parts: [{text: 'Hi'}]}],
        liveConnectConfig: {},
        toolsDict: {},
      }),
    );

    expect(client.body.model).toBe('gpt-5-mini');
    expect(client.body.temperature).toBeUndefined();
  });

  it('test_azure_without_an_endpoint_keeps_the_default_base_url', async () => {
    const llm = new AzureOpenAIResponsesLlm({apiKey: 'test-key'});

    await collect(llm.generateContentAsync(userRequest()));

    expect(openAiConstructor).toHaveBeenCalledExactlyOnceWith({
      apiKey: 'test-key',
    });
  });

  it('test_the_client_is_built_at_most_once', async () => {
    const llm = new OpenAIResponsesLlm({apiKey: 'test-key'});

    await collect(llm.generateContentAsync(userRequest()));
    await collect(llm.generateContentAsync(userRequest()));

    expect(openAiConstructor).toHaveBeenCalledOnce();
  });

  it('test_connect_is_not_supported', async () => {
    const llm = new OpenAIResponsesLlm({model: 'gpt-5'});

    await expect(llm.connect(userRequest())).rejects.toThrow(
      'Live connection is not supported for gpt-5.',
    );
  });

  it('test_model_registers_no_pattern', () => {
    expect(OpenAIResponsesLlm.supportedModels).toEqual([]);
  });
});
