/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Tests written for the adk-js port, kept apart from the tests ported verbatim
// from adk-python so the ported set stays legible.

import {FinishReason, FunctionCallingConfigMode, Type} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {
  AzureOpenAIResponsesLlm as PublicAzureOpenAIResponsesLlm,
  OpenAIResponsesLlm as PublicOpenAIResponsesLlm,
} from '@google/adk';
import {
  buildResponsesCreateParams,
  contentToResponsesInputItems,
  functionDeclarationToResponsesTool,
  openAiReasoningConfig,
  ResponsesRequestOptions,
  responseTextConfig,
  responseToLlmResponse,
  serializeToolOutput,
  toolChoiceFromConfig,
  toUsageMetadata,
} from '../../../src/labs/openai/openai_responses_converters.js';

import {
  AzureOpenAIResponsesLlm,
  OpenAIResponsesLlm,
} from '../../../src/labs/openai/openai_responses_llm.js';
import {
  ResponsesStreamAccumulator,
  streamResponses,
} from '../../../src/labs/openai/openai_responses_stream.js';
import {enforceStrictOpenAiSchema} from '../../../src/labs/openai/openai_schema.js';
import {logger} from '../../../src/utils/logger.js';
import type {OptionalPeer} from '../../../src/utils/optional_peer.js';
import {isRecord, lowercaseSchemaTypes} from '../../../src/utils/schema.js';

import {
  CaptureClient,
  collect,
  fakeEventStream,
  userRequest,
} from './openai_responses_test_doubles.js';

// The `openai` package is a devDependency, so it resolves in this repo and the
// missing-package path is unreachable as it stands. The real loader still runs
// against the real descriptor the model passes; only the import is made to
// fail the way it fails for a user who never installed the package.
vi.mock('../../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/utils/optional_peer.js')
    >();
  return {
    ...actual,
    loadOptionalPeer: (peer: OptionalPeer) =>
      actual.loadOptionalPeer(peer, () =>
        Promise.reject(
          Object.assign(
            new Error(`Cannot find package '${peer.packageName}'`),
            {code: 'ERR_MODULE_NOT_FOUND'},
          ),
        ),
      ),
  };
});

function requestOptions(
  overrides: Partial<ResponsesRequestOptions> = {},
): ResponsesRequestOptions {
  return {model: 'gpt-5', extraRequestArgs: {}, ...overrides};
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAIResponsesLlm contract', () => {
  it('exports both models from the package entry point', () => {
    expect(PublicOpenAIResponsesLlm).toBe(OpenAIResponsesLlm);
    expect(PublicAzureOpenAIResponsesLlm).toBe(AzureOpenAIResponsesLlm);
  });

  it('registers no model names, so a bare model string never resolves it', () => {
    expect(OpenAIResponsesLlm.supportedModels).toEqual([]);
    expect(AzureOpenAIResponsesLlm.supportedModels).toEqual([]);
  });

  it('defaults the model to gpt-5', () => {
    expect(new OpenAIResponsesLlm().model).toBe('gpt-5');
    expect(new OpenAIResponsesLlm({model: 'gpt-4o'}).model).toBe('gpt-4o');
  });

  it('rejects connect(), which the Responses API cannot serve', async () => {
    const llm = new OpenAIResponsesLlm({model: 'gpt-5'});

    await expect(llm.connect(userRequest())).rejects.toThrow(
      'Live connection is not supported for gpt-5.',
    );
  });

  it('forwards the abort signal to the client', async () => {
    const controller = new AbortController();
    const client = new CaptureClient({status: 'completed', output: []});
    const llm = new OpenAIResponsesLlm({model: 'gpt-5', client});

    await collect(
      llm.generateContentAsync(userRequest(), false, controller.signal),
    );

    expect(client.responses.options?.signal).toBe(controller.signal);
  });

  it('builds the client once and shares it across requests', async () => {
    const client = new CaptureClient({status: 'completed', output: []});
    const llm = new OpenAIResponsesLlm({model: 'gpt-5', client});

    await collect(llm.generateContentAsync(userRequest()));
    await collect(llm.generateContentAsync(userRequest()));

    expect(client.responses.createCalls).toBe(2);
  });

  it('reads a non-object result as an empty response', async () => {
    const client = new CaptureClient('not a response');
    const llm = new OpenAIResponsesLlm({model: 'gpt-5', client});

    const responses = await collect(llm.generateContentAsync(userRequest()));

    expect(responses).toHaveLength(1);
    expect(responses[0]?.content).toBeUndefined();
    expect(responses[0]?.finishReason).toBeUndefined();
  });

  it('names the feature and the install command when openai is missing', async () => {
    const llm = new OpenAIResponsesLlm({model: 'gpt-5', apiKey: 'key'});

    await expect(
      collect(llm.generateContentAsync(userRequest())),
    ).rejects.toThrow(
      /OpenAIResponsesLlm .* requires the optional peer dependency "openai"[\s\S]*npm install openai/,
    );
  });

  it('leaves the Azure base URL unset when no endpoint is given', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', '');
    const client = new CaptureClient({status: 'completed', output: []});
    const llm = new AzureOpenAIResponsesLlm({model: 'deployment', client});

    await collect(llm.generateContentAsync(userRequest()));

    expect(client.responses.createCalls).toBe(1);
    vi.unstubAllEnvs();
  });
});

describe('Responses request assembly', () => {
  it('keeps falsy request values through the final strip', () => {
    const body = buildResponsesCreateParams(
      userRequest({config: {temperature: 0}}),
      requestOptions({store: false, parallelToolCalls: false}),
      false,
    );

    expect(body).toMatchObject({
      stream: false,
      store: false,
      temperature: 0,
      parallel_tool_calls: false,
    });
  });

  it('drops the model options the caller left unset', () => {
    const body = buildResponsesCreateParams(
      userRequest(),
      requestOptions(),
      false,
    );

    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'stream']);
  });

  it('falls back to the model name the class was built with', () => {
    const body = buildResponsesCreateParams(
      userRequest(),
      requestOptions({model: 'gpt-4o'}),
      false,
    );

    expect(body['model']).toBe('gpt-4o');
  });

  it('sends the model-level options the caller set', () => {
    const body = buildResponsesCreateParams(
      userRequest(),
      requestOptions({
        truncation: 'auto',
        serviceTier: 'flex',
        include: ['reasoning.encrypted_content'],
        reasoning: {effort: 'low'},
      }),
      true,
    );

    expect(body).toMatchObject({
      stream: true,
      truncation: 'auto',
      service_tier: 'flex',
      include: ['reasoning.encrypted_content'],
      reasoning: {effort: 'low'},
    });
  });

  it('keeps the request reasoning config over the model-level one', () => {
    const body = buildResponsesCreateParams(
      userRequest({config: {thinkingConfig: {thinkingBudget: 0}}}),
      requestOptions({reasoning: {effort: 'high'}}),
      false,
    );

    expect(body['reasoning']).toEqual({effort: 'minimal', summary: 'concise'});
  });

  it('sends the stop sequences as a top-level field', () => {
    const body = buildResponsesCreateParams(
      userRequest({config: {stopSequences: ['STOP']}}),
      requestOptions(),
      false,
    );

    expect(body['stop']).toEqual(['STOP']);
    expect(body).not.toHaveProperty('extra_body');
  });

  it('ignores a non-object extra_body override', () => {
    const body = buildResponsesCreateParams(
      userRequest({config: {stopSequences: ['STOP']}}),
      requestOptions({extraRequestArgs: {extra_body: 'nonsense'}}),
      false,
    );

    expect(body['stop']).toEqual(['STOP']);
    expect(body).not.toHaveProperty('extra_body');
  });

  it('sends tool_choice when the request sets a function-calling mode', () => {
    const body = buildResponsesCreateParams(
      userRequest({
        config: {toolConfig: {functionCallingConfig: {mode: undefined}}},
      }),
      requestOptions(),
      false,
    );

    expect(body).not.toHaveProperty('tool_choice');
  });

  it('reads a multi-part system instruction', () => {
    const body = buildResponsesCreateParams(
      userRequest({
        config: {
          // adk-js joins the parts with a newline; adk-python joins with ''.
          systemInstruction: {parts: [{text: 'Be brief.'}, {text: 'Be kind.'}]},
        },
      }),
      requestOptions(),
      false,
    );

    expect(body['instructions']).toBe('Be brief.\nBe kind.');
  });

  it('returns no tool choice when the request declares no tool config', () => {
    expect(toolChoiceFromConfig({})).toBeUndefined();
  });

  it('sends the tool choice the request asked for', () => {
    const body = buildResponsesCreateParams(
      userRequest({
        config: {
          toolConfig: {
            functionCallingConfig: {mode: FunctionCallingConfigMode.ANY},
          },
        },
      }),
      requestOptions(),
      false,
    );

    expect(body['tool_choice']).toBe('required');
  });
});

describe('Responses tool declarations', () => {
  it('rejects a function declaration with no name', () => {
    expect(() =>
      functionDeclarationToResponsesTool({description: 'x'}),
    ).toThrow('FunctionDeclaration must have a name.');
  });

  it('sends an empty object schema when the tool declares no parameters', () => {
    const tool = functionDeclarationToResponsesTool({name: 'ping'});

    expect(tool).toEqual({
      type: 'function',
      name: 'ping',
      description: '',
      parameters: {type: 'object', properties: {}},
      strict: false,
    });
  });

  it('ignores a parametersJsonSchema that is not an object', () => {
    const tool = functionDeclarationToResponsesTool({
      name: 'ping',
      parametersJsonSchema: 'nonsense',
      parameters: {type: Type.OBJECT, required: ['a']},
    });

    expect(tool.parameters).toEqual({type: 'object', required: ['a']});
  });

  it('does not deep-copy the caller schema into the request', () => {
    const parametersJsonSchema = {
      type: 'OBJECT',
      properties: {q: {type: 'STRING'}},
    };

    functionDeclarationToResponsesTool({name: 'search', parametersJsonSchema});

    expect(parametersJsonSchema.type).toBe('OBJECT');
  });
});

describe('Tool output serialization', () => {
  it.each([
    [undefined, ''],
    [null, ''],
    ['already text', 'already text'],
    [{content: 'plain'}, 'plain'],
    [{result: 'done'}, 'done'],
    [{result: {ok: true}}, '{"ok":true}'],
    [{result: null, other: 1}, '{"result":null,"other":1}'],
    [{content: []}, '{"content":[]}'],
    [{value: 7}, '{"value":7}'],
    [[1, 2], '[1,2]'],
  ])('serializes %j as %j', (value, expected) => {
    expect(serializeToolOutput(value)).toBe(expected);
  });

  it('flattens non-text and scalar entries of an MCP content array', () => {
    expect(
      serializeToolOutput({
        content: [{type: 'text', text: 'first'}, {type: 'image', url: 'x'}, 42],
      }),
    ).toBe('first\n{"type":"image","url":"x"}\n42');
  });
});

describe('Content mapping edge cases', () => {
  it('keeps a system role and wraps its text in a content block', () => {
    expect(
      contentToResponsesInputItems({role: 'system', parts: [{text: 'Rules'}]}),
    ).toEqual([
      {
        type: 'message',
        role: 'system',
        content: [{type: 'input_text', text: 'Rules'}],
      },
    ]);
  });

  it('maps an unknown role to user', () => {
    expect(
      contentToResponsesInputItems({role: 'tool', parts: [{text: 'out'}]}),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'out'}],
      },
    ]);
  });

  it('defaults the inline mime type and filename', () => {
    expect(
      contentToResponsesInputItems({
        role: 'user',
        parts: [{inlineData: {data: 'AAAA'}}],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: 'inline_data',
            file_data: 'data:application/octet-stream;base64,AAAA',
          },
        ],
      },
    ]);
  });

  it('emits a file_url for a file part with no mime type', () => {
    expect(
      contentToResponsesInputItems({
        role: 'user',
        parts: [{fileData: {fileUri: 'https://example.com/a.bin'}}],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_file', file_url: 'https://example.com/a.bin'}],
      },
    ]);
  });

  it('skips a part that carries nothing it can map', () => {
    expect(contentToResponsesInputItems({role: 'user', parts: [{}]})).toEqual(
      [],
    );
  });

  it('flushes the buffered message before a skipped thought', () => {
    expect(
      contentToResponsesInputItems({
        role: 'user',
        parts: [
          {text: 'question'},
          {text: 'reasoning', thought: true},
          {text: 'follow-up'},
        ],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'question'}],
      },
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'follow-up'}],
      },
    ]);
  });

  it('logs why a signed thought is dropped', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    contentToResponsesInputItems({
      role: 'model',
      parts: [{thought: true, thoughtSignature: 'c2ln'}, {thought: true}],
    });

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0]?.[0]).toContain('encrypted content');
  });

  it('logs why an unsigned replayed thought is dropped', () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    contentToResponsesInputItems({
      role: 'model',
      parts: [{thought: true, text: 'thinking'}],
    });

    expect(debugSpy.mock.calls[0]?.[0]).toContain('reasoning summary');
  });

  it('appends assistant code parts as their own message', () => {
    expect(
      contentToResponsesInputItems({
        role: 'model',
        parts: [{codeExecutionResult: {output: '2'}}],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'Execution Result:```code_output\n2\n```',
      },
    ]);
  });

  it('drops an assistant file part with a warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(
      contentToResponsesInputItems({
        role: 'model',
        parts: [{fileData: {fileUri: 'file-abc'}}],
      }),
    ).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('maps a content with no parts to no items', () => {
    expect(contentToResponsesInputItems({role: 'user'})).toEqual([]);
  });

  it('substitutes empty defaults for the inner fields a part omits', () => {
    expect(
      contentToResponsesInputItems({
        role: 'user',
        parts: [
          {inlineData: {mimeType: 'image/png'}},
          {fileData: {mimeType: 'application/pdf'}},
          {codeExecutionResult: {}},
          {functionCall: {id: 'call_1'}},
        ],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            detail: 'auto',
            image_url: 'data:image/png;base64,',
          },
          {type: 'input_file', file_url: ''},
          {
            type: 'input_text',
            text: 'Execution Result:```code_output\n\n```',
          },
        ],
      },
      {type: 'function_call', call_id: 'call_1', name: '', arguments: '{}'},
    ]);
  });
});

describe('Structured output', () => {
  it('asks for a bare json object when only the mime type is set', () => {
    expect(responseTextConfig({responseMimeType: 'application/json'})).toEqual({
      format: {type: 'json_object'},
    });
  });

  it('sends nothing when the request asks for no structured output', () => {
    expect(responseTextConfig({})).toBeUndefined();
  });

  it('ignores an empty schema', () => {
    expect(responseTextConfig({responseJsonSchema: {}})).toBeUndefined();
  });

  it('ignores a schema that is not an object', () => {
    expect(responseTextConfig({responseSchema: 'nonsense'})).toBeUndefined();
  });

  it('names a title-less schema "schema"', () => {
    const text = responseTextConfig({
      responseJsonSchema: {type: 'object', properties: {a: {type: 'STRING'}}},
    });

    expect(text).toEqual({
      format: {
        type: 'json_schema',
        name: 'schema',
        strict: true,
        schema: {
          type: 'object',
          properties: {a: {type: 'string'}},
          additionalProperties: false,
          required: ['a'],
        },
      },
    });
  });

  it('keeps the type of a responseSchema already written as JSON Schema', () => {
    // genaiSchemaToJsonSchema only knows the uppercase genai type names, so a
    // lowercase schema has to take the plain-JSON-Schema path or lose `type`.
    const text = responseTextConfig({
      responseSchema: {type: 'object', properties: {a: {type: 'string'}}},
    });

    expect(text).toEqual({
      format: {
        type: 'json_schema',
        name: 'schema',
        strict: true,
        schema: {
          type: 'object',
          properties: {a: {type: 'string'}},
          additionalProperties: false,
          required: ['a'],
        },
      },
    });
  });

  it('lowercases the type of a responseSchema in the genai dialect', () => {
    const text = responseTextConfig({
      responseSchema: {type: Type.OBJECT, properties: {a: {type: Type.STRING}}},
    });

    expect(text?.format).toMatchObject({
      schema: {
        type: 'object',
        properties: {a: {type: 'string'}},
        additionalProperties: false,
        required: ['a'],
      },
    });
  });

  it('renders a Zod responseSchema', () => {
    const text = responseTextConfig({
      responseSchema: z.object({answer: z.string()}),
    });

    expect(text?.format).toMatchObject({
      type: 'json_schema',
      strict: true,
      schema: {
        type: 'object',
        properties: {answer: {type: 'string'}},
        required: ['answer'],
      },
    });
  });

  it('does not mutate the caller schema', () => {
    const responseJsonSchema = {type: 'object', properties: {}};

    responseTextConfig({responseJsonSchema});

    expect(responseJsonSchema).toEqual({type: 'object', properties: {}});
  });
});

describe('enforceStrictOpenAiSchema', () => {
  it('strips every sibling of a $ref', () => {
    const schema = {$ref: '#/$defs/A', description: 'gone', title: 'gone'};

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({$ref: '#/$defs/A'});
  });

  it('recurses into oneOf and allOf members', () => {
    const schema = {
      oneOf: [{type: 'object', properties: {a: {type: 'string'}}}],
      allOf: [{type: 'object', properties: {b: {type: 'string'}}}],
    };

    enforceStrictOpenAiSchema(schema);

    expect(schema.oneOf[0]).toMatchObject({
      additionalProperties: false,
      required: ['a'],
    });
    expect(schema.allOf[0]).toMatchObject({
      additionalProperties: false,
      required: ['b'],
    });
  });

  it('leaves an object schema without properties alone', () => {
    const schema = {type: 'object'};

    enforceStrictOpenAiSchema(schema);

    expect(schema).toEqual({type: 'object'});
  });

  it('ignores a value that is not a schema object', () => {
    expect(() => enforceStrictOpenAiSchema('nonsense')).not.toThrow();
    expect(() => enforceStrictOpenAiSchema(undefined)).not.toThrow();
  });

  it('ignores a tuple-form items keyword', () => {
    const schema = {type: 'array', items: [{type: 'object'}]};

    enforceStrictOpenAiSchema(schema);

    expect(schema.items).toEqual([{type: 'object'}]);
  });
});

describe('lowercaseSchemaTypes', () => {
  it('lowercases a union type and recurses through every keyword form', () => {
    const schema = {
      type: ['STRING', 'NULL', 7],
      $defs: {A: {type: 'INTEGER'}},
      properties: {p: {type: 'BOOLEAN'}},
      items: {type: 'NUMBER'},
      anyOf: [{type: 'STRING'}],
      prefixItems: [{type: 'ARRAY'}],
      additionalProperties: {type: 'OBJECT'},
      default: {type: 'LEAVE_ME'},
    };

    lowercaseSchemaTypes(schema);

    expect(schema).toEqual({
      type: ['string', 'null', 7],
      $defs: {A: {type: 'integer'}},
      properties: {p: {type: 'boolean'}},
      items: {type: 'number'},
      anyOf: [{type: 'string'}],
      prefixItems: [{type: 'array'}],
      additionalProperties: {type: 'object'},
      default: {type: 'LEAVE_ME'},
    });
  });

  it('walks a list of schemas', () => {
    const schemas = [{type: 'STRING'}, {type: 'INTEGER'}];

    lowercaseSchemaTypes(schemas);

    expect(schemas).toEqual([{type: 'string'}, {type: 'integer'}]);
  });

  it('leaves a non-schema value alone', () => {
    expect(() => lowercaseSchemaTypes('nonsense')).not.toThrow();
  });

  it('leaves a non-string, non-list type alone', () => {
    const schema = {type: 7};

    lowercaseSchemaTypes(schema);

    expect(schema).toEqual({type: 7});
  });
});

describe('isRecord', () => {
  it.each([
    [{}, true],
    [{a: 1}, true],
    [[], false],
    [null, false],
    ['text', false],
    [undefined, false],
  ])('classifies %j as %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('Reasoning config', () => {
  it('states no preference when the request has no thinking config', () => {
    expect(openAiReasoningConfig({})).toBeUndefined();
  });
});

describe('Usage metadata', () => {
  it('reports nothing when the response carries no usage', () => {
    expect(toUsageMetadata(undefined)).toBeUndefined();
    expect(toUsageMetadata(null)).toBeUndefined();
  });

  it('sums the parts when the total is absent', () => {
    expect(toUsageMetadata({input_tokens: 4, output_tokens: 6})).toMatchObject({
      totalTokenCount: 10,
    });
  });

  it('leaves the total unset when a part is missing', () => {
    expect(toUsageMetadata({input_tokens: 4})).toMatchObject({
      totalTokenCount: undefined,
    });
  });
});

describe('Response parsing edge cases', () => {
  it('keeps an unrecognised output item under unmapped_output', () => {
    const llmResponse = responseToLlmResponse(
      {
        id: 'resp_1',
        status: 'completed',
        output: [{type: 'web_search_call', id: 'ws_1'}, {id: 'no_type_at_all'}],
      },
      {includeResponseMetadata: true},
    );

    const payload = llmResponse.customMetadata?.['openai_response'] as {
      output: unknown[];
      unmapped_output: unknown[];
    };
    expect(payload.unmapped_output).toEqual([
      {type: 'web_search_call', id: 'ws_1'},
      {id: 'no_type_at_all'},
    ]);
    expect(payload.output).toEqual([{type: 'web_search_call', id: 'ws_1'}]);
  });

  it('warns and emits an empty name for a nameless function call', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const llmResponse = responseToLlmResponse(
      {
        status: 'completed',
        output: [{type: 'function_call', id: 'fc_1', arguments: '{}'}],
      },
      {includeResponseMetadata: false},
    );

    expect(llmResponse.content?.parts?.[0]?.functionCall).toEqual({
      id: 'fc_1',
      name: '',
      args: {},
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'OpenAI Responses function call is missing a name.',
    );
  });

  it('falls back to the refusal text field', () => {
    const llmResponse = responseToLlmResponse(
      {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {type: 'refusal', text: 'No.'},
              {type: 'refusal'},
              {type: 'output_text'},
            ],
          },
        ],
      },
      {includeResponseMetadata: false},
    );

    expect(llmResponse.content?.parts).toEqual([{text: 'OpenAI refusal: No.'}]);
  });

  it('reports an unknown status as no finish reason', () => {
    const llmResponse = responseToLlmResponse(
      {status: 'in_progress', output: []},
      {includeResponseMetadata: false},
    );

    expect(llmResponse.finishReason).toBeUndefined();
    expect(llmResponse.errorCode).toBeUndefined();
  });

  it('maps a cancelled response to OTHER with no error payload', () => {
    const llmResponse = responseToLlmResponse(
      {status: 'cancelled', output: []},
      {includeResponseMetadata: false},
    );

    expect(llmResponse.finishReason).toBe(FinishReason.OTHER);
    expect(llmResponse.errorMessage).toBeUndefined();
  });

  it('maps an incomplete response with another reason to OTHER', () => {
    const llmResponse = responseToLlmResponse(
      {status: 'incomplete', incomplete_details: {reason: 'content_filter'}},
      {includeResponseMetadata: false},
    );

    expect(llmResponse.finishReason).toBe(FinishReason.OTHER);
  });

  it('reads reasoning content entries as well as summaries', () => {
    const llmResponse = responseToLlmResponse(
      {
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            summary: [{text: 'summary'}, {}],
            content: [{text: 'detail'}],
          },
        ],
      },
      {includeResponseMetadata: true},
    );

    expect(llmResponse.content?.parts).toEqual([
      {text: 'summary', thought: true, thoughtSignature: undefined},
      {text: 'detail', thought: true, thoughtSignature: undefined},
    ]);
    const payload = llmResponse.customMetadata?.['openai_response'] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('reasoning');
  });

  it('reads a payload whose optional fields are explicitly null', () => {
    const llmResponse = responseToLlmResponse(
      {
        id: null,
        model: null,
        status: 'completed',
        usage: null,
        output: [
          {type: 'reasoning', id: null, encrypted_content: null, summary: null},
          {type: 'message', content: null},
          {type: 'function_call', name: 'f', call_id: null, arguments: null},
        ],
      },
      {includeResponseMetadata: true},
    );

    expect(llmResponse.interactionId).toBeUndefined();
    expect(llmResponse.modelVersion).toBeUndefined();
    expect(llmResponse.usageMetadata).toBeUndefined();
    expect(llmResponse.content?.parts).toEqual([
      {functionCall: {id: undefined, name: 'f', args: {}}},
    ]);
  });
});

describe('Stream accumulator edge cases', () => {
  it('ignores an event kind it does not handle', () => {
    const accumulator = new ResponsesStreamAccumulator(true);

    expect(accumulator.processEvent({type: 'response.in_progress'})).toEqual(
      [],
    );
    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('reports the reasoning boundary with the indices the event carried', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_1',
            summary_index: 2,
            delta: 'Think',
          },
          {
            type: 'response.output_item.added',
            output_index: 4,
            item_id: 'msg_1',
            item: {type: 'message'},
          },
        ]),
        true,
      ),
    );

    expect(responses[1]?.customMetadata).toEqual({
      openai_response: {
        stream_event: {
          type: 'response.output_item.added',
          reasoning_done: true,
          output_index: 4,
          item_id: 'msg_1',
        },
      },
    });
  });

  it('keys an item by item_id when the event carries no output index', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {type: 'response.output_text.delta', item_id: 'msg_1', delta: 'a'},
          {type: 'response.output_text.delta', item_id: 'msg_1', delta: 'b'},
        ]),
        true,
      ),
    );

    expect(responses[responses.length - 1]?.content?.parts).toEqual([
      {text: 'ab'},
    ]);
  });

  it('replaces the accumulated text with the authoritative done text', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {type: 'response.output_text.delta', delta: 'partial'},
          {type: 'response.content_part.done', part: {text: 'whole'}},
        ]),
        true,
      ),
    );

    expect(responses[responses.length - 1]?.content?.parts).toEqual([
      {text: 'whole'},
    ]);
  });

  it('keeps the streamed name when the done item omits it', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            name: 'get_weather',
            call_id: 'call_1',
            delta: '{"a":1}',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {type: 'function_call'},
          },
        ]),
        true,
      ),
    );

    expect(
      responses[responses.length - 1]?.content?.parts?.[0]?.functionCall,
    ).toEqual({id: 'call_1', name: 'get_weather', args: {a: 1}});
  });

  it('keys a function call by its call id when no index is sent', () => {
    const accumulator = new ResponsesStreamAccumulator(true);

    accumulator.processEvent({
      type: 'response.function_call_arguments.done',
      call_id: 'call_orphan',
      name: 'f',
      arguments: '{"x":1}',
    });

    expect(
      accumulator.finalResponse()?.content?.parts?.[0]?.functionCall,
    ).toEqual({id: 'call_orphan', name: 'f', args: {x: 1}});
  });

  it('falls back to the default output key when nothing addresses the item', () => {
    const accumulator = new ResponsesStreamAccumulator(true);

    accumulator.processEvent({type: 'response.function_call_arguments.delta'});
    accumulator.processEvent({
      type: 'response.output_item.done',
      item: {type: 'function_call', id: 'fc_from_id'},
    });

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {functionCall: {id: 'fc_from_id', name: '', args: {}}},
    ]);
  });

  it('tolerates delta and done events that carry no payload', () => {
    const accumulator = new ResponsesStreamAccumulator(true);

    accumulator.processEvent({type: 'response.output_text.delta'});
    accumulator.processEvent({type: 'response.reasoning_summary_text.delta'});
    accumulator.processEvent({type: 'response.output_text.done'});
    accumulator.processEvent({type: 'response.reasoning_summary_text.done'});

    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('reads the reasoning done text from the part when the event omits it', () => {
    const accumulator = new ResponsesStreamAccumulator(true);

    accumulator.processEvent({
      type: 'response.reasoning_summary_part.done',
      output_index: 0,
      part: {text: 'from the part'},
    });

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {text: 'from the part', thought: true},
    ]);
  });

  it('keeps the streamed call id when the done item carries none', () => {
    const accumulator = new ResponsesStreamAccumulator(true);

    accumulator.processEvent({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      call_id: 'call_streamed',
      name: 'f',
      delta: '{"a":1}',
    });
    accumulator.processEvent({
      type: 'response.output_item.done',
      output_index: 0,
      item: {type: 'function_call'},
    });

    expect(
      accumulator.finalResponse()?.content?.parts?.[0]?.functionCall,
    ).toEqual({id: 'call_streamed', name: 'f', args: {a: 1}});
  });

  it('leaves the call id unset when no event carried one', () => {
    const accumulator = new ResponsesStreamAccumulator(true);

    accumulator.processEvent({
      type: 'response.output_item.done',
      item: {type: 'function_call', name: 'f', arguments: '{}'},
    });

    expect(accumulator.finalResponse()?.content?.parts).toEqual([
      {functionCall: {id: undefined, name: 'f', args: {}}},
    ]);
  });

  it('emits nothing for a reasoning item that accumulated no text', () => {
    const accumulator = new ResponsesStreamAccumulator(true);

    accumulator.processEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: {type: 'reasoning'},
    });

    expect(accumulator.finalResponse()).toBeUndefined();
  });

  it('reads a done reasoning item in preference to the streamed text', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {
            type: 'response.reasoning_summary_text.delta',
            output_index: 0,
            delta: 'streamed',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'reasoning',
              summary: [{text: 'authoritative'}],
              encrypted_content: 'sig',
            },
          },
        ]),
        true,
      ),
    );

    expect(responses[responses.length - 1]?.content?.parts).toEqual([
      {
        text: 'authoritative',
        thought: true,
        thoughtSignature: Buffer.from('sig', 'utf-8').toString('base64'),
      },
    ]);
  });

  it('falls back to the streamed text when the done item carries none', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {type: 'response.output_text.delta', output_index: 0, delta: 'kept'},
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {type: 'message', content: []},
          },
        ]),
        true,
      ),
    );

    expect(responses[responses.length - 1]?.content?.parts).toEqual([
      {text: 'kept'},
    ]);
  });

  it('emits no final response when the stream produced nothing', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {type: 'web_search_call'},
          },
        ]),
        true,
      ),
    );

    expect(responses).toEqual([]);
  });

  it('carries the usage of a completed stream into the final response', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              usage: {input_tokens: 2, output_tokens: 3, total_tokens: 5},
              output: [
                {type: 'message', content: [{type: 'output_text', text: 'x'}]},
              ],
            },
          },
        ]),
        true,
      ),
    );

    expect(responses[0]?.usageMetadata?.totalTokenCount).toBe(5);
  });

  it('suppresses the reasoning boundary when metadata is off', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {type: 'response.reasoning_summary_text.delta', delta: 'Think'},
          {type: 'response.reasoning_summary_text.done', text: 'Think'},
        ]),
        false,
      ),
    );

    expect(responses.map((response) => response.customMetadata)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('serializes a bare error event as the error message', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([{type: 'error', text: 'upstream failed'}]),
        true,
      ),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]?.errorMessage).toBe(
      '{"type":"error","text":"upstream failed"}',
    );
  });

  it('orders indexed text by index, not by arrival', async () => {
    const responses = await collect(
      streamResponses(
        fakeEventStream([
          {
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 1,
            delta: 'second',
          },
          {
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            delta: 'first ',
          },
        ]),
        true,
      ),
    );

    expect(responses[responses.length - 1]?.content?.parts).toEqual([
      {text: 'first second'},
    ]);
  });
});
