/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  Part,
  Type,
} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  appendFallbackUserContentIfMissing,
  buildRequestLog,
  contentToMessageParam,
  enforceStrictOpenAiSchema,
  ensureToolResults,
  functionDeclarationToToolParam,
  getCompletionInputs,
  getContent,
  isJsonObject,
  mergeReasoningTexts,
  partHasPayload,
  ProviderOptions,
  safeJsonSerialize,
  toJsonObject,
  toJsonValue,
  toLiteLlmResponseFormat,
  toLiteLlmRole,
} from '../../src/models/lite_llm_request_converters.js';
import {ChatMessage, JsonObject} from '../../src/models/lite_llm_types.js';
import {LlmRequest} from '../../src/models/llm_request.js';

const OPENAI: ProviderOptions = {provider: 'openai', model: 'openai/gpt-4o'};
const GROQ: ProviderOptions = {provider: 'groq', model: 'groq/llama3'};
const VERTEX_GEMINI: ProviderOptions = {
  provider: 'vertex_ai',
  model: 'vertex_ai/gemini-2.5-flash',
};

/** Encodes text the way `inlineData.data` carries it. */
function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Builds a request carrying only the fields these converters read. */
function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}, ...overrides};
}

/** Narrows a converted content to the single message it produced. */
function singleMessage(
  converted: ChatMessage | ChatMessage[] | undefined,
): ChatMessage {
  if (!converted || Array.isArray(converted)) {
    return expect.fail('expected exactly one message');
  }
  return converted;
}

describe('safeJsonSerialize', () => {
  it('serializes a plain value', () => {
    expect(safeJsonSerialize({a: 1})).toBe('{"a":1}');
  });

  it('falls back to the string form for a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(safeJsonSerialize(circular)).toBe('[object Object]');
  });

  it('falls back to the string form for a bigint', () => {
    expect(safeJsonSerialize(7n)).toBe('7');
  });

  it('falls back to the string form for undefined', () => {
    expect(safeJsonSerialize(undefined)).toBe('undefined');
  });
});

describe('toJsonValue', () => {
  it('copies nested structures', () => {
    expect(toJsonValue({a: [1, 'b', true], c: {d: null}})).toEqual({
      a: [1, 'b', true],
      c: {d: null},
    });
  });

  it('drops object fields JSON cannot represent', () => {
    expect(toJsonValue({a: undefined, b: () => 1, c: 1})).toEqual({c: 1});
    expect(toJsonValue(undefined)).toBeUndefined();
  });

  it('renders an unrepresentable array member as null', () => {
    expect(toJsonValue([undefined, 1])).toEqual([null, 1]);
  });

  it('rejects a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => toJsonValue(circular)).toThrow(TypeError);
  });

  it('recognises plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('a')).toBe(false);
  });
});

describe('partHasPayload', () => {
  it.each([
    [{text: 'hello'}, true],
    [{inlineData: {data: base64('x'), mimeType: 'text/plain'}}, true],
    [{fileData: {fileUri: 'gs://bucket/a.pdf'}}, true],
    [{functionResponse: {name: 'add', response: {result: 6}}}, true],
    [{inlineData: {mimeType: 'text/plain'}}, false],
    [{}, false],
  ])('classifies %j as %s', (part: Part, expected) => {
    expect(partHasPayload(part)).toBe(expected);
  });
});

describe('appendFallbackUserContentIfMissing', () => {
  it('leaves a user turn that already carries text', () => {
    const llmRequest = request({
      contents: [{role: 'user', parts: [{text: 'hi'}]}],
    });
    appendFallbackUserContentIfMissing(llmRequest);
    expect(llmRequest.contents).toHaveLength(1);
    expect(llmRequest.contents[0].parts).toHaveLength(1);
  });

  it('appends text to a user turn with no payload', () => {
    const llmRequest = request({contents: [{role: 'user', parts: []}]});
    appendFallbackUserContentIfMissing(llmRequest);
    expect(llmRequest.contents[0].parts?.[0].text).toBe(
      'Handle the requests as specified in the System Instruction.',
    );
  });

  it('appends text to a user turn with no parts array', () => {
    const llmRequest = request({contents: [{role: 'user'}]});
    appendFallbackUserContentIfMissing(llmRequest);
    expect(llmRequest.contents[0].parts).toHaveLength(1);
  });

  it('treats a function response as payload and leaves the turn alone', () => {
    const llmRequest = request({
      contents: [
        {
          role: 'user',
          parts: [{functionResponse: {name: 'add', response: {result: 6}}}],
        },
      ],
    });
    appendFallbackUserContentIfMissing(llmRequest);
    expect(llmRequest.contents).toHaveLength(1);
    expect(llmRequest.contents[0].parts).toHaveLength(1);
    expect(llmRequest.contents[0].parts?.[0].text).toBeUndefined();
  });

  it('appends a whole user turn when the history has none', () => {
    const llmRequest = request({
      contents: [{role: 'model', parts: [{text: 'hi'}]}],
    });
    appendFallbackUserContentIfMissing(llmRequest);
    expect(llmRequest.contents).toHaveLength(2);
    expect(llmRequest.contents[1].role).toBe('user');
  });
});

describe('mergeReasoningTexts', () => {
  it('joins fragments with no separator', () => {
    expect(mergeReasoningTexts([{text: 'ab'}, {text: 'cd'}])).toBe('abcd');
  });

  it('decodes inline text data', () => {
    expect(
      mergeReasoningTexts([
        {inlineData: {data: base64('note'), mimeType: 'text/plain'}},
      ]),
    ).toBe('note');
  });

  it('ignores parts carrying neither', () => {
    expect(
      mergeReasoningTexts([
        {inlineData: {data: base64('x'), mimeType: 'image/png'}},
        {},
      ]),
    ).toBe('');
  });
});

describe('toLiteLlmRole', () => {
  it.each([
    ['model', 'assistant'],
    ['assistant', 'assistant'],
    ['user', 'user'],
    [undefined, 'user'],
  ])('maps %s to %s', (role, expected) => {
    expect(toLiteLlmRole(role)).toBe(expected);
  });
});

describe('getContent', () => {
  it('returns a bare string for a single text part', () => {
    expect(getContent([{text: 'hello'}], GROQ)).toBe('hello');
  });

  it('decodes a single inline text part', () => {
    expect(
      getContent(
        [{inlineData: {data: base64('hello'), mimeType: 'text/plain'}}],
        GROQ,
      ),
    ).toBe('hello');
  });

  it('returns blocks when there is more than one part', () => {
    expect(
      getContent(
        [
          {text: 'look'},
          {inlineData: {data: 'AAA', mimeType: 'image/png'}},
          {inlineData: {data: base64('note'), mimeType: 'text/plain'}},
        ],
        GROQ,
      ),
    ).toEqual([
      {type: 'text', text: 'look'},
      {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
      {type: 'text', text: 'note'},
    ]);
  });

  it('sends audio as an input_audio block', () => {
    expect(
      getContent(
        [
          {inlineData: {data: 'AAA', mimeType: 'audio/mpeg'}},
          {text: 'transcribe'},
        ],
        GROQ,
      )[0],
    ).toEqual({type: 'input_audio', input_audio: {data: 'AAA', format: 'mp3'}});
  });

  it('sends video as a video_url block', () => {
    expect(
      getContent(
        [{inlineData: {data: 'AAA', mimeType: 'video/mp4'}}, {text: 'watch'}],
        GROQ,
      )[0],
    ).toEqual({
      type: 'video_url',
      video_url: {url: 'data:video/mp4;base64,AAA'},
    });
  });

  it('sends a document as an inline file block', () => {
    expect(
      getContent(
        [
          {inlineData: {data: 'AAA', mimeType: 'application/pdf'}},
          {text: 'read'},
        ],
        GROQ,
      )[0],
    ).toEqual({
      type: 'file',
      file: {file_data: 'data:application/pdf;base64,AAA'},
    });
  });

  it('rejects an unsupported inline MIME type', () => {
    expect(() =>
      getContent(
        [{inlineData: {data: 'AAA', mimeType: 'application/zip'}}, {text: 'x'}],
        GROQ,
      ),
    ).toThrow(
      'LiteLlm(BaseLlm) does not support content part with MIME type application/zip.',
    );
  });

  it('ignores a part carrying nothing', () => {
    expect(getContent([{}, {}], GROQ)).toEqual([]);
  });

  it('sends an uploaded file id straight through on openai', () => {
    expect(getContent([{fileData: {fileUri: 'file-abc'}}], OPENAI)).toEqual([
      {type: 'file', file: {file_id: 'file-abc'}},
    ]);
  });

  it('sends an http media url as a typed url block on openai', () => {
    expect(
      getContent([{fileData: {fileUri: 'https://example.com/a.png'}}], OPENAI),
    ).toEqual([
      {type: 'image_url', image_url: {url: 'https://example.com/a.png'}},
    ]);
    expect(
      getContent(
        [
          {
            fileData: {
              fileUri: 'https://example.com/a',
              mimeType: 'video/mp4',
            },
          },
        ],
        OPENAI,
      ),
    ).toEqual([{type: 'video_url', video_url: {url: 'https://example.com/a'}}]);
  });

  it('rejects a file uri the provider cannot resolve', () => {
    expect(() =>
      getContent([{fileData: {fileUri: 'https://example.com/a.pdf'}}], OPENAI),
    ).toThrow(
      'File URI `https://<redacted>/a.pdf` not supported for provider: openai.',
    );
  });

  it('sends a resolvable file uri as a file block', () => {
    expect(
      getContent(
        [
          {
            fileData: {
              fileUri: 'gs://bucket/report.pdf',
              mimeType: 'application/pdf',
            },
          },
        ],
        VERTEX_GEMINI,
      ),
    ).toEqual([
      {
        type: 'file',
        file: {file_id: 'gs://bucket/report.pdf', format: 'application/pdf'},
      },
    ]);
  });

  it('infers the MIME type from the uri', () => {
    expect(
      getContent(
        [{fileData: {fileUri: 'gs://bucket/report.pdf/versions/2'}}],
        VERTEX_GEMINI,
      )[0],
    ).toEqual({
      type: 'file',
      file: {
        file_id: 'gs://bucket/report.pdf/versions/2',
        format: 'application/pdf',
      },
    });
  });

  it('guesses the MIME type from the display name', () => {
    expect(
      getContent(
        [
          {
            fileData: {
              fileUri: 'gs://bucket/blob',
              displayName: 'report.pdf',
            },
          },
        ],
        VERTEX_GEMINI,
      )[0],
    ).toEqual({
      type: 'file',
      file: {file_id: 'gs://bucket/blob', format: 'application/pdf'},
    });
  });

  it('rejects a file uri with no resolvable MIME type', () => {
    expect(() =>
      getContent([{fileData: {fileUri: 'gs://bucket/blob'}}], VERTEX_GEMINI),
    ).toThrow("MIME type '(unknown)' is not supported");
  });

  it('rejects an explicit octet-stream MIME type', () => {
    expect(() =>
      getContent(
        [
          {
            fileData: {
              fileUri: 'gs://bucket/blob',
              mimeType: 'application/octet-stream',
            },
          },
        ],
        VERTEX_GEMINI,
      ),
    ).toThrow("MIME type 'application/octet-stream' is not supported");
  });
});

describe('contentToMessageParam', () => {
  it.each([[{role: 'user', parts: []}], [{role: 'user'}]])(
    'returns undefined for %j',
    (content: Content) => {
      expect(contentToMessageParam(content, GROQ)).toBeUndefined();
    },
  );

  it('sends null content for a user turn whose parts carry nothing', () => {
    expect(contentToMessageParam({role: 'user', parts: [{}]}, GROQ)).toEqual({
      role: 'user',
      content: null,
    });
  });

  it('converts a user turn', () => {
    expect(
      contentToMessageParam({role: 'user', parts: [{text: 'hi'}]}, GROQ),
    ).toEqual({role: 'user', content: 'hi'});
  });

  it('drops thought parts from a user turn', () => {
    expect(
      contentToMessageParam(
        {role: 'user', parts: [{text: 'secret', thought: true}, {text: 'hi'}]},
        GROQ,
      ),
    ).toEqual({role: 'user', content: 'hi'});
  });

  it('converts an assistant turn', () => {
    expect(
      contentToMessageParam({role: 'model', parts: [{text: 'hi'}]}, GROQ),
    ).toEqual({
      role: 'assistant',
      content: 'hi',
      tool_calls: undefined,
      reasoning_content: undefined,
    });
  });

  it('converts function calls into tool calls', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [{functionCall: {id: 'c1', name: 'add', args: {a: 1}}}],
        },
        GROQ,
      ),
    );
    expect(message.content).toBeNull();
    expect(message.tool_calls).toEqual([
      {
        type: 'function',
        id: 'c1',
        function: {name: 'add', arguments: '{"a":1}'},
      },
    ]);
  });

  it('rejects a function call with no name', () => {
    expect(() =>
      contentToMessageParam(
        {role: 'model', parts: [{functionCall: {id: 'c1', args: {}}}]},
        GROQ,
      ),
    ).toThrow('LiteLLM function calls require a name');
  });

  it('merges thought parts into reasoning_content with no separator', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: 'think', thought: true},
            {text: 'ing', thought: true},
            {text: 'answer'},
          ],
        },
        GROQ,
      ),
    );
    expect(message.reasoning_content).toBe('thinking');
    expect(message.content).toBe('answer');
  });

  it('collapses a lone text block to a bare string', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [{text: 'only'}, {}, {functionCall: {name: 'f'}}],
        },
        GROQ,
      ),
    );
    expect(message.content).toBe('only');
  });

  it('keeps every block when an assistant turn is multimodal', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: 'here'},
            {inlineData: {data: 'AAA', mimeType: 'image/png'}},
          ],
        },
        GROQ,
      ),
    );
    expect(message.content).toEqual([
      {type: 'text', text: 'here'},
      {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
    ]);
  });

  it('converts a function response into a tool message', () => {
    expect(
      contentToMessageParam(
        {
          role: 'user',
          parts: [
            {functionResponse: {id: 'c1', name: 'add', response: {result: 6}}},
          ],
        },
        GROQ,
      ),
    ).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"result":6}',
    });
  });

  it('converts several function responses into several tool messages', () => {
    const converted = contentToMessageParam(
      {
        role: 'user',
        parts: [
          {functionResponse: {id: 'c1', name: 'a', response: {}}},
          {functionResponse: {name: 'b', response: {}}},
        ],
      },
      GROQ,
    );
    expect(converted).toEqual([
      {role: 'tool', tool_call_id: 'c1', content: '{}'},
      {role: 'tool', tool_call_id: '', content: '{}'},
    ]);
  });

  it('follows a tool message with the media the tool attached', () => {
    const converted = contentToMessageParam(
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'c1',
              name: 'chart',
              response: {},
              parts: [
                {inlineData: {data: 'AAA', mimeType: 'image/png'}},
                {inlineData: {mimeType: 'image/png'}},
              ],
            },
          },
        ],
      },
      GROQ,
    );
    expect(converted).toEqual([
      {role: 'tool', tool_call_id: 'c1', content: '{}'},
      {
        role: 'user',
        content: [
          {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
        ],
      },
    ]);
  });

  it('follows tool messages with the remaining parts', () => {
    const converted = contentToMessageParam(
      {
        role: 'user',
        parts: [
          {functionResponse: {id: 'c1', name: 'a', response: {}}},
          {text: 'and then'},
        ],
      },
      GROQ,
    );
    expect(converted).toEqual([
      {role: 'tool', tool_call_id: 'c1', content: '{}'},
      {role: 'user', content: 'and then'},
    ]);
  });
});

describe('ensureToolResults', () => {
  const assistantCall: ChatMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [{type: 'function', id: 'c1', function: {name: 'add'}}],
  };

  it('leaves an answered tool call alone', () => {
    const messages: ChatMessage[] = [
      assistantCall,
      {role: 'tool', tool_call_id: 'c1', content: '6'},
    ];
    expect(ensureToolResults(messages)).toEqual(messages);
  });

  it('inserts a placeholder before the next non-tool message', () => {
    const healed = ensureToolResults([
      assistantCall,
      {role: 'user', content: 'next'},
    ]);
    expect(healed).toHaveLength(3);
    expect(healed[1]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content:
        'Error: Missing tool result (tool execution may have been interrupted before a response was recorded).',
    });
    expect(healed[2].role).toBe('user');
  });

  it('appends a placeholder when the history ends unanswered', () => {
    const healed = ensureToolResults([assistantCall]);
    expect(healed).toHaveLength(2);
    expect(healed[1].role).toBe('tool');
  });

  it('inserts a placeholder only for the unanswered call', () => {
    const healed = ensureToolResults([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {type: 'function', id: 'c1', function: {name: 'a'}},
          {type: 'function', id: 'c2', function: {name: 'b'}},
        ],
      },
      {role: 'tool', tool_call_id: 'c1', content: '1'},
    ]);
    expect(healed).toHaveLength(3);
    expect(healed[2].tool_call_id).toBe('c2');
  });

  it('leaves an assistant message with no tool calls alone', () => {
    const messages: ChatMessage[] = [{role: 'assistant', content: 'hi'}];
    expect(ensureToolResults(messages)).toEqual(messages);
  });

  it('ignores tool calls with no id', () => {
    const healed = ensureToolResults([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{type: 'function', function: {name: 'a'}}],
      },
    ]);
    expect(healed).toHaveLength(1);
  });

  it('returns an empty list unchanged', () => {
    expect(ensureToolResults([])).toEqual([]);
  });
});

describe('toJsonObject', () => {
  it('deep-copies an object into JSON', () => {
    const source = {a: [1, 'b'], c: {d: null}};
    const copy = toJsonObject(source);
    expect(copy).toEqual(source);
    expect(copy['c']).not.toBe(source.c);
  });

  it('drops values JSON cannot represent', () => {
    expect(toJsonObject({a: undefined, b: () => 1, c: 1})).toEqual({c: 1});
  });
});

describe('functionDeclarationToToolParam', () => {
  it('converts declared parameters and required fields', () => {
    const declaration: FunctionDeclaration = {
      name: 'add',
      description: 'Adds numbers.',
      parameters: {
        type: Type.OBJECT,
        properties: {a: {type: Type.INTEGER}},
        required: ['a'],
      },
    };
    expect(functionDeclarationToToolParam(declaration)).toEqual({
      type: 'function',
      function: {
        name: 'add',
        description: 'Adds numbers.',
        parameters: {
          type: 'object',
          properties: {a: {type: 'integer'}},
          required: ['a'],
        },
      },
    });
  });

  it('translates genai-only schema fields out of the genai dialect', () => {
    expect(
      functionDeclarationToToolParam({
        name: 'search',
        parameters: {
          type: Type.OBJECT,
          properties: {
            q: {type: Type.STRING, nullable: true},
            tags: {type: Type.ARRAY, items: {type: Type.STRING}, maxItems: '5'},
          },
          propertyOrdering: ['q', 'tags'],
        },
      }).function.parameters['properties'],
    ).toEqual({
      q: {type: ['string', 'null']},
      tags: {type: 'array', items: {type: 'string'}, maxItems: 5},
    });
  });

  it('falls back to a json schema when there are no properties', () => {
    expect(
      functionDeclarationToToolParam({
        name: 'add',
        parametersJsonSchema: {
          type: 'object',
          properties: {a: {type: 'integer'}},
        },
      }).function,
    ).toEqual({
      name: 'add',
      description: '',
      parameters: {type: 'object', properties: {a: {type: 'integer'}}},
    });
  });

  it('falls back to an empty object schema when there is neither', () => {
    expect(
      functionDeclarationToToolParam({name: 'ping'}).function.parameters,
    ).toEqual({type: 'object', properties: {}});
    expect(
      functionDeclarationToToolParam({name: 'ping', parametersJsonSchema: {}})
        .function.parameters,
    ).toEqual({type: 'object', properties: {}});
  });

  it('sends an empty name when the declaration has none', () => {
    expect(functionDeclarationToToolParam({}).function.name).toBe('');
  });

  it('omits an empty required list', () => {
    expect(
      functionDeclarationToToolParam({
        name: 'ping',
        parameters: {
          type: Type.OBJECT,
          properties: {a: {type: Type.STRING}},
          required: [],
        },
      }).function.parameters['required'],
    ).toBeUndefined();
  });
});

describe('enforceStrictOpenAiSchema', () => {
  it('forbids extra properties and requires every property', () => {
    const schema: JsonObject = {
      type: 'object',
      properties: {b: {type: 'string'}, a: {type: 'string'}},
    };
    enforceStrictOpenAiSchema(schema);
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual(['a', 'b']);
  });

  it('recurses into nested objects, arrays, combinators and $defs', () => {
    const schema: JsonObject = {
      type: 'object',
      properties: {
        nested: {type: 'object', properties: {x: {type: 'string'}}},
        list: {
          type: 'array',
          items: {type: 'object', properties: {y: {type: 'string'}}},
        },
        choice: {
          anyOf: [{type: 'object', properties: {z: {type: 'string'}}}],
          default: null,
        },
      },
      $defs: {
        Extra: {type: 'object', properties: {w: {type: 'string'}}},
      },
    };
    enforceStrictOpenAiSchema(schema);

    const properties = schema['properties'] as JsonObject;
    expect((properties['nested'] as JsonObject)['required']).toEqual(['x']);
    const list = properties['list'] as JsonObject;
    expect((list['items'] as JsonObject)['additionalProperties']).toBe(false);
    const choice = properties['choice'] as JsonObject;
    expect(choice['default']).toBeNull();
    expect((choice['anyOf'] as JsonObject[])[0]['required']).toEqual(['z']);
    expect(
      ((schema['$defs'] as JsonObject)['Extra'] as JsonObject)['required'],
    ).toEqual(['w']);
  });

  it('strips the siblings of a $ref', () => {
    const schema: JsonObject = {
      type: 'object',
      properties: {ref: {$ref: '#/$defs/Extra', description: 'dropped'}},
    };
    enforceStrictOpenAiSchema(schema);
    expect((schema['properties'] as JsonObject)['ref']).toEqual({
      $ref: '#/$defs/Extra',
    });
  });
});

describe('toLiteLlmResponseFormat', () => {
  it('passes a preformatted response format straight through', () => {
    for (const type of ['json_object', 'JSON_SCHEMA']) {
      expect(toLiteLlmResponseFormat({type}, 'openai/gpt-4o')).toEqual({type});
    }
  });

  it('wraps a schema for an openai-compatible model', () => {
    expect(
      toLiteLlmResponseFormat(
        {title: 'Answer', type: 'object', properties: {a: {type: 'string'}}},
        'openai/gpt-4o',
      ),
    ).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'Answer',
        strict: true,
        schema: {
          title: 'Answer',
          type: 'object',
          properties: {a: {type: 'string'}},
          additionalProperties: false,
          required: ['a'],
        },
      },
    });
  });

  it('translates a genai schema out of its dialect', () => {
    expect(
      toLiteLlmResponseFormat(
        {type: 'OBJECT', properties: {a: {type: 'STRING'}}},
        'openai/gpt-4o',
      ),
    ).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'response',
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

  it('defaults the schema name when the schema has no title', () => {
    const format = toLiteLlmResponseFormat({type: 'object'}, 'azure/gpt-4o');
    expect((format?.['json_schema'] as JsonObject)['name']).toBe('response');
  });

  it('uses the gemini response_schema shape', () => {
    expect(
      toLiteLlmResponseFormat({type: 'object'}, 'vertex_ai/gemini-2.5-flash'),
    ).toEqual({type: 'json_object', response_schema: {type: 'object'}});
  });

  it('never mutates the caller schema', () => {
    const schema = {type: 'object', properties: {a: {type: 'string'}}};
    toLiteLlmResponseFormat(schema, 'openai/gpt-4o');
    expect(schema).toEqual({type: 'object', properties: {a: {type: 'string'}}});
  });

  it('drops an unsupported schema', () => {
    expect(
      toLiteLlmResponseFormat('not a schema', 'openai/gpt-4o'),
    ).toBeUndefined();
  });
});

describe('getCompletionInputs', () => {
  it('prepends the system instruction', () => {
    const inputs = getCompletionInputs(
      request({
        contents: [{role: 'user', parts: [{text: 'hi'}]}],
        config: {systemInstruction: 'be nice'},
      }),
      'openai/gpt-4o',
    );
    expect(inputs.messages).toEqual([
      {role: 'system', content: 'be nice'},
      {role: 'user', content: 'hi'},
    ]);
  });

  it('flattens a content that became several messages', () => {
    const inputs = getCompletionInputs(
      request({
        contents: [
          {
            role: 'user',
            parts: [
              {functionResponse: {id: 'c1', name: 'a', response: {}}},
              {text: 'and'},
            ],
          },
        ],
      }),
      'openai/gpt-4o',
    );
    expect(inputs.messages.map((message) => message.role)).toEqual([
      'tool',
      'user',
    ]);
  });

  it('skips a content with no parts', () => {
    const inputs = getCompletionInputs(
      request({contents: [{role: 'user', parts: []}]}),
      'openai/gpt-4o',
    );
    expect(inputs.messages).toEqual([]);
  });

  it('heals a history that never answered a tool call', () => {
    const inputs = getCompletionInputs(
      request({
        contents: [
          {role: 'model', parts: [{functionCall: {id: 'c1', name: 'add'}}]},
        ],
      }),
      'openai/gpt-4o',
    );
    expect(inputs.messages).toHaveLength(2);
    expect(inputs.messages[1].role).toBe('tool');
  });

  it('converts function declarations and forwards native tools', () => {
    const inputs = getCompletionInputs(
      request({
        config: {
          tools: [
            {googleSearch: {}},
            {functionDeclarations: [{name: 'add'}, {name: 'sub'}]},
          ],
        },
      }),
      'openai/gpt-4o',
    );
    expect(inputs.tools).toHaveLength(3);
    expect(inputs.tools?.[0]).toEqual({googleSearch: {}});
    expect(inputs.tools?.[1]).toMatchObject({
      type: 'function',
      function: {name: 'add'},
    });
    expect(inputs.tools?.[2]).toMatchObject({function: {name: 'sub'}});
  });

  it('drops an empty tool and a callable tool', () => {
    const inputs = getCompletionInputs(
      request({
        config: {
          tools: [{}, {tool: async () => ({}), callTool: async () => []}],
        },
      }),
      'openai/gpt-4o',
    );
    expect(inputs.tools).toBeUndefined();
  });

  it('returns undefined tools when the request declares none', () => {
    expect(
      getCompletionInputs(request({config: {}}), 'openai/gpt-4o').tools,
    ).toBeUndefined();
  });

  it('maps the generation parameters onto their wire names', () => {
    const inputs = getCompletionInputs(
      request({
        config: {
          temperature: 0.2,
          maxOutputTokens: 128,
          topP: 0.9,
          topK: 5,
          stopSequences: ['END'],
          presencePenalty: 0.1,
          frequencyPenalty: 0.3,
        },
      }),
      'openai/gpt-4o',
    );
    expect(inputs.generationParams).toEqual({
      temperature: 0.2,
      max_completion_tokens: 128,
      top_p: 0.9,
      top_k: 5,
      stop: ['END'],
      presence_penalty: 0.1,
      frequency_penalty: 0.3,
    });
  });

  it('returns undefined generation parameters when none are set', () => {
    expect(
      getCompletionInputs(request({config: {}}), 'openai/gpt-4o')
        .generationParams,
    ).toBeUndefined();
    expect(
      getCompletionInputs(request(), 'openai/gpt-4o').generationParams,
    ).toBeUndefined();
  });

  it('maps the function calling mode onto tool_choice', () => {
    const withMode = (mode: FunctionCallingConfigMode) =>
      getCompletionInputs(
        request({
          config: {
            tools: [{functionDeclarations: [{name: 'add'}]}],
            toolConfig: {functionCallingConfig: {mode}},
          },
        }),
        'openai/gpt-4o',
      ).toolChoice;

    expect(withMode(FunctionCallingConfigMode.ANY)).toBe('required');
    expect(withMode(FunctionCallingConfigMode.NONE)).toBe('none');
    expect(withMode(FunctionCallingConfigMode.AUTO)).toBeUndefined();
  });

  it('drops tool_choice when the request declares no tools', () => {
    expect(
      getCompletionInputs(
        request({
          config: {
            toolConfig: {
              functionCallingConfig: {mode: FunctionCallingConfigMode.ANY},
            },
          },
        }),
        'openai/gpt-4o',
      ).toolChoice,
    ).toBeUndefined();
  });

  it('chooses the response format from the model it is given', () => {
    const withModel = (model: string) =>
      getCompletionInputs(
        request({config: {responseSchema: {type: 'object'}}}),
        model,
      ).responseFormat;

    expect(withModel('vertex_ai/gemini-2.5-flash')?.['type']).toBe(
      'json_object',
    );
    expect(withModel('openai/gpt-4o')?.['type']).toBe('json_schema');
  });

  it('leaves the response format unset when no schema is declared', () => {
    expect(
      getCompletionInputs(request({config: {}}), 'openai/gpt-4o')
        .responseFormat,
    ).toBeUndefined();
  });
});

describe('buildRequestLog', () => {
  it('redacts inline data and file uris', () => {
    const log = buildRequestLog(
      request({
        contents: [
          {
            role: 'user',
            parts: [
              {inlineData: {data: base64('secret'), mimeType: 'image/png'}},
              {
                fileData: {
                  fileUri: 'https://storage.example.com/b/report.pdf?sig=abc',
                },
              },
            ],
          },
        ],
        config: {systemInstruction: 'be nice'},
      }),
    );
    expect(log).toContain('be nice');
    expect(log).toContain('<redacted>');
    expect(log).not.toContain(base64('secret'));
    expect(log).not.toContain('sig=abc');
  });

  it('lists the declared functions', () => {
    const log = buildRequestLog(
      request({
        contents: [],
        config: {
          tools: [
            {googleSearch: {}},
            {
              functionDeclarations: [
                {
                  name: 'add',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {a: {type: Type.INTEGER}},
                  },
                  response: {type: Type.INTEGER},
                },
                {name: 'ping'},
              ],
            },
            {tool: async () => ({}), callTool: async () => []},
          ],
        },
      }),
    );
    expect(log).toContain(
      'add: {"a":{"type":"INTEGER"}} -> {"type":"INTEGER"}',
    );
    expect(log).toContain('ping: {} -> none');
  });
});
