/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, LlmRequest} from '@google/adk';
import {
  Content,
  FunctionCallingConfigMode,
  GenerateContentConfig,
  ThinkingLevel,
  Type,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  buildResponsesRequest,
  CallIdSanitizer,
  contentToResponseInputItems,
  functionDeclarationToResponseTool,
  loadJsonObject,
  lowercaseSchemaTypes,
  reasoningFromThinkingConfig,
  responseTextConfig,
  schemaToJsonObject,
  serializeJsonValue,
  serializeSystemInstruction,
  toolChoiceFromConfig,
} from '../../../src/models/openai/openai_responses_request.js';
import {JsonObject} from '../../../src/models/openai/openai_schema.js';

/** Builds an LlmRequest carrying the given contents. */
function llmRequest(
  contents: Content[],
  config?: GenerateContentConfig,
  extra: Partial<LlmRequest> = {},
): LlmRequest {
  return {contents, config, toolsDict: {}, liveConnectConfig: {}, ...extra};
}

/** Converts one content with a fresh sanitizer. */
function convert(content: Content) {
  return contentToResponseInputItems(content, new CallIdSanitizer());
}

describe('CallIdSanitizer', () => {
  it('passes a valid id through unchanged', () => {
    expect(new CallIdSanitizer().sanitize('call_abc-123')).toBe('call_abc-123');
  });

  it('maps one invalid id to the same fallback every time', () => {
    const sanitizer = new CallIdSanitizer();

    expect(sanitizer.sanitize('bad id!')).toBe('call_adk_fallback_0');
    expect(sanitizer.sanitize('bad id!')).toBe('call_adk_fallback_0');
  });

  it('mints a fresh fallback for each missing id', () => {
    const sanitizer = new CallIdSanitizer();

    expect(sanitizer.sanitize('bad id!')).toBe('call_adk_fallback_0');
    expect(sanitizer.sanitize(undefined)).toBe('call_adk_fallback_1');
    expect(sanitizer.sanitize('')).toBe('call_adk_fallback_2');
  });
});

describe('serializeSystemInstruction', () => {
  it('returns undefined when there is no instruction', () => {
    expect(serializeSystemInstruction(undefined)).toBeUndefined();
    expect(serializeSystemInstruction('')).toBeUndefined();
  });

  it('returns a string instruction unchanged', () => {
    expect(serializeSystemInstruction('Be brief.')).toBe('Be brief.');
  });

  it('joins the parts of a Content', () => {
    expect(
      serializeSystemInstruction({role: 'user', parts: [{text: 'a'}, {}]}),
    ).toBe('a');
  });

  it('reads the text of a single Part', () => {
    expect(serializeSystemInstruction({text: 'only'})).toBe('only');
  });

  it('joins a list of strings and parts', () => {
    expect(serializeSystemInstruction(['a', {text: 'b'}, {}])).toBe('ab');
  });

  it('returns undefined when the parts carry no text', () => {
    expect(serializeSystemInstruction({role: 'user', parts: [{}]})).toBe(
      undefined,
    );
  });

  it('returns undefined for a Content whose parts are unset', () => {
    expect(
      serializeSystemInstruction({role: 'user', parts: undefined}),
    ).toBeUndefined();
  });
});

describe('lowercaseSchemaTypes', () => {
  it('lowercases every nested type string', () => {
    const schema: JsonObject = {
      type: 'OBJECT',
      properties: {
        a: {type: 'STRING'},
        b: {type: 'ARRAY', items: {type: 'NUMBER'}},
      },
      anyOf: [{type: 'BOOLEAN'}],
    };

    lowercaseSchemaTypes(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        a: {type: 'string'},
        b: {type: 'array', items: {type: 'number'}},
      },
      anyOf: [{type: 'boolean'}],
    });
  });

  it('leaves a non-string type and a primitive alone', () => {
    const schema: JsonObject = {type: 7};

    lowercaseSchemaTypes(schema);
    lowercaseSchemaTypes('text');

    expect(schema).toEqual({type: 7});
  });
});

describe('schemaToJsonObject', () => {
  it('returns an empty object for a non-object schema', () => {
    expect(schemaToJsonObject(undefined)).toEqual({});
    expect(schemaToJsonObject('text')).toEqual({});
  });

  it('copies the schema instead of mutating the original', () => {
    const original = {type: 'OBJECT'};

    const copy = schemaToJsonObject(original);

    expect(copy).toEqual({type: 'object'});
    expect(original).toEqual({type: 'OBJECT'});
  });
});

describe('serializeJsonValue', () => {
  it('returns an empty string for a missing value', () => {
    expect(serializeJsonValue(undefined)).toBe('');
    expect(serializeJsonValue(null)).toBe('');
  });

  it('returns a string value unchanged', () => {
    expect(serializeJsonValue('done')).toBe('done');
  });

  it('flattens MCP-shaped text content', () => {
    expect(
      serializeJsonValue({
        content: [
          {type: 'text', text: 'first'},
          {type: 'text', text: 'second'},
        ],
      }),
    ).toBe('first\nsecond');
  });

  it('serializes a non-text content block and a non-object block', () => {
    expect(serializeJsonValue({content: [{type: 'image', url: 'u'}, 7]})).toBe(
      '{"type":"image","url":"u"}\n7',
    );
  });

  it('returns a string content value unchanged', () => {
    expect(serializeJsonValue({content: 'plain'})).toBe('plain');
  });

  it('unwraps a result field', () => {
    expect(serializeJsonValue({result: 'ok'})).toBe('ok');
    expect(serializeJsonValue({result: {a: 1}})).toBe('{"a":1}');
  });

  it('serializes anything else as JSON', () => {
    expect(serializeJsonValue({result: null, other: 1})).toBe(
      '{"result":null,"other":1}',
    );
    expect(serializeJsonValue({content: []})).toBe('{"content":[]}');
    expect(serializeJsonValue([1, 2])).toBe('[1,2]');
  });
});

describe('loadJsonObject', () => {
  it('parses a JSON object', () => {
    expect(loadJsonObject('{"a": 1}')).toEqual({a: 1});
  });

  it('returns an empty object for malformed JSON and warns', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});

    expect(loadJsonObject('not json')).toEqual({});

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('returns an empty object for a non-object JSON value', () => {
    expect(loadJsonObject('[1, 2]')).toEqual({});
  });

  it('returns an empty object for absent arguments', () => {
    expect(loadJsonObject('')).toEqual({});
    expect(loadJsonObject(undefined)).toEqual({});
  });
});

describe('contentToResponseInputItems', () => {
  it('keeps a model tool call and its text in order, skipping the thought', () => {
    const items = convert({
      role: 'model',
      parts: [
        {text: 'thinking', thought: true},
        {functionCall: {id: 'call_1', name: 'get_weather', args: {city: 'SF'}}},
        {text: 'Here you go.'},
      ],
    });

    expect(items).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"SF"}',
      },
      {type: 'message', role: 'assistant', content: 'Here you go.'},
    ]);
  });

  it('skips a thought part that only carries a signature', () => {
    expect(
      convert({
        role: 'model',
        parts: [{thought: true, thoughtSignature: 'sig'}],
      }),
    ).toEqual([]);
  });

  it('gives a call and its response the same sanitised id', () => {
    const sanitizer = new CallIdSanitizer();

    const call = contentToResponseInputItems(
      {role: 'model', parts: [{functionCall: {id: 'bad id', name: 'f'}}]},
      sanitizer,
    );
    const response = contentToResponseInputItems(
      {
        role: 'user',
        parts: [{functionResponse: {id: 'bad id', name: 'f', response: {}}}],
      },
      sanitizer,
    );

    expect(call[0]).toMatchObject({call_id: 'call_adk_fallback_0'});
    expect(response[0]).toMatchObject({call_id: 'call_adk_fallback_0'});
  });

  it('numbers each missing id separately within one request', () => {
    const sanitizer = new CallIdSanitizer();

    const items = contentToResponseInputItems(
      {
        role: 'model',
        parts: [{functionCall: {name: 'a'}}, {functionCall: {name: 'b'}}],
      },
      sanitizer,
    );

    expect(items).toMatchObject([
      {call_id: 'call_adk_fallback_0'},
      {call_id: 'call_adk_fallback_1'},
    ]);
  });

  it('serializes an MCP function response as text', () => {
    const items = convert({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call_1',
            name: 'f',
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
        call_id: 'call_1',
        output: 'first\nsecond',
      },
    ]);
  });

  it('maps image and file parts onto Responses content types', () => {
    const items = convert({
      role: 'user',
      parts: [
        {inlineData: {mimeType: 'image/png', data: 'YWJj'}},
        {inlineData: {data: 'ZGVm', displayName: 'notes.txt'}},
        {fileData: {mimeType: 'image/jpeg', fileUri: 'https://x/y.jpg'}},
        {fileData: {fileUri: 'file-abc'}},
        {fileData: {fileUri: 'https://x/y.pdf'}},
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
            image_url: 'data:image/png;base64,YWJj',
          },
          {
            type: 'input_file',
            filename: 'notes.txt',
            file_data: 'data:application/octet-stream;base64,ZGVm',
          },
          {type: 'input_image', detail: 'auto', image_url: 'https://x/y.jpg'},
          {type: 'input_file', file_id: 'file-abc'},
          {type: 'input_file', file_url: 'https://x/y.pdf'},
        ],
      },
    ]);
  });

  it('defaults the file url when the file data has no uri', () => {
    expect(convert({role: 'user', parts: [{fileData: {}}]})).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_file', file_url: ''}],
      },
    ]);
  });

  it('defaults a function call with no name and no arguments', () => {
    expect(
      convert({role: 'model', parts: [{functionCall: {id: 'call_1'}}]}),
    ).toEqual([
      {type: 'function_call', call_id: 'call_1', name: '', arguments: '{}'},
    ]);
  });

  it('defaults the inline file name and data when they are absent', () => {
    expect(convert({role: 'user', parts: [{inlineData: {}}]})).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: 'inline_data',
            file_data: 'data:application/octet-stream;base64,',
          },
        ],
      },
    ]);
  });

  it('drops assistant media and keeps the text around it', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});

    const items = convert({
      role: 'model',
      parts: [
        {text: 'before'},
        {inlineData: {mimeType: 'image/png', data: 'YWJj'}},
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

  it('renders code and execution results as text', () => {
    const items = convert({
      role: 'user',
      parts: [
        {executableCode: {code: 'print(1)'}},
        {codeExecutionResult: {output: '1'}},
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

  it('renders the fence even when the inner fields are missing', () => {
    const items = convert({
      role: 'model',
      parts: [{executableCode: {}}, {codeExecutionResult: {}}],
    });

    expect(items).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'Code:```python\n\n```',
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Execution Result:```code_output\n\n```',
      },
    ]);
  });

  it('maps a system role through unchanged and skips an empty part', () => {
    expect(convert({role: 'system', parts: [{text: 'rules'}, {}]})).toEqual([
      {
        type: 'message',
        role: 'system',
        content: [{type: 'input_text', text: 'rules'}],
      },
    ]);
  });

  it('maps a developer role through and an unknown role to user', () => {
    expect(convert({role: 'developer', parts: [{text: 'x'}]})).toMatchObject([
      {role: 'developer'},
    ]);
    expect(convert({role: 'tool', parts: [{text: 'x'}]})).toMatchObject([
      {role: 'user'},
    ]);
    expect(convert({parts: [{text: 'x'}]})).toMatchObject([{role: 'user'}]);
  });

  it('returns nothing for a content without parts', () => {
    expect(convert({role: 'user'})).toEqual([]);
  });
});

describe('functionDeclarationToResponseTool', () => {
  it('lowercases the parameter types and never asks for strict mode', () => {
    const tool = functionDeclarationToResponseTool({
      name: 'get_weather',
      description: 'Look up the weather.',
      parameters: {
        type: Type.OBJECT,
        properties: {city: {type: Type.STRING}},
        required: ['city'],
      },
    });

    expect(tool).toEqual({
      type: 'function',
      name: 'get_weather',
      description: 'Look up the weather.',
      strict: false,
      parameters: {
        type: 'object',
        properties: {city: {type: 'string'}},
        required: ['city'],
      },
    });
  });

  it('prefers a JSON schema and defaults the description', () => {
    const tool = functionDeclarationToResponseTool({
      name: 'f',
      parametersJsonSchema: {type: 'OBJECT', properties: {}},
      parameters: {type: Type.OBJECT, properties: {ignored: {}}},
    });

    expect(tool.description).toBe('');
    expect(tool.parameters).toEqual({type: 'object', properties: {}});
  });

  it('falls back to an empty object schema', () => {
    expect(functionDeclarationToResponseTool({name: 'f'}).parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('throws when the declaration has no name', () => {
    expect(() => functionDeclarationToResponseTool({})).toThrow(
      'FunctionDeclaration must have a name.',
    );
  });
});

describe('responseTextConfig', () => {
  it('builds a strict json_schema format from a response schema', () => {
    const config = responseTextConfig({
      responseSchema: {
        title: 'Answer',
        type: Type.OBJECT,
        properties: {b: {type: Type.STRING}, a: {type: Type.STRING}},
      },
    });

    expect(config).toEqual({
      format: {
        type: 'json_schema',
        name: 'Answer',
        strict: true,
        schema: {
          title: 'Answer',
          type: 'object',
          properties: {b: {type: 'string'}, a: {type: 'string'}},
          additionalProperties: false,
          required: ['a', 'b'],
        },
      },
    });
  });

  it('sanitises a schema title into a legal format name', () => {
    const config = responseTextConfig({
      responseSchema: {title: 'My Schema!', type: Type.OBJECT, properties: {}},
    });

    expect(config?.format).toMatchObject({name: 'My_Schema_'});
  });

  it('falls back to the literal schema name when there is no title', () => {
    const config = responseTextConfig({
      responseJsonSchema: {type: 'object', properties: {}},
    });

    expect(config?.format).toMatchObject({name: 'schema'});
  });

  it('returns undefined for a schema that carries nothing', () => {
    expect(responseTextConfig({responseSchema: {}})).toBeUndefined();
  });

  it('asks for a json_object when only the mime type is set', () => {
    expect(responseTextConfig({responseMimeType: 'application/json'})).toEqual({
      format: {type: 'json_object'},
    });
  });

  it('returns undefined when nothing structured was requested', () => {
    expect(responseTextConfig({})).toBeUndefined();
    expect(
      responseTextConfig({responseMimeType: 'text/plain'}),
    ).toBeUndefined();
  });
});

describe('reasoningFromThinkingConfig', () => {
  it('returns undefined when no thinking config was given', () => {
    expect(reasoningFromThinkingConfig({})).toBeUndefined();
  });

  it.each([
    [ThinkingLevel.MINIMAL, 'minimal'],
    [ThinkingLevel.LOW, 'low'],
    [ThinkingLevel.MEDIUM, 'medium'],
    [ThinkingLevel.HIGH, 'high'],
    [ThinkingLevel.THINKING_LEVEL_UNSPECIFIED, 'medium'],
  ])('maps thinking level %s to effort %s', (level, effort) => {
    expect(
      reasoningFromThinkingConfig({thinkingConfig: {thinkingLevel: level}}),
    ).toEqual({effort, summary: 'concise'});
  });

  it('lets the level win over the budget', () => {
    expect(
      reasoningFromThinkingConfig({
        thinkingConfig: {thinkingLevel: ThinkingLevel.HIGH, thinkingBudget: 0},
      }),
    ).toEqual({effort: 'high', summary: 'concise'});
  });

  it('maps a zero budget to minimal effort', () => {
    expect(
      reasoningFromThinkingConfig({thinkingConfig: {thinkingBudget: 0}}),
    ).toEqual({effort: 'minimal', summary: 'concise'});
  });

  it.each([1024, -1])('maps budget %s to medium effort', (budget) => {
    expect(
      reasoningFromThinkingConfig({thinkingConfig: {thinkingBudget: budget}}),
    ).toEqual({effort: 'medium', summary: 'concise'});
  });

  it('throws when neither a level nor a budget was set', () => {
    expect(() => reasoningFromThinkingConfig({thinkingConfig: {}})).toThrow(
      /thinking_budget must be set explicitly/,
    );
  });
});

describe('toolChoiceFromConfig', () => {
  it.each([
    [FunctionCallingConfigMode.ANY, 'required'],
    [FunctionCallingConfigMode.NONE, 'none'],
    [FunctionCallingConfigMode.AUTO, 'auto'],
  ])('maps mode %s to %s', (mode, expected) => {
    expect(
      toolChoiceFromConfig({toolConfig: {functionCallingConfig: {mode}}}),
    ).toBe(expected);
  });

  it('returns undefined without a function calling config', () => {
    expect(toolChoiceFromConfig({})).toBeUndefined();
    expect(toolChoiceFromConfig({toolConfig: {}})).toBeUndefined();
    expect(
      toolChoiceFromConfig({
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.MODE_UNSPECIFIED,
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe('buildResponsesRequest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the Responses body from the request and the model options', () => {
    const body = buildResponsesRequest(
      llmRequest(
        [{role: 'user', parts: [{text: 'Hi'}]}],
        {
          systemInstruction: 'Be brief.',
          temperature: 0.25,
          topP: 0.9,
          maxOutputTokens: 128,
          stopSequences: ['STOP'],
          thinkingConfig: {thinkingLevel: ThinkingLevel.LOW},
          tools: [
            {
              functionDeclarations: [
                {name: 'f', parameters: {type: Type.OBJECT, properties: {}}},
              ],
            },
          ],
          toolConfig: {
            functionCallingConfig: {mode: FunctionCallingConfigMode.ANY},
          },
        },
        {model: 'gpt-5-mini', previousInteractionId: 'resp_prev'},
      ),
      {
        model: 'gpt-5',
        stream: true,
        store: false,
        include: ['reasoning.encrypted_content'],
        parallelToolCalls: true,
        truncation: 'auto',
        serviceTier: 'flex',
      },
    );

    expect(body).toEqual({
      model: 'gpt-5-mini',
      stream: true,
      instructions: 'Be brief.',
      previous_response_id: 'resp_prev',
      temperature: 0.25,
      top_p: 0.9,
      max_output_tokens: 128,
      stop: ['STOP'],
      reasoning: {effort: 'low', summary: 'concise'},
      tool_choice: 'required',
      store: false,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
      truncation: 'auto',
      service_tier: 'flex',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{type: 'input_text', text: 'Hi'}],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'f',
          description: '',
          strict: false,
          parameters: {type: 'object', properties: {}},
        },
      ],
    });
  });

  it('drops every key the request left unset', () => {
    const body = buildResponsesRequest(llmRequest([]), {
      model: 'gpt-5',
      stream: false,
    });

    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'stream']);
    expect(body).toEqual({model: 'gpt-5', stream: false, input: []});
  });

  it('leaves an empty stop sequence list out of the body', () => {
    const body = buildResponsesRequest(llmRequest([], {stopSequences: []}), {
      model: 'gpt-5',
      stream: false,
    });

    expect(body.stop).toBeUndefined();
  });

  it('uses the model-level reasoning when the request sets no thinking', () => {
    const body = buildResponsesRequest(llmRequest([]), {
      model: 'gpt-5',
      stream: false,
      reasoning: {effort: 'high'},
    });

    expect(body.reasoning).toEqual({effort: 'high'});
  });

  it('lets the request thinking config win over the model reasoning', () => {
    const body = buildResponsesRequest(
      llmRequest([], {thinkingConfig: {thinkingBudget: 0}}),
      {model: 'gpt-5', stream: false, reasoning: {effort: 'high'}},
    );

    expect(body.reasoning).toEqual({effort: 'minimal', summary: 'concise'});
  });

  it('lets extraRequestArgs override a computed key', () => {
    const body = buildResponsesRequest(llmRequest([], {temperature: 0.1}), {
      model: 'gpt-5',
      stream: false,
      extraRequestArgs: {temperature: 0.9, user: 'tester'},
    });

    expect(body.temperature).toBe(0.9);
    expect(body.user).toBe('tester');
  });

  it('shares one call-id sanitizer across every content in the request', () => {
    const body = buildResponsesRequest(
      llmRequest([
        {role: 'model', parts: [{functionCall: {id: 'bad id', name: 'f'}}]},
        {
          role: 'user',
          parts: [{functionResponse: {id: 'bad id', name: 'f', response: {}}}],
        },
      ]),
      {model: 'gpt-5', stream: false},
    );

    expect(body.input).toMatchObject([
      {call_id: 'call_adk_fallback_0'},
      {call_id: 'call_adk_fallback_0'},
    ]);
  });

  it('ignores a tool that declares no functions', () => {
    const body = buildResponsesRequest(
      llmRequest([], {
        tools: [
          {googleSearch: {}},
          {functionDeclarations: []},
          {functionDeclarations: undefined},
        ],
      }),
      {model: 'gpt-5', stream: false},
    );

    expect(body.tools).toBeUndefined();
  });
});
