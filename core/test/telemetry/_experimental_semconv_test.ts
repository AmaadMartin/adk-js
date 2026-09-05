/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the experimental OTel GenAI semconv attribute setters.
 *
 * Ported from adk-python `tests/unittests/telemetry/test_experimental_semconv.py`
 * at `main`. Test names are kept verbatim so a reviewer can grep for the
 * original.
 *
 * The attribute keys and the per-part value shapes written by these setters are
 * the wire contract consumed downstream, so the assertions compare whole
 * attribute mappings instead of probing individual keys.
 */

import {LlmRequest, LlmResponse} from '@google/adk';
import {Content, FinishReason, Type} from '@google/genai';
import type {AnyValueMap} from '@opentelemetry/api-logs';
import {describe, expect, it} from 'vitest';

import {
  resolveToolDefinitions,
  setOperationDetailsAttributesFromRequest,
  setOperationDetailsAttributesFromResponse,
  toolDefinitionFromDumpedTool,
} from '../../src/telemetry/_experimental_semconv.js';

const GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';
const GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
const GEN_AI_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';
const GEN_AI_TOOL_DEFINITIONS = 'gen_ai.tool.definitions';
const GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';
const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

/** Builds the minimal `LlmRequest` the setters read. */
function llmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'some-model',
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function requestAttributes(request: LlmRequest): AnyValueMap {
  const attributes: AnyValueMap = {};
  setOperationDetailsAttributesFromRequest(attributes, request);
  return attributes;
}

/** Returns the `[details, common]` maps written for `llmResponse`. */
function responseAttributes(
  llmResponse: LlmResponse,
): [AnyValueMap, AnyValueMap] {
  const details: AnyValueMap = {};
  const common: AnyValueMap = {};
  setOperationDetailsAttributesFromResponse(llmResponse, details, common);
  return [details, common];
}

/** Reads the `parts` of the first emitted input message. */
function firstMessageParts(attributes: AnyValueMap): AnyValueMap[] {
  const messages = attributes[GEN_AI_INPUT_MESSAGES];
  if (!Array.isArray(messages)) {
    expect.fail('expected gen_ai.input.messages to be an array');
  }
  const parts = (messages[0] as AnyValueMap)['parts'];
  if (!Array.isArray(parts)) {
    expect.fail('expected the first message to carry a parts array');
  }
  return parts as AnyValueMap[];
}

/** Reads the first emitted output message. */
function firstOutputMessage(details: AnyValueMap): AnyValueMap {
  const messages = details[GEN_AI_OUTPUT_MESSAGES];
  if (!Array.isArray(messages)) {
    expect.fail('expected gen_ai.output.messages to be an array');
  }
  return messages[0] as AnyValueMap;
}

describe('setOperationDetailsAttributesFromRequest', () => {
  it('test_request_attributes_always_write_the_three_wire_keys', () => {
    // An empty request still emits every key, with empty lists as values. Key
    // names are asserted as literals because consumers read them off the wire.
    const attributes: AnyValueMap = {'pre.existing': 'kept'};

    setOperationDetailsAttributesFromRequest(attributes, llmRequest());

    expect(attributes).toEqual({
      'pre.existing': 'kept',
      'gen_ai.input.messages': [],
      'gen_ai.system_instructions': [],
      'gen_ai.tool.definitions': [],
    });
  });

  it('test_request_attributes_render_every_supported_part_shape', () => {
    // Each genai part maps to its own tagged object; unknown parts are dropped.
    const content: Content = {
      role: 'user',
      parts: [
        {text: 'hi'},
        {inlineData: {mimeType: 'image/png', data: 'iVBORw0='}},
        {
          fileData: {
            mimeType: 'audio/wav',
            fileUri: 'https://example/a.wav',
          },
        },
        {
          functionCall: {
            id: 'call-1',
            name: 'get_weather',
            args: {city: 'Zurich'},
          },
        },
        {
          functionResponse: {
            id: 'call-1',
            name: 'get_weather',
            response: {temp_c: 21},
          },
        },
        {},
      ],
    };

    const attributes = requestAttributes(llmRequest({contents: [content]}));

    expect(attributes[GEN_AI_INPUT_MESSAGES]).toEqual([
      {
        role: 'user',
        parts: [
          {content: 'hi', type: 'text'},
          // `data` is the base64 string `@google/genai` uses, not raw bytes.
          {mime_type: 'image/png', data: 'iVBORw0=', type: 'blob'},
          {
            mime_type: 'audio/wav',
            uri: 'https://example/a.wav',
            type: 'file_data',
          },
          {
            id: 'call-1',
            name: 'get_weather',
            arguments: {city: 'Zurich'},
            type: 'tool_call',
          },
          {
            id: 'call-1',
            response: {temp_c: 21},
            type: 'tool_call_response',
          },
        ],
      },
    ]);
  });

  it('test_request_attributes_synthesize_missing_tool_call_ids', () => {
    // A missing call id becomes `<name>_<part index>`, or the index alone.
    const content: Content = {
      role: 'user',
      parts: [
        {text: 'hi'},
        {functionCall: {name: 'lookup'}},
        {functionResponse: {response: {}}},
      ],
    };

    const attributes = requestAttributes(llmRequest({contents: [content]}));

    const parts = firstMessageParts(attributes);
    expect(parts[1]['id']).toBe('lookup_1');
    expect(parts[2]['id']).toBe('2');
  });

  it.each([
    {role: 'user', expected: 'user'},
    {role: 'model', expected: 'assistant'},
    {role: 'tool', expected: ''},
    {role: undefined, expected: ''},
  ])(
    'test_request_attributes_map_genai_roles_to_otel_roles ($role)',
    ({role, expected}) => {
      const content: Content = {role, parts: [{text: 'hi'}]};

      const attributes = requestAttributes(llmRequest({contents: [content]}));

      expect(attributes[GEN_AI_INPUT_MESSAGES]).toEqual([
        {role: expected, parts: [{content: 'hi', type: 'text'}]},
      ]);
    },
  );

  it('test_request_attributes_flatten_system_instruction_to_parts', () => {
    // System instructions are emitted as bare parts, with no role wrapper.
    const request = llmRequest({config: {systemInstruction: 'Be terse.'}});

    const attributes = requestAttributes(request);

    expect(attributes[GEN_AI_SYSTEM_INSTRUCTIONS]).toEqual([
      {content: 'Be terse.', type: 'text'},
    ]);
  });

  it('test_request_attributes_describe_function_tools_with_parameters', () => {
    // A declared function tool becomes a `function` definition with a schema.
    const request = llmRequest({
      config: {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Gets the weather.',
                parameters: {
                  type: Type.OBJECT,
                  properties: {city: {type: Type.STRING}},
                  required: ['city'],
                },
              },
            ],
          },
        ],
      },
    });

    const attributes = requestAttributes(request);

    expect(attributes[GEN_AI_TOOL_DEFINITIONS]).toEqual([
      {
        name: 'get_weather',
        description: 'Gets the weather.',
        parameters: {
          type: 'OBJECT',
          properties: {city: {type: 'STRING'}},
          required: ['city'],
        },
        type: 'function',
      },
    ]);
  });

  it('test_request_attributes_describe_a_raw_mcp_tool', () => {
    // A caller bypassing ADK's tool pipeline can hand genai a raw MCP tool.
    // The reference reaches it through `config.tools`; here that field is typed
    // as `ToolUnion[]`, so the descriptor goes through the resolver directly.
    // The fixture is the plain object the MCP JS SDK produces at runtime, since
    // it has no runtime class.
    const definitions = resolveToolDefinitions([
      {
        name: 'get_weather',
        description: 'Gets the weather.',
        inputSchema: {
          type: 'object',
          properties: {city: {type: 'string'}},
          required: ['city'],
        },
      },
    ]);

    expect(definitions).toEqual([
      {
        name: 'get_weather',
        description: 'Gets the weather.',
        parameters: {
          type: 'object',
          properties: {city: {type: 'string'}},
          required: ['city'],
        },
        type: 'function',
      },
    ]);
  });
});

describe('setOperationDetailsAttributesFromResponse', () => {
  it('test_response_attributes_split_between_details_and_common', () => {
    // Messages go to the details map; finish reason and usage to common.
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'Response'}]},
      finishReason: FinishReason.STOP,
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        cachedContentTokenCount: 4,
      },
    };

    const [details, common] = responseAttributes(llmResponse);

    expect(details).toEqual({
      'gen_ai.output.messages': [
        {
          role: 'assistant',
          parts: [{content: 'Response', type: 'text'}],
          finish_reason: 'stop',
        },
      ],
    });
    expect(common).toEqual({
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read.input_tokens': 4,
    });
  });

  it('test_response_attributes_accumulate_output_messages_across_a_stream', () => {
    // Keeping only the last chunk truncated the log to it.
    const details: AnyValueMap = {};
    const common: AnyValueMap = {};

    for (const text of ['text ', 'response']) {
      setOperationDetailsAttributesFromResponse(
        {
          content: {role: 'model', parts: [{text}]},
          finishReason: FinishReason.STOP,
        },
        details,
        common,
      );
    }

    expect(details).toEqual({
      'gen_ai.output.messages': [
        {
          role: 'assistant',
          parts: [{content: 'text ', type: 'text'}],
          finish_reason: 'stop',
        },
        {
          role: 'assistant',
          parts: [{content: 'response', type: 'text'}],
          finish_reason: 'stop',
        },
      ],
    });
  });

  it('test_streamed_chunks_are_reported_one_message_each', () => {
    // Each chunk is its own message, as the OTel instrumentor reports a stream.
    const details: AnyValueMap = {};
    const common: AnyValueMap = {};

    // Only the chunk that ends the turn reports why generation stopped.
    const chunks: Array<[string, FinishReason]> = [
      ['text ', FinishReason.FINISH_REASON_UNSPECIFIED],
      ['response', FinishReason.STOP],
    ];
    for (const [text, finishReason] of chunks) {
      setOperationDetailsAttributesFromResponse(
        {content: {role: 'model', parts: [{text}]}, finishReason},
        details,
        common,
      );
    }

    const messages = details[GEN_AI_OUTPUT_MESSAGES];
    if (!Array.isArray(messages)) {
      expect.fail('expected gen_ai.output.messages to be an array');
    }
    expect(
      messages.map(
        (message) =>
          ((message as AnyValueMap)['parts'] as AnyValueMap[])[0]['content'],
      ),
    ).toEqual(['text ', 'response']);
    expect(common).toEqual({'gen_ai.response.finish_reasons': ['stop']});
  });

  it('test_response_attributes_omit_output_messages_without_content', () => {
    // An error-only response writes no output-message key at all.
    const llmResponse: LlmResponse = {
      errorCode: 'UNAVAILABLE',
      finishReason: FinishReason.OTHER,
      usageMetadata: {promptTokenCount: 7},
    };

    const [details, common] = responseAttributes(llmResponse);

    expect(details).toEqual({});
    expect(common).toEqual({
      [GEN_AI_RESPONSE_FINISH_REASONS]: ['error'],
      [GEN_AI_USAGE_INPUT_TOKENS]: 7,
    });
  });

  it('test_response_attributes_omit_finish_reasons_but_keep_empty_message_field', () => {
    // No finish reason drops the common key; the message field becomes ''.
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'Response'}]},
    };

    const [details, common] = responseAttributes(llmResponse);

    expect(common).toEqual({});
    expect(firstOutputMessage(details)['finish_reason']).toBe('');
  });

  it.each([
    {finishReason: FinishReason.STOP, expected: 'stop'},
    {finishReason: FinishReason.MAX_TOKENS, expected: 'length'},
    {finishReason: FinishReason.OTHER, expected: 'error'},
    {finishReason: FinishReason.SAFETY, expected: 'safety'},
  ])(
    'test_response_attributes_normalize_finish_reason ($finishReason)',
    ({finishReason, expected}) => {
      // genai finish reasons are mapped onto the OTel-allowed vocabulary.
      const llmResponse: LlmResponse = {
        content: {role: 'model', parts: [{text: 'Response'}]},
        finishReason,
      };

      const [details, common] = responseAttributes(llmResponse);

      expect(common[GEN_AI_RESPONSE_FINISH_REASONS]).toEqual([expected]);
      expect(firstOutputMessage(details)['finish_reason']).toBe(expected);
    },
  );

  it('test_response_attributes_treat_unspecified_finish_reason_as_unreported', () => {
    // The proto3 zero value means unreported, not failed.
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'Response'}]},
      finishReason: FinishReason.FINISH_REASON_UNSPECIFIED,
    };

    const [details, common] = responseAttributes(llmResponse);

    expect(GEN_AI_RESPONSE_FINISH_REASONS in common).toBe(false);
    expect(firstOutputMessage(details)['finish_reason']).toBe('');
  });

  it('test_response_attributes_omit_token_usage_without_metadata', () => {
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'Response'}]},
      finishReason: FinishReason.STOP,
    };

    const [, common] = responseAttributes(llmResponse);

    expect(common).toEqual({[GEN_AI_RESPONSE_FINISH_REASONS]: ['stop']});
    expect(GEN_AI_USAGE_INPUT_TOKENS in common).toBe(false);
    expect(GEN_AI_USAGE_OUTPUT_TOKENS in common).toBe(false);
  });
});

describe('TestModelDumpToolDefinitionSchemaKey', () => {
  // The schema key an MCP tool dumps under changes with the SDK version.
  // Reading the wrong key is not an error: the tool is still reported, and
  // reported with no parameters, so the loss shows up only as an emptier span.
  /** A dumped tool whose schema sits under the given key. */
  function dumpingTool(schemaKey: string): Record<string, unknown> {
    return {
      name: 'mcp_tool',
      description: 'A standalone mcp tool',
      [schemaKey]: {type: 'object', properties: {id: {type: 'integer'}}},
    };
  }

  it.each(['parameters', 'inputSchema', 'input_schema'])(
    'test_parameters_are_read_under_every_spelling (%s)',
    (schemaKey) => {
      const definition = toolDefinitionFromDumpedTool(dumpingTool(schemaKey));

      expect(definition.parameters).toEqual({
        type: 'object',
        properties: {id: {type: 'integer'}},
      });
    },
  );

  it('test_an_unknown_spelling_is_still_reported_without_parameters', () => {
    // The fallback must stay lossy-but-alive, not raise. Telemetry is not worth
    // failing a tool call over.
    const definition = toolDefinitionFromDumpedTool(
      dumpingTool('schemaOfInput'),
    );

    expect(definition.name).toBe('mcp_tool');
    expect(definition.parameters).toBeNull();
  });
});
