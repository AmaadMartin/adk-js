/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports the reference tests of adk-python
 * `tests/unittests/labs/openai/test_openai_responses_llm.py` (branch `main`).
 * Each `it(...)` keeps the Python test name so the two suites can be compared
 * by name.
 *
 * Two shape differences follow from typing against the OpenAI SDK rather than
 * against dictionaries. A stream event carries its required fields, so a
 * reasoning boundary reports the `output_index` and `item_id` the reference
 * fixtures omitted. A request body puts `stop` and `extraRequestArgs` at the
 * top level, because the JavaScript SDK has no `extra_body` kwarg.
 */

import {
  FinishReason,
  FunctionCallingConfigMode,
  Language,
  Outcome,
  Schema,
  ThinkingLevel,
  Type,
} from '@google/genai';
import type OpenAI from 'openai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  AzureOpenAiResponsesLlm,
  OpenAiResponsesLlm,
} from '../../../src/labs/openai/openai_responses_llm.js';
import {
  CallIdSanitizer,
  contentToResponseInputItems,
  functionDeclarationToResponseTool,
  toolChoice,
} from '../../../src/labs/openai/openai_responses_request.js';
import {
  loadsJsonObject,
  responseToLlmResponse,
} from '../../../src/labs/openai/openai_responses_response.js';
import {enforceStrictOpenAiSchema} from '../../../src/labs/openai/openai_schema.js';
import {LlmRequest} from '../../../src/models/llm_request.js';
import {logger} from '../../../src/utils/logger.js';

import {
  asyncStream,
  completedEvent,
  contentPartDoneEvent,
  createdEvent,
  drain,
  failedEvent,
  FakeResponsesClient,
  functionArgsDeltaEvent,
  functionArgsDoneEvent,
  functionCallItem,
  incompleteEvent,
  makeResponse,
  makeUsage,
  messageItem,
  outputItemAddedEvent,
  outputItemDoneEvent,
  outputText,
  reasoningItem,
  reasoningSummaryDeltaEvent,
  reasoningSummaryDoneEvent,
  refusal,
  textDeltaEvent,
  toWire,
  userRequest,
} from './openai_responses_fixtures.js';

const {constructorSpy} = vi.hoisted(() => ({constructorSpy: vi.fn()}));

vi.mock('openai', () => {
  class FakeOpenAI {
    readonly responses = {
      create: () =>
        Promise.resolve({
          id: 'resp_mock',
          created_at: 1,
          output_text: '',
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          model: 'gpt-5',
          object: 'response',
          output: [],
          parallel_tool_calls: true,
          temperature: null,
          tool_choice: 'auto',
          tools: [],
          top_p: null,
          status: 'completed',
        }),
    };
    constructor(options: unknown) {
      constructorSpy(options);
    }
  }
  return {default: FakeOpenAI};
});

/** Returns the body the client received, failing the test if it was not called. */
function capturedBody(client: FakeResponsesClient) {
  const body = client.responses.body;
  if (!body) {
    expect.fail('the model never called responses.create');
  }
  return body;
}

/** Runs one request through a fake client and returns the captured body. */
async function bodyFor(
  llm: OpenAiResponsesLlm,
  llmRequest: LlmRequest,
  client = new FakeResponsesClient(),
) {
  await drain(llm.generateContentAsync(llmRequest));
  return capturedBody(client);
}

describe('OpenAI Responses model', () => {
  beforeEach(() => {
    constructorSpy.mockClear();
  });

  it('test_request_kwargs_use_responses_api_shape', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      client,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: {effort: 'medium'},
    });
    const llmRequest: LlmRequest = {
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
    };

    const body = await bodyFor(llm, llmRequest, client);

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
    const items = contentToResponseInputItems({
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
    });

    expect(items).toEqual([
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
    const items = contentToResponseInputItems({
      role: 'model',
      parts: [
        {
          text: 'Need weather first.',
          thought: true,
          thoughtSignature: 'encrypted_reasoning',
        },
        {thought: true, thoughtSignature: 'redacted_reasoning'},
      ],
    });

    expect(items).toEqual([]);
  });

  it('test_content_mapping_sanitizes_function_call_ids_per_request', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});
    const llmRequest: LlmRequest = {
      contents: [
        {
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
        },
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const body = await bodyFor(llm, llmRequest, client);

    expect(toWire(body.input)).toMatchObject([
      {call_id: 'call_adk_fallback_0'},
      {call_id: 'call_adk_fallback_0'},
      {call_id: 'call_adk_fallback_1'},
      {call_id: 'call_adk_fallback_2'},
    ]);
  });

  it('test_function_response_serializes_mcp_content_as_text', () => {
    const items = contentToResponseInputItems({
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
    });

    expect(items).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'first\nsecond',
      },
    ]);
  });

  it('test_image_and_file_parts_use_responses_content_types', () => {
    const items = contentToResponseInputItems({
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
    });

    expect(items).toEqual([
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

    const items = contentToResponseInputItems({
      role: 'model',
      parts: [
        {text: 'before'},
        {inlineData: {data: 'aW1hZ2U=', mimeType: 'image/png'}},
        {text: 'after'},
      ],
    });

    expect(items).toEqual([
      {type: 'message', role: 'assistant', content: 'before'},
      {type: 'message', role: 'assistant', content: 'after'},
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Media data is not supported in Responses assistant turns.',
    );
    warn.mockRestore();
  });

  it('test_code_parts_are_preserved_as_text', () => {
    const items = contentToResponseInputItems({
      role: 'user',
      parts: [
        {executableCode: {language: Language.PYTHON, code: 'print(1)'}},
        {codeExecutionResult: {output: '1', outcome: Outcome.OUTCOME_OK}},
      ],
    });

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
      parameters: {
        type: 'object',
        properties: {query: {type: 'string'}},
      },
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

  it('test_structured_output_uses_responses_text_format', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});
    const answerSchema: Schema = {
      title: 'Answer',
      type: Type.OBJECT,
      properties: {answer: {type: Type.STRING}},
    };

    const body = await bodyFor(
      llm,
      userRequest({responseSchema: answerSchema}),
      client,
    );

    expect(body.text?.format).toMatchObject({
      type: 'json_schema',
      name: 'Answer',
      strict: true,
      schema: {additionalProperties: false, required: ['answer']},
    });
  });

  it('test_thinking_config_zero_budget_maps_to_minimal_reasoning', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      client,
      reasoning: {effort: 'medium'},
    });

    const body = await bodyFor(
      llm,
      userRequest({thinkingConfig: {thinkingBudget: 0}}),
      client,
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
      const client = new FakeResponsesClient();
      const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

      const body = await bodyFor(
        llm,
        userRequest({thinkingConfig: {thinkingLevel}}),
        client,
      );

      expect(body.reasoning).toEqual({effort, summary: 'concise'});
    },
  );

  it('test_thinking_config_level_takes_precedence_over_budget', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const body = await bodyFor(
      llm,
      userRequest({
        thinkingConfig: {thinkingBudget: 0, thinkingLevel: ThinkingLevel.HIGH},
      }),
      client,
    );

    expect(body.reasoning).toEqual({effort: 'high', summary: 'concise'});
  });

  it('test_thinking_config_automatic_uses_medium_concise_reasoning', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      client,
      reasoning: {effort: 'high'},
    });

    const body = await bodyFor(
      llm,
      userRequest({thinkingConfig: {thinkingBudget: -1}}),
      client,
    );

    expect(body.reasoning).toEqual({effort: 'medium', summary: 'concise'});
  });

  it('test_thinking_config_none_budget_raises', async () => {
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      client: new FakeResponsesClient(),
    });

    await expect(
      drain(llm.generateContentAsync(userRequest({thinkingConfig: {}}))),
    ).rejects.toThrow('thinking_budget must be set explicitly');
  });

  it('test_thinking_config_positive_budget_uses_medium_concise_reasoning', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const body = await bodyFor(
      llm,
      userRequest({thinkingConfig: {thinkingBudget: 1024}}),
      client,
    );

    expect(body.reasoning).toEqual({effort: 'medium', summary: 'concise'});
  });

  it('test_response_parsing_maps_text_reasoning_tool_calls_and_usage', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        usage: makeUsage({
          input: 11,
          output: 7,
          total: 18,
          cached: 3,
          reasoning: 4,
        }),
        output: [
          reasoningItem({
            id: 'rs_1',
            summary: ['Think.'],
            encryptedContent: 'encrypted',
          }),
          messageItem([outputText('Calling a tool.')]),
          functionCallItem({
            callId: 'call_123',
            name: 'get_weather',
            args: '{"location": "Paris"}',
          }),
        ],
      }),
      true,
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
    const parts = llmResponse.content?.parts ?? [];
    expect(parts[0]).toEqual({
      text: 'Think.',
      thought: true,
      thoughtSignature: Buffer.from('encrypted', 'utf-8').toString('base64'),
    });
    expect(parts[1].text).toBe('Calling a tool.');
    expect(parts[2].functionCall).toEqual({
      id: 'call_123',
      name: 'get_weather',
      args: {location: 'Paris'},
    });
    expect(llmResponse.customMetadata).toMatchObject({
      openai_response: {
        reasoning: [{encrypted_content: 'encrypted', id: 'rs_1'}],
      },
    });
  });

  it('test_response_parsing_accepts_openai_sdk_response_types', () => {
    const response: OpenAI.Responses.Response = {
      id: 'resp_typed',
      created_at: 1,
      output_text: '',
      error: null,
      incomplete_details: null,
      instructions: null,
      metadata: null,
      model: 'gpt-5',
      object: 'response',
      output: [
        {
          id: 'rs_typed',
          type: 'reasoning',
          summary: [{type: 'summary_text', text: 'Typed thought.'}],
          encrypted_content: 'encrypted_typed',
        },
        {
          id: 'msg_typed',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {type: 'output_text', text: 'Typed hello.', annotations: []},
          ],
        },
        {
          type: 'function_call',
          call_id: 'call_typed',
          name: 'get_weather',
          arguments: '{"city": "Tokyo"}',
        },
      ],
      parallel_tool_calls: true,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      temperature: null,
      status: 'completed',
      usage: {
        input_tokens: 3,
        input_tokens_details: {cached_tokens: 1, cache_write_tokens: 0},
        output_tokens: 5,
        output_tokens_details: {reasoning_tokens: 2},
        total_tokens: 8,
      },
    };

    const llmResponse = responseToLlmResponse(response, true);

    const parts = llmResponse.content?.parts ?? [];
    expect(llmResponse.interactionId).toBe('resp_typed');
    expect(parts[0].thought).toBe(true);
    expect(parts[0].text).toBe('Typed thought.');
    expect(parts[0].thoughtSignature).toBe(
      Buffer.from('encrypted_typed', 'utf-8').toString('base64'),
    );
    expect(parts[1].text).toBe('Typed hello.');
    expect(parts[2].functionCall).toEqual({
      id: 'call_typed',
      name: 'get_weather',
      args: {city: 'Tokyo'},
    });
    expect(llmResponse.usageMetadata?.totalTokenCount).toBe(8);
    expect(llmResponse.customMetadata).toMatchObject({
      openai_response: {
        reasoning: [{encrypted_content: 'encrypted_typed', id: 'rs_typed'}],
      },
    });
  });

  it('test_response_parsing_preserves_redacted_reasoning', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        output: [
          reasoningItem({id: 'rs_1', encryptedContent: 'encrypted_only'}),
        ],
      }),
      true,
    );

    expect(llmResponse.content?.parts?.[0]).toEqual({
      thought: true,
      thoughtSignature: Buffer.from('encrypted_only', 'utf-8').toString(
        'base64',
      ),
    });
  });

  it('test_generate_content_async_calls_responses_create', async () => {
    const client = new FakeResponsesClient(
      makeResponse({output: [messageItem([outputText('Hello')])]}),
    );
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const responses = await drain(llm.generateContentAsync(userRequest()));

    expect(capturedBody(client).model).toBe('gpt-5');
    expect(capturedBody(client).stream).toBe(false);
    expect(responses[0].content?.parts?.[0].text).toBe('Hello');
    expect(responses[0].interactionId).toBe('resp_123');
  });

  it('test_generate_content_async_can_skip_response_metadata', async () => {
    const client = new FakeResponsesClient(
      makeResponse({
        usage: makeUsage({input: 1, output: 2, total: 3}),
        output: [messageItem([outputText('Hello')])],
      }),
    );
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      client,
      includeResponseMetadata: false,
    });

    const responses = await drain(llm.generateContentAsync(userRequest()));

    expect(responses[0].customMetadata).toBeUndefined();
    expect(responses[0].usageMetadata?.totalTokenCount).toBe(3);
  });

  it('test_streaming_generation_yields_partials_and_final_response', async () => {
    const client = new FakeResponsesClient([
      createdEvent(makeResponse({id: 'resp_stream'})),
      reasoningSummaryDeltaEvent({delta: 'Think'}),
      textDeltaEvent({delta: 'Hel', outputIndex: 1}),
      textDeltaEvent({delta: 'lo', outputIndex: 1}),
      completedEvent(
        makeResponse({
          id: 'resp_stream',
          output: [
            reasoningItem({summary: ['Think']}),
            messageItem([outputText('Hello')]),
          ],
        }),
      ),
    ]);
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(capturedBody(client).stream).toBe(true);
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
    const client = new FakeResponsesClient([
      createdEvent(makeResponse({id: 'resp_stream'})),
      reasoningSummaryDeltaEvent({delta: 'Think'}),
      textDeltaEvent({delta: 'Hello', outputIndex: 1}),
      completedEvent(
        makeResponse({
          id: 'resp_stream',
          output: [
            reasoningItem({summary: ['Think']}),
            messageItem([outputText('Hello')]),
          ],
        }),
      ),
    ]);
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      client,
      includeResponseMetadata: false,
    });

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

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
    const client = new FakeResponsesClient([
      createdEvent(makeResponse({id: 'resp_stream'})),
      outputItemAddedEvent({
        outputIndex: 0,
        item: reasoningItem({id: 'rs_1'}),
      }),
      reasoningSummaryDeltaEvent({outputIndex: 0, delta: 'Think'}),
      reasoningSummaryDoneEvent({outputIndex: 0, text: 'Think'}),
      outputItemAddedEvent({outputIndex: 1, item: messageItem([], 'msg_1')}),
      textDeltaEvent({outputIndex: 1, delta: 'Hel'}),
      textDeltaEvent({outputIndex: 1, delta: 'lo'}),
      outputItemAddedEvent({
        outputIndex: 2,
        item: reasoningItem({id: 'rs_2'}),
      }),
      reasoningSummaryDeltaEvent({outputIndex: 2, delta: 'Again'}),
      outputItemAddedEvent({outputIndex: 3, item: messageItem([], 'msg_2')}),
      textDeltaEvent({outputIndex: 3, delta: 'Bye'}),
    ]);
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

    const finalResponse = responses[responses.length - 1];
    expect(finalResponse.partial).toBe(false);
    expect(
      (finalResponse.content?.parts ?? []).map((part) => [
        part.text,
        part.thought,
      ]),
    ).toEqual([
      ['Think', true],
      ['Hello', undefined],
      ['Again', true],
      ['Bye', undefined],
    ]);
    expect(
      responses
        .filter((response) => response.customMetadata !== undefined)
        .map((response) => toWire(response.customMetadata)),
    ).toMatchObject([
      {
        openai_response: {
          stream_event: {type: 'response.reasoning_summary_text.done'},
        },
      },
      {openai_response: {stream_event: {type: 'response.output_item.added'}}},
    ]);
  });

  it('test_streaming_generation_aggregates_function_call_without_completed_event', async () => {
    const client = new FakeResponsesClient([
      outputItemAddedEvent({
        outputIndex: 0,
        item: functionCallItem({
          callId: 'call_123',
          name: 'get_weather',
          args: '',
        }),
      }),
      functionArgsDeltaEvent({outputIndex: 0, delta: '{"location"'}),
      functionArgsDeltaEvent({outputIndex: 0, delta: ': "Paris"}'}),
    ]);
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].finishReason).toBe(FinishReason.STOP);
    expect(responses[0].content?.parts?.[0].functionCall).toEqual({
      id: 'call_123',
      name: 'get_weather',
      args: {location: 'Paris'},
    });
  });

  it('test_streaming_generation_uses_function_arguments_done_event', async () => {
    const client = new FakeResponsesClient([
      outputItemAddedEvent({
        outputIndex: 0,
        item: functionCallItem({
          callId: 'call_123',
          name: 'get_weather',
          args: '',
        }),
      }),
      functionArgsDoneEvent({outputIndex: 0, args: '{"location": "Paris"}'}),
    ]);
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses[0].content?.parts?.[0].functionCall).toMatchObject({
      id: 'call_123',
      args: {location: 'Paris'},
    });
  });

  it('test_streaming_generation_failed_event_is_terminal', async () => {
    const client = new FakeResponsesClient([
      textDeltaEvent({delta: 'partial'}),
      failedEvent(makeResponse({id: 'resp_123', status: 'failed'})),
    ]);
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses).toHaveLength(2);
    expect(responses[0].partial).toBe(true);
    expect(responses[1].finishReason).toBe(FinishReason.OTHER);
    expect(responses[1].errorCode).toBe(FinishReason.OTHER);
  });

  it('test_azure_client_uses_openai_v1_base_url', async () => {
    const llm = new AzureOpenAiResponsesLlm({
      model: 'deployment',
      azureEndpoint: 'https://example.openai.azure.com/',
      apiKey: 'key',
    });

    await drain(llm.generateContentAsync(userRequest()));

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(constructorSpy).toHaveBeenCalledWith({
      apiKey: 'key',
      baseURL: 'https://example.openai.azure.com/openai/v1/',
    });
  });

  it('test_provided_client_is_used', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    await drain(llm.generateContentAsync(userRequest()));

    expect(client.responses.calls).toBe(1);
    expect(constructorSpy).not.toHaveBeenCalled();
  });

  it('test_default_client_built_with_resolved_api_key', async () => {
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', apiKey: 'secret'});

    await drain(llm.generateContentAsync(userRequest()));

    expect(constructorSpy).toHaveBeenCalledWith({apiKey: 'secret'});
  });

  it('test_api_key_callable_is_resolved', async () => {
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      apiKey: () => 'dynamic',
    });

    await drain(llm.generateContentAsync(userRequest()));

    expect(constructorSpy).toHaveBeenCalledWith({apiKey: 'dynamic'});
  });

  it('test_async_api_key_callable_raises (inverted: adk-js resolves it)', async () => {
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      apiKey: () => Promise.resolve('k'),
    });

    await drain(llm.generateContentAsync(userRequest()));

    expect(constructorSpy).toHaveBeenCalledWith({apiKey: 'k'});
  });

  it('test_azure_api_key_env_fallback', async () => {
    const previous = process.env['AZURE_OPENAI_API_KEY'];
    process.env['AZURE_OPENAI_API_KEY'] = 'env-key';
    try {
      const llm = new AzureOpenAiResponsesLlm({
        model: 'deployment',
        azureEndpoint: 'https://example.openai.azure.com/',
      });

      await drain(llm.generateContentAsync(userRequest()));

      expect(constructorSpy).toHaveBeenCalledWith({
        apiKey: 'env-key',
        baseURL: 'https://example.openai.azure.com/openai/v1/',
      });
    } finally {
      if (previous === undefined) {
        delete process.env['AZURE_OPENAI_API_KEY'];
      } else {
        process.env['AZURE_OPENAI_API_KEY'] = previous;
      }
    }
  });

  it('test_extra_request_args_override_and_merge_extra_body', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      client,
      extraRequestArgs: {temperature: 0.9, foo: 'bar'},
    });

    const body = await bodyFor(
      llm,
      userRequest({temperature: 0.1, stopSequences: ['STOP']}),
      client,
    );

    // The JavaScript SDK has no `extra_body` kwarg, so `stop` and every extra
    // request field go in at the top level. See divergence D2.
    expect(toWire(body)).toMatchObject({
      temperature: 0.9,
      stop: ['STOP'],
      foo: 'bar',
    });
  });

  it('test_structured_output_schema_name_is_sanitized', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const body = await bodyFor(
      llm,
      userRequest({
        responseJsonSchema: {
          title: 'My Schema!',
          type: 'object',
          properties: {x: {type: 'integer'}},
        },
      }),
      client,
    );

    expect(body.text?.format).toMatchObject({name: 'My_Schema_'});
  });

  it('test_structured_output_preserves_any_of_for_genai_schema', async () => {
    const client = new FakeResponsesClient();
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        anyOfChoice: {
          anyOf: [{type: Type.STRING}, {type: Type.INTEGER}],
        },
      },
    };

    const body = await bodyFor(
      llm,
      userRequest({responseSchema: schema}),
      client,
    );

    expect(body.text?.format).toMatchObject({
      schema: {
        properties: {
          anyOfChoice: {anyOf: [{type: 'string'}, {type: 'integer'}]},
        },
      },
    });
  });

  it('test_enforce_strict_openai_schema_handles_nested_refs', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {type: 'array', items: {$ref: '#/$defs/Item'}},
        choice: {anyOf: [{type: 'string'}, {type: 'integer'}]},
      },
      $defs: {
        Item: {type: 'object', properties: {n: {type: 'integer'}}},
      },
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ['choice', 'items'],
      $defs: {Item: {additionalProperties: false, required: ['n']}},
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
        id: 'resp_1',
        status: 'incomplete',
        incomplete_details: {reason: 'max_output_tokens'},
      }),
      true,
    );

    expect(llmResponse.finishReason).toBe(FinishReason.MAX_TOKENS);
    expect(llmResponse.errorCode).toBe(FinishReason.MAX_TOKENS);
    expect(llmResponse.errorMessage).toContain('max_output_tokens');
  });

  it('test_response_parsing_failed_status_sets_error', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        id: 'resp_1',
        status: 'failed',
        error: {code: 'server_error', message: 'boom'},
      }),
      true,
    );

    expect(llmResponse.finishReason).toBe(FinishReason.OTHER);
    expect(llmResponse.errorCode).toBe(FinishReason.OTHER);
    expect(llmResponse.errorMessage).toContain('boom');
  });

  it('test_response_parsing_maps_refusal_to_prefixed_text', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({output: [messageItem([refusal('I cannot help.')])]}),
      true,
    );

    expect(llmResponse.content?.parts?.[0].text).toBe(
      'OpenAI refusal: I cannot help.',
    );
  });

  it('test_loads_json_object_handles_malformed_arguments', () => {
    expect(loadsJsonObject('not json')).toEqual({});
    expect(loadsJsonObject('[1, 2]')).toEqual({});
    expect(loadsJsonObject('')).toEqual({});
    expect(loadsJsonObject('{"a": 1}')).toEqual({a: 1});
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
    const client = new FakeResponsesClient([
      textDeltaEvent({delta: 'Hi'}),
      incompleteEvent(
        makeResponse({
          id: 'resp_stream',
          status: 'incomplete',
          incomplete_details: {reason: 'max_output_tokens'},
          output: [messageItem([outputText('Hi')])],
        }),
      ),
    ]);
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses[responses.length - 1].finishReason).toBe(
      FinishReason.MAX_TOKENS,
    );
  });

  it('test_streaming_output_item_done_uses_done_item_text', async () => {
    const client = new FakeResponsesClient([
      outputItemAddedEvent({outputIndex: 0, item: messageItem([])}),
      outputItemDoneEvent({
        outputIndex: 0,
        item: messageItem([outputText('Done text')]),
      }),
    ]);
    const llm = new OpenAiResponsesLlm({model: 'gpt-5', client});

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses[responses.length - 1].content?.parts?.[0].text).toBe(
      'Done text',
    );
  });
});

describe('CallIdSanitizer', () => {
  it('keeps a valid id and memoises a substitute per invalid id', () => {
    const sanitizer = new CallIdSanitizer();

    expect(sanitizer.sanitize('call_ok-1')).toBe('call_ok-1');
    expect(sanitizer.sanitize('bad id')).toBe('call_adk_fallback_0');
    expect(sanitizer.sanitize('bad id')).toBe('call_adk_fallback_0');
    expect(sanitizer.sanitize(undefined)).toBe('call_adk_fallback_1');
  });
});

describe('stream fixtures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replays every event it is given', async () => {
    const events = [
      textDeltaEvent({delta: 'a'}),
      contentPartDoneEvent({
        part: outputText('a'),
      }),
    ];

    const seen: string[] = [];
    for await (const event of asyncStream(events)) {
      seen.push(event.type);
    }

    expect(seen).toEqual([
      'response.output_text.delta',
      'response.content_part.done',
    ]);
  });
});
