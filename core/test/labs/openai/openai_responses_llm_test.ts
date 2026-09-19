/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python tests/unittests/labs/openai/test_openai_responses_llm.py
// (google/adk-python, branch main). The `it(...)` names are the Python test
// names verbatim, so a reviewer can grep either side and find the other.
//
// One reference test is not ported:
// `test_openai_responses_package_exports_required_types` asserts that the
// installed SDK exposes ~19 Responses symbols. In the Node SDK those are
// type-only declarations, erased at compile time, so there is no runtime
// symbol to assert; `npm run ts:check` gives the equivalent guarantee.

import {
  FinishReason,
  FunctionCallingConfigMode,
  Language,
  Outcome,
  Schema,
  ThinkingLevel,
  Type,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  buildResponsesCreateParams,
  contentToResponsesInputItems,
  functionDeclarationToResponsesTool,
  loadsJsonObject,
  OpenAIStreamEvent,
  ResponsesRequestOptions,
  responseToLlmResponse,
  toolChoiceFromConfig,
  toResponsesInput,
} from '../../../src/labs/openai/openai_responses_converters.js';
import {
  AzureOpenAIResponsesLlm,
  OpenAIResponsesLlm,
  OpenAIResponsesLlmParams,
} from '../../../src/labs/openai/openai_responses_llm.js';
import {enforceStrictOpenAiSchema} from '../../../src/labs/openai/openai_schema.js';
import {logger} from '../../../src/utils/logger.js';

import {
  CaptureClient,
  collect,
  fakeEventStream,
  llmRequestOf,
  userRequest,
} from './openai_responses_test_doubles.js';

const mocks = vi.hoisted(() => ({
  clientOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('openai', () => ({
  OpenAI: class {
    readonly responses = {
      create: async () => ({id: 'resp_mock', status: 'completed', output: []}),
    };
    constructor(options: Record<string, unknown>) {
      mocks.clientOptions.push(options);
    }
  },
}));

/** Model-level request options, defaulted the way the class defaults them. */
function requestOptions(
  overrides: Partial<ResponsesRequestOptions> = {},
): ResponsesRequestOptions {
  return {model: 'gpt-5', extraRequestArgs: {}, ...overrides};
}

beforeEach(() => {
  mocks.clientOptions.length = 0;
  vi.restoreAllMocks();
});

describe('OpenAI Responses request building', () => {
  it('test_request_kwargs_use_responses_api_shape', () => {
    const request = llmRequestOf({
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
    });

    const body = buildResponsesCreateParams(
      request,
      requestOptions({
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoning: {effort: 'medium'},
      }),
      false,
    );

    expect(body['model']).toBe('gpt-5-mini');
    expect(body['instructions']).toBe('You are concise.');
    expect(body['previous_response_id']).toBe('resp_previous');
    expect(body['stream']).toBe(false);
    expect(body['temperature']).toBe(0.2);
    expect(body['top_p']).toBe(0.9);
    expect(body['max_output_tokens']).toBe(128);
    expect(body['store']).toBe(false);
    expect(body['include']).toEqual(['reasoning.encrypted_content']);
    expect(body['reasoning']).toEqual({effort: 'medium'});
    expect(body['input']).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'What is the weather?'}],
      },
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        // JSON.stringify emits no spaces where Python's json.dumps does.
        output: '{"temperature":"70 F"}',
      },
    ]);
    expect(body['tools']).toEqual([
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

  it('test_extra_request_args_override_and_merge_extra_body', () => {
    const body = buildResponsesCreateParams(
      userRequest({config: {temperature: 0.1, stopSequences: ['STOP']}}),
      requestOptions({
        extraRequestArgs: {temperature: 0.9, extra_body: {foo: 'bar'}},
      }),
      false,
    );

    // Python asserts on kwargs, where `stop` and `foo` sit under `extra_body`
    // because openai-python merges that request option into the JSON. The Node
    // SDK has no such option, so the same wire body needs them at the top
    // level. `openai_responses_wire_test.ts` pins the serialized request.
    expect(body['temperature']).toBe(0.9);
    expect(body['stop']).toEqual(['STOP']);
    expect(body['foo']).toBe('bar');
    expect(body).not.toHaveProperty('extra_body');
  });
});

describe('OpenAI Responses content mapping', () => {
  it('test_content_mapping_preserves_model_tool_calls_and_reasoning', () => {
    const items = contentToResponsesInputItems({
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
    const items = contentToResponsesInputItems({
      role: 'model',
      parts: [
        {
          text: 'Need weather first.',
          thought: true,
          thoughtSignature: 'ZW5jcnlwdGVkX3JlYXNvbmluZw==',
        },
        {thought: true, thoughtSignature: 'cmVkYWN0ZWRfcmVhc29uaW5n'},
      ],
    });

    expect(items).toEqual([]);
  });

  it('test_content_mapping_sanitizes_function_call_ids_per_request', () => {
    const items = toResponsesInput([
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
    ]);

    expect(items.map((item) => 'call_id' in item && item.call_id)).toEqual([
      'call_adk_fallback_0',
      'call_adk_fallback_0',
      'call_adk_fallback_1',
      'call_adk_fallback_2',
    ]);
  });

  it('test_function_response_serializes_mcp_content_as_text', () => {
    const items = contentToResponsesInputItems({
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
    const items = contentToResponsesInputItems({
      role: 'user',
      parts: [
        // The TypeScript genai SDK carries inline data already base64-encoded.
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

    const [message] = items;
    expect(message.type).toBe('message');
    if (message.type !== 'message' || typeof message.content === 'string') {
      expect.fail('expected a message item with content blocks');
    }
    expect(message.content[0]).toEqual({
      type: 'input_image',
      detail: 'auto',
      image_url: 'data:image/png;base64,aW1hZ2U=',
    });
    expect(message.content[1]).toEqual({
      type: 'input_file',
      filename: 'a.txt',
      file_data: 'data:text/plain;base64,aGVsbG8=',
    });
    expect(message.content[2]).toEqual({
      type: 'input_file',
      file_id: 'file-abc',
    });
    expect(message.content[3]).toEqual({
      type: 'input_file',
      file_url: 'https://example.com/doc.pdf',
    });
    expect(message.content[4]).toEqual({
      type: 'input_image',
      detail: 'auto',
      image_url: 'https://example.com/image.png',
    });
  });

  it('test_assistant_media_is_filtered', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const items = contentToResponsesInputItems({
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
    expect(warnSpy).toHaveBeenCalledWith(
      'Media data is not supported in Responses assistant turns.',
    );
  });

  it('test_code_parts_are_preserved_as_text', () => {
    const items = contentToResponsesInputItems({
      role: 'user',
      parts: [
        {executableCode: {language: Language.PYTHON, code: 'print(1)'}},
        {codeExecutionResult: {output: '1', outcome: Outcome.OUTCOME_OK}},
      ],
    });

    const [message] = items;
    if (message.type !== 'message' || typeof message.content === 'string') {
      expect.fail('expected a message item with content blocks');
    }
    expect(message.content).toEqual([
      {type: 'input_text', text: 'Code:```python\nprint(1)\n```'},
      {type: 'input_text', text: 'Execution Result:```code_output\n1\n```'},
    ]);
  });

  it('test_code_parts_handle_missing_inner_fields', () => {
    const items = contentToResponsesInputItems({
      role: 'user',
      parts: [{executableCode: {language: Language.PYTHON}}],
    });

    const [message] = items;
    if (message.type !== 'message' || typeof message.content === 'string') {
      expect.fail('expected a message item with content blocks');
    }
    expect(message.content[0]).toEqual({
      type: 'input_text',
      text: 'Code:```python\n\n```',
    });
  });
});

describe('OpenAI Responses tool declarations', () => {
  it('test_function_declaration_uses_responses_tool_shape', () => {
    const tool = functionDeclarationToResponsesTool({
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
    const tool = functionDeclarationToResponsesTool({
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
    const tool = functionDeclarationToResponsesTool({
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

    expect(tool.parameters['properties']).toEqual({query: {type: 'string'}});
    expect(tool.parameters['required']).toEqual(['query']);
  });

  it.each([
    [FunctionCallingConfigMode.ANY, 'required'],
    [FunctionCallingConfigMode.NONE, 'none'],
    [FunctionCallingConfigMode.AUTO, 'auto'],
  ])('test_tool_choice_maps_function_calling_mode(%s)', (mode, expected) => {
    expect(
      toolChoiceFromConfig({
        toolConfig: {functionCallingConfig: {mode}},
      }),
    ).toBe(expected);
  });
});

describe('OpenAI Responses structured output', () => {
  it('test_structured_output_uses_responses_text_format', () => {
    // Python passes a pydantic model, whose JSON schema carries its class name
    // as `title`. The TypeScript equivalent is a schema that sets `title`.
    const answer: Schema = {
      title: 'Answer',
      type: Type.OBJECT,
      properties: {answer: {type: Type.STRING}},
    };

    const body = buildResponsesCreateParams(
      userRequest({config: {responseSchema: answer}}),
      requestOptions(),
      false,
    );

    expect(body['text']).toEqual({
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

  it('test_structured_output_schema_name_is_sanitized', () => {
    const body = buildResponsesCreateParams(
      userRequest({
        config: {
          responseJsonSchema: {
            title: 'My Schema!',
            type: 'object',
            properties: {x: {type: 'integer'}},
          },
        },
      }),
      requestOptions(),
      false,
    );

    const text = body['text'] as {format: {name: string}};
    expect(text.format.name).toBe('My_Schema_');
  });

  it('test_structured_output_preserves_any_of_for_genai_schema', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        choice: {anyOf: [{type: Type.STRING}, {type: Type.INTEGER}]},
      },
    };

    const body = buildResponsesCreateParams(
      userRequest({config: {responseSchema: schema}}),
      requestOptions(),
      false,
    );

    const text = body['text'] as {
      format: {schema: Record<string, Record<string, Record<string, unknown>>>};
    };
    expect(text.format.schema['properties']['choice']).toEqual({
      anyOf: [{type: 'string'}, {type: 'integer'}],
    });
  });

  it('test_enforce_strict_openai_schema_handles_nested_refs', () => {
    const schema: Record<string, unknown> = {
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

    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['choice', 'items']);
    const defs = schema['$defs'] as {Item: Record<string, unknown>};
    expect(defs.Item['additionalProperties']).toBe(false);
    expect(defs.Item['required']).toEqual(['n']);
  });
});

describe('OpenAI Responses reasoning config', () => {
  function reasoningFor(params: OpenAIResponsesLlmParams, config: object) {
    return buildResponsesCreateParams(
      userRequest({config}),
      requestOptions({reasoning: params.reasoning}),
      false,
    )['reasoning'];
  }

  it('test_thinking_config_zero_budget_maps_to_minimal_reasoning', () => {
    expect(
      reasoningFor(
        {reasoning: {effort: 'medium'}},
        {thinkingConfig: {thinkingBudget: 0}},
      ),
    ).toEqual({effort: 'minimal', summary: 'concise'});
  });

  it.each([
    [ThinkingLevel.MINIMAL, 'minimal'],
    [ThinkingLevel.LOW, 'low'],
    [ThinkingLevel.MEDIUM, 'medium'],
    [ThinkingLevel.HIGH, 'high'],
    [ThinkingLevel.THINKING_LEVEL_UNSPECIFIED, 'medium'],
  ])(
    'test_thinking_config_level_maps_to_openai_reasoning_effort(%s)',
    (thinkingLevel, effort) => {
      expect(reasoningFor({}, {thinkingConfig: {thinkingLevel}})).toEqual({
        effort,
        summary: 'concise',
      });
    },
  );

  it('test_thinking_config_level_takes_precedence_over_budget', () => {
    expect(
      reasoningFor(
        {},
        {
          thinkingConfig: {
            thinkingBudget: 0,
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      ),
    ).toEqual({effort: 'high', summary: 'concise'});
  });

  it('test_thinking_config_automatic_uses_medium_concise_reasoning', () => {
    expect(
      reasoningFor(
        {reasoning: {effort: 'high'}},
        {thinkingConfig: {thinkingBudget: -1}},
      ),
    ).toEqual({effort: 'medium', summary: 'concise'});
  });

  it('test_thinking_config_positive_budget_uses_medium_concise_reasoning', () => {
    expect(reasoningFor({}, {thinkingConfig: {thinkingBudget: 1024}})).toEqual({
      effort: 'medium',
      summary: 'concise',
    });
  });

  it('test_thinking_config_none_budget_raises', () => {
    expect(() => reasoningFor({}, {thinkingConfig: {}})).toThrow(
      /thinkingBudget must be set explicitly/,
    );
  });
});

describe('OpenAI Responses response parsing', () => {
  it('test_response_parsing_maps_text_reasoning_tool_calls_and_usage', () => {
    const llmResponse = responseToLlmResponse(
      {
        id: 'resp_123',
        model: 'gpt-5',
        status: 'completed',
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: {cached_tokens: 3},
          output_tokens_details: {reasoning_tokens: 4},
        },
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{type: 'summary_text', text: 'Think.'}],
            encrypted_content: 'encrypted',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{type: 'output_text', text: 'Calling a tool.'}],
          },
          {
            type: 'function_call',
            call_id: 'call_123',
            name: 'get_weather',
            arguments: '{"location": "Paris"}',
          },
        ],
      },
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
    const parts = llmResponse.content?.parts ?? [];
    expect(parts[0]).toEqual({
      text: 'Think.',
      thought: true,
      // Python stores raw bytes; the TypeScript genai Part carries base64.
      thoughtSignature: Buffer.from('encrypted', 'utf-8').toString('base64'),
    });
    expect(parts[1]?.text).toBe('Calling a tool.');
    expect(parts[2]?.functionCall).toEqual({
      id: 'call_123',
      name: 'get_weather',
      args: {location: 'Paris'},
    });
    const metadata = llmResponse.customMetadata?.['openai_response'] as {
      reasoning: unknown;
    };
    expect(metadata.reasoning).toEqual([
      {encrypted_content: 'encrypted', id: 'rs_1'},
    ]);
  });

  it('test_response_parsing_accepts_openai_sdk_response_types', () => {
    // The Node SDK returns plain JSON objects, so the typed path the Python
    // test exercises is the same code path as its dict-shaped twin.
    const llmResponse = responseToLlmResponse(
      {
        id: 'resp_typed',
        model: 'gpt-5',
        status: 'completed',
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
            content: [{type: 'output_text', text: 'Typed hello.'}],
          },
          {
            type: 'function_call',
            call_id: 'call_typed',
            name: 'get_weather',
            arguments: '{"city": "Tokyo"}',
          },
        ],
        usage: {
          input_tokens: 3,
          input_tokens_details: {cached_tokens: 1},
          output_tokens: 5,
          output_tokens_details: {reasoning_tokens: 2},
          total_tokens: 8,
        },
      },
      {includeResponseMetadata: true},
    );

    const parts = llmResponse.content?.parts ?? [];
    expect(llmResponse.interactionId).toBe('resp_typed');
    expect(parts[0]).toEqual({
      text: 'Typed thought.',
      thought: true,
      thoughtSignature: Buffer.from('encrypted_typed', 'utf-8').toString(
        'base64',
      ),
    });
    expect(parts[1]?.text).toBe('Typed hello.');
    expect(parts[2]?.functionCall?.id).toBe('call_typed');
    expect(parts[2]?.functionCall?.args).toEqual({city: 'Tokyo'});
    expect(llmResponse.usageMetadata?.totalTokenCount).toBe(8);
    const metadata = llmResponse.customMetadata?.['openai_response'] as {
      reasoning: unknown;
    };
    expect(metadata.reasoning).toEqual([
      {encrypted_content: 'encrypted_typed', id: 'rs_typed'},
    ]);
  });

  it('test_response_parsing_preserves_redacted_reasoning', () => {
    const llmResponse = responseToLlmResponse(
      {
        id: 'resp_123',
        model: 'gpt-5',
        status: 'completed',
        output: [
          {type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted_only'},
        ],
      },
      {includeResponseMetadata: true},
    );

    expect(llmResponse.content?.parts?.[0]).toEqual({
      thought: true,
      thoughtSignature: Buffer.from('encrypted_only', 'utf-8').toString(
        'base64',
      ),
    });
  });

  it('test_response_parsing_incomplete_max_tokens_sets_error', () => {
    const llmResponse = responseToLlmResponse(
      {
        id: 'resp_1',
        model: 'gpt-5',
        status: 'incomplete',
        incomplete_details: {reason: 'max_output_tokens'},
        output: [],
      },
      {includeResponseMetadata: true},
    );

    expect(llmResponse.finishReason).toBe(FinishReason.MAX_TOKENS);
    expect(llmResponse.errorCode).toBe(FinishReason.MAX_TOKENS);
    expect(llmResponse.errorMessage).toContain('max_output_tokens');
  });

  it('test_response_parsing_failed_status_sets_error', () => {
    const llmResponse = responseToLlmResponse(
      {
        id: 'resp_1',
        model: 'gpt-5',
        status: 'failed',
        error: {message: 'boom'},
        output: [],
      },
      {includeResponseMetadata: true},
    );

    expect(llmResponse.finishReason).toBe(FinishReason.OTHER);
    expect(llmResponse.errorCode).toBe(FinishReason.OTHER);
    expect(llmResponse.errorMessage).toContain('boom');
  });

  it('test_response_parsing_maps_refusal_to_prefixed_text', () => {
    const llmResponse = responseToLlmResponse(
      {
        id: 'resp_1',
        model: 'gpt-5',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{type: 'refusal', refusal: 'I cannot help.'}],
          },
        ],
      },
      {includeResponseMetadata: true},
    );

    expect(llmResponse.content?.parts?.[0]?.text).toBe(
      'OpenAI refusal: I cannot help.',
    );
  });

  it('test_loads_json_object_handles_malformed_arguments', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(loadsJsonObject('not json')).toEqual({});
    expect(loadsJsonObject('[1, 2]')).toEqual({});
    expect(loadsJsonObject('')).toEqual({});
    expect(loadsJsonObject('{"a": 1}')).toEqual({a: 1});
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to parse Responses API function arguments as JSON.',
    );
  });
});

describe('OpenAI Responses generation', () => {
  it('test_generate_content_async_calls_responses_create', async () => {
    const client = new CaptureClient({
      id: 'resp_123',
      model: 'gpt-5',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{type: 'output_text', text: 'Hello'}],
        },
      ],
    });
    const llm = new OpenAIResponsesLlm({model: 'gpt-5', client});

    const responses = await collect(llm.generateContentAsync(userRequest()));

    expect(client.responses.body?.['model']).toBe('gpt-5');
    expect(client.responses.body?.['stream']).toBe(false);
    expect(responses[0]?.content?.parts?.[0]?.text).toBe('Hello');
    expect(responses[0]?.interactionId).toBe('resp_123');
  });

  it('test_generate_content_async_can_skip_response_metadata', async () => {
    const client = new CaptureClient({
      id: 'resp_123',
      model: 'gpt-5',
      status: 'completed',
      usage: {input_tokens: 1, output_tokens: 2, total_tokens: 3},
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{type: 'output_text', text: 'Hello'}],
        },
      ],
    });
    const llm = new OpenAIResponsesLlm({
      model: 'gpt-5',
      client,
      includeResponseMetadata: false,
    });

    const responses = await collect(llm.generateContentAsync(userRequest()));

    expect(responses[0]?.customMetadata).toBeUndefined();
    expect(responses[0]?.usageMetadata?.totalTokenCount).toBe(3);
  });

  it('test_provided_client_is_used', async () => {
    const client = new CaptureClient({
      id: 'resp_injected',
      status: 'completed',
      output: [],
    });
    const llm = new OpenAIResponsesLlm({model: 'gpt-5', client});

    await collect(llm.generateContentAsync(userRequest()));

    expect(client.responses.createCalls).toBe(1);
    expect(mocks.clientOptions).toEqual([]);
  });
});

describe('OpenAI Responses streaming', () => {
  function streamingLlm(
    events: OpenAIStreamEvent[],
    params: OpenAIResponsesLlmParams = {},
  ): {llm: OpenAIResponsesLlm; client: CaptureClient} {
    const client = new CaptureClient(fakeEventStream(events));
    return {
      llm: new OpenAIResponsesLlm({model: 'gpt-5', client, ...params}),
      client,
    };
  }

  it('test_streaming_generation_yields_partials_and_final_response', async () => {
    const {llm, client} = streamingLlm([
      {
        type: 'response.created',
        response: {id: 'resp_stream', model: 'gpt-5'},
      },
      {type: 'response.reasoning_summary_text.delta', delta: 'Think'},
      {type: 'response.output_text.delta', delta: 'Hel'},
      {type: 'response.output_text.delta', delta: 'lo'},
      {
        type: 'response.completed',
        response: {
          id: 'resp_stream',
          model: 'gpt-5',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              summary: [{type: 'summary_text', text: 'Think'}],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{type: 'output_text', text: 'Hello'}],
            },
          ],
        },
      },
    ]);

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(client.responses.body?.['stream']).toBe(true);
    expect(responses[0]?.partial).toBe(true);
    expect(responses[0]?.content?.parts?.[0]?.thought).toBe(true);
    expect(responses[0]?.content?.parts?.[0]?.text).toBe('Think');
    expect(responses[1]?.partial).toBe(true);
    expect(responses[1]?.content).toBeUndefined();
    expect(responses[1]?.customMetadata).toEqual({
      openai_response: {
        stream_event: {
          type: 'response.output_text.delta',
          reasoning_done: true,
        },
      },
    });
    expect(responses[2]?.content?.parts?.[0]?.text).toBe('Hel');
    expect(responses[3]?.content?.parts?.[0]?.text).toBe('lo');
    expect(responses[4]?.partial).toBeUndefined();
    expect(responses[4]?.content?.parts?.[0]?.thought).toBe(true);
    expect(responses[4]?.content?.parts?.[1]?.text).toBe('Hello');
  });

  it('test_streaming_generation_can_skip_response_metadata', async () => {
    const {llm} = streamingLlm(
      [
        {
          type: 'response.created',
          response: {id: 'resp_stream', model: 'gpt-5'},
        },
        {type: 'response.reasoning_summary_text.delta', delta: 'Think'},
        {type: 'response.output_text.delta', delta: 'Hello'},
        {
          type: 'response.completed',
          response: {
            id: 'resp_stream',
            model: 'gpt-5',
            status: 'completed',
            output: [
              {
                type: 'reasoning',
                summary: [{type: 'summary_text', text: 'Think'}],
              },
              {
                type: 'message',
                role: 'assistant',
                content: [{type: 'output_text', text: 'Hello'}],
              },
            ],
          },
        },
      ],
      {includeResponseMetadata: false},
    );

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses.map((response) => response.customMetadata)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(responses[0]?.content?.parts?.[0]?.thought).toBe(true);
    expect(responses[1]?.content?.parts?.[0]?.text).toBe('Hello');
    expect(responses[2]?.partial).toBeUndefined();
  });

  it('test_streaming_generation_fallback_preserves_output_item_order', async () => {
    const {llm} = streamingLlm([
      {
        type: 'response.created',
        response: {id: 'resp_stream', model: 'gpt-5'},
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {id: 'rs_1', type: 'reasoning', summary: []},
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: 'Think',
      },
      {
        type: 'response.reasoning_summary_text.done',
        output_index: 0,
        summary_index: 0,
        text: 'Think',
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {id: 'msg_1', type: 'message', content: []},
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        delta: 'Hel',
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        delta: 'lo',
      },
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: {id: 'rs_2', type: 'reasoning', summary: []},
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 2,
        summary_index: 0,
        delta: 'Again',
      },
      {
        type: 'response.output_item.added',
        output_index: 3,
        item: {id: 'msg_2', type: 'message', content: []},
      },
      {
        type: 'response.output_text.delta',
        output_index: 3,
        content_index: 0,
        delta: 'Bye',
      },
    ]);

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    const finalResponse = responses[responses.length - 1];
    expect(finalResponse?.partial).toBe(false);
    expect(
      finalResponse?.content?.parts?.map((part) => [part.text, part.thought]),
    ).toEqual([
      ['Think', true],
      ['Hello', undefined],
      ['Again', true],
      ['Bye', undefined],
    ]);
    const boundaries = responses.filter((response) => {
      const payload = response.customMetadata?.['openai_response'] as
        | {stream_event?: {reasoning_done?: boolean}}
        | undefined;
      return payload?.stream_event?.reasoning_done === true;
    });
    expect(
      boundaries.map((boundary) => {
        const payload = boundary.customMetadata?.['openai_response'] as {
          stream_event: {type: string};
        };
        return payload.stream_event.type;
      }),
    ).toEqual([
      'response.reasoning_summary_text.done',
      'response.output_item.added',
    ]);
  });

  it('test_streaming_generation_aggregates_function_call_without_completed_event', async () => {
    const {llm} = streamingLlm([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_123',
          name: 'get_weather',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"location"',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: ': "Paris"}',
      },
    ]);

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]?.finishReason).toBe(FinishReason.STOP);
    expect(responses[0]?.content?.parts?.[0]?.functionCall).toEqual({
      id: 'call_123',
      name: 'get_weather',
      args: {location: 'Paris'},
    });
  });

  it('test_streaming_generation_uses_function_arguments_done_event', async () => {
    const {llm} = streamingLlm([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_123',
          name: 'get_weather',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        arguments: '{"location": "Paris"}',
      },
    ]);

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses[0]?.content?.parts?.[0]?.functionCall).toEqual({
      id: 'call_123',
      name: 'get_weather',
      args: {location: 'Paris'},
    });
  });

  it('test_streaming_generation_failed_event_is_terminal', async () => {
    const {llm} = streamingLlm([
      {type: 'response.output_text.delta', delta: 'partial'},
      {type: 'response.failed', response: {id: 'resp_123'}},
    ]);

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses).toHaveLength(2);
    expect(responses[0]?.partial).toBe(true);
    expect(responses[1]?.finishReason).toBe(FinishReason.OTHER);
    expect(responses[1]?.errorCode).toBe(FinishReason.OTHER);
  });

  it('test_streaming_incomplete_event_sets_max_tokens', async () => {
    const {llm} = streamingLlm([
      {type: 'response.output_text.delta', delta: 'Hi'},
      {
        type: 'response.incomplete',
        response: {
          id: 'resp_stream',
          model: 'gpt-5',
          status: 'incomplete',
          incomplete_details: {reason: 'max_output_tokens'},
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{type: 'output_text', text: 'Hi'}],
            },
          ],
        },
      },
    ]);

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses[responses.length - 1]?.finishReason).toBe(
      FinishReason.MAX_TOKENS,
    );
  });

  it('test_streaming_output_item_done_uses_done_item_text', async () => {
    const {llm} = streamingLlm([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {type: 'message', content: []},
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          role: 'assistant',
          content: [{type: 'output_text', text: 'Done text'}],
        },
      },
    ]);

    const responses = await collect(
      llm.generateContentAsync(userRequest(), true),
    );

    expect(responses[responses.length - 1]?.content?.parts?.[0]?.text).toBe(
      'Done text',
    );
  });
});

describe('OpenAI Responses client construction', () => {
  it('test_default_client_built_with_resolved_api_key', async () => {
    const llm = new OpenAIResponsesLlm({model: 'gpt-5', apiKey: 'secret'});

    await collect(llm.generateContentAsync(userRequest()));

    expect(mocks.clientOptions).toEqual([{apiKey: 'secret'}]);
  });

  it('test_api_key_callable_is_resolved', async () => {
    const llm = new OpenAIResponsesLlm({
      model: 'gpt-5',
      apiKey: () => 'dynamic',
    });

    await collect(llm.generateContentAsync(userRequest()));

    expect(mocks.clientOptions).toEqual([{apiKey: 'dynamic'}]);
  });

  it('test_async_api_key_callable_raises', async () => {
    const llm = new OpenAIResponsesLlm({
      model: 'gpt-5',
      apiKey: async () => 'k',
    });

    await expect(
      collect(llm.generateContentAsync(userRequest())),
    ).rejects.toThrow(/Async apiKey providers are not supported/);
    expect(mocks.clientOptions).toEqual([]);
  });

  it('test_azure_client_uses_openai_v1_base_url', async () => {
    const llm = new AzureOpenAIResponsesLlm({
      model: 'deployment',
      azureEndpoint: 'https://example.openai.azure.com/',
      apiKey: 'key',
    });

    await collect(llm.generateContentAsync(userRequest()));

    expect(mocks.clientOptions).toEqual([
      {
        apiKey: 'key',
        baseURL: 'https://example.openai.azure.com/openai/v1/',
      },
    ]);
  });

  it('test_azure_api_key_env_fallback', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'env-key');
    const llm = new AzureOpenAIResponsesLlm({
      model: 'deployment',
      azureEndpoint: 'https://example.openai.azure.com/',
    });

    await collect(llm.generateContentAsync(userRequest()));

    expect(mocks.clientOptions[0]?.['apiKey']).toBe('env-key');
    vi.unstubAllEnvs();
  });
});
