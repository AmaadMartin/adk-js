/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Tool} from '@anthropic-ai/sdk/resources/messages';
import type {Content, FunctionDeclaration, Part} from '@google/genai';
import {Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  buildThinkingParam,
  contentBlockToPart,
  contentToMessageParam,
  functionDeclarationToToolParam,
  inlineMediaKind,
  messageToLlmResponse,
  parseToolUseArgs,
  partToMessageBlock,
  systemInstructionToText,
  toClaudeRole,
  ToolUseIdSanitizer,
} from '../../src/models/anthropic_utils.js';
import {logger} from '../../src/utils/logger.js';

import {anthropicMessage, anthropicUsage} from './anthropic_test_utils.js';

function block(part: Part) {
  return partToMessageBlock(part, new ToolUseIdSanitizer());
}

function functionResponsePart(
  id: string | undefined,
  response: Record<string, unknown>,
): Part {
  return {functionResponse: {id, name: 'some_tool', response}};
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toClaudeRole', () => {
  it.each([
    ['model', 'assistant'],
    ['assistant', 'assistant'],
    ['user', 'user'],
    ['tool', 'user'],
  ])('maps %s to %s', (role, expected) => {
    expect(toClaudeRole(role)).toBe(expected);
  });

  it('maps a missing role to user', () => {
    expect(toClaudeRole()).toBe('user');
  });
});

describe('inlineMediaKind', () => {
  it.each<[string, Part, 'image' | 'pdf' | undefined]>([
    [
      'an image part',
      {inlineData: {mimeType: 'image/png', data: 'x'}},
      'image',
    ],
    [
      'a PDF part with MIME type parameters',
      {inlineData: {mimeType: 'application/pdf; name=d.pdf'}},
      'pdf',
    ],
    ['an audio part', {inlineData: {mimeType: 'audio/mpeg'}}, undefined],
    ['a part with no inline data', {text: 'hi'}, undefined],
  ])('classifies %s', (_name, part, expected) => {
    expect(inlineMediaKind(part)).toBe(expected);
  });
});

describe('ToolUseIdSanitizer', () => {
  it('returns a valid id unchanged', () => {
    expect(new ToolUseIdSanitizer().sanitize('toolu_01abc')).toBe(
      'toolu_01abc',
    );
  });

  it('returns an ADK-minted adk-<uuid> id unchanged', () => {
    const id = 'adk-12345678-1234-1234-1234-123456789012';
    expect(new ToolUseIdSanitizer().sanitize(id)).toBe(id);
  });

  it.each([undefined, '', 'invalid id with spaces!'])(
    'replaces the rejected id %s',
    (id) => {
      const sanitized = new ToolUseIdSanitizer().sanitize(id);
      expect(sanitized).toMatch(/^toolu_/);
      expect(sanitized).toMatch(/^[a-zA-Z0-9_-]+$/);
    },
  );

  it('maps undefined and the empty string to the same fallback', () => {
    const sanitizer = new ToolUseIdSanitizer();
    expect(sanitizer.sanitize(undefined)).toBe(sanitizer.sanitize(''));
  });

  it('maps two distinct rejected ids to distinct fallbacks', () => {
    const sanitizer = new ToolUseIdSanitizer();
    expect(sanitizer.sanitize('bad A!')).not.toBe(sanitizer.sanitize('bad B!'));
  });

  it('maps the same rejected id to the same fallback', () => {
    const sanitizer = new ToolUseIdSanitizer();
    expect(sanitizer.sanitize('bad!')).toBe(sanitizer.sanitize('bad!'));
  });
});

describe('partToMessageBlock function responses', () => {
  it('extracts a single text item from a content array', () => {
    const json = '{"name":"root","node_type":"folder","children":[]}';
    expect(
      block(
        functionResponsePart('test_id_123', {
          content: [{type: 'text', text: json}],
        }),
      ),
    ).toEqual({
      type: 'tool_result',
      tool_use_id: 'test_id_123',
      content: json,
      is_error: false,
    });
  });

  it('joins multiple content items with a newline', () => {
    const result = block(
      functionResponsePart('id', {
        content: [
          {type: 'text', text: 'First part'},
          {type: 'text', text: 'Second part'},
        ],
      }),
    );
    expect(result).toMatchObject({content: 'First part\nSecond part'});
  });

  it('serialises a non-text content item as JSON', () => {
    const result = block(
      functionResponsePart('id', {content: [{type: 'image', url: 'u'}, 7]}),
    );
    expect(result).toMatchObject({content: '{"type":"image","url":"u"}\n7'});
  });

  it('passes a string content value through', () => {
    const result = block(functionResponsePart('id', {content: 'Hello'}));
    expect(result).toMatchObject({content: 'Hello'});
  });

  it('falls through to the whole-response dump for an empty content string', () => {
    const result = block(
      functionResponsePart('id', {content: '', extra: 'keep me'}),
    );
    expect(result).toMatchObject({
      content: '{"content":"","extra":"keep me"}',
    });
  });

  it('passes a string result through', () => {
    const result = block(functionResponsePart('id', {result: 'plain text'}));
    expect(result).toMatchObject({content: 'plain text'});
  });

  it('serialises an object result as JSON, not as a JavaScript string', () => {
    const result = block(
      functionResponsePart('id', {
        result: {topic: 'travel', active: true, count: null},
      }),
    );
    expect(result).toMatchObject({
      content: '{"topic":"travel","active":true,"count":null}',
    });
  });

  it('serialises an array result as JSON', () => {
    const result = block(
      functionResponsePart('id', {result: ['item1', 'item2']}),
    );
    expect(result).toMatchObject({content: '["item1","item2"]'});
  });

  it.each([
    [{}, '{}'],
    [[], '[]'],
  ])('keeps an empty %s result', (result, expected) => {
    expect(block(functionResponsePart('id', {result}))).toMatchObject({
      content: expected,
    });
  });

  it('serialises a numeric result with String', () => {
    expect(block(functionResponsePart('id', {result: 42}))).toMatchObject({
      content: '42',
    });
  });

  it('dumps a response with arbitrary keys', () => {
    const result = block(
      functionResponsePart('id', {
        error: "Skill 'missing' not found.",
        error_code: 'SKILL_NOT_FOUND',
      }),
    );
    expect(result).toMatchObject({
      content:
        '{"error":"Skill \'missing\' not found.","error_code":"SKILL_NOT_FOUND"}',
    });
  });

  it('produces empty content for an empty response', () => {
    expect(block(functionResponsePart('id', {}))).toMatchObject({content: ''});
  });

  it('produces empty content for a missing response', () => {
    expect(
      block({functionResponse: {id: 'id', name: 'some_tool'}}),
    ).toMatchObject({content: ''});
  });

  it('keeps a null result out of the result branch', () => {
    expect(
      block(functionResponsePart('id', {result: null, extra: 1})),
    ).toMatchObject({content: '{"result":null,"extra":1}'});
  });
});

describe('partToMessageBlock media', () => {
  it('converts a PDF part without re-encoding the data', () => {
    const data = 'JVBERi0xLjQgZmFrZQ==';
    expect(block({inlineData: {mimeType: 'application/pdf', data}})).toEqual({
      type: 'document',
      source: {type: 'base64', media_type: 'application/pdf', data},
    });
  });

  it('drops MIME type parameters from a PDF media type', () => {
    const data = 'JVBERi0xLjQgZmFrZQ==';
    expect(
      block({inlineData: {mimeType: 'application/pdf; name=doc.pdf', data}}),
    ).toEqual({
      type: 'document',
      source: {type: 'base64', media_type: 'application/pdf', data},
    });
  });

  it('converts an image part without re-encoding the data', () => {
    const data = 'aW1hZ2VieXRlcw==';
    expect(block({inlineData: {mimeType: 'image/jpeg', data}})).toEqual({
      type: 'image',
      source: {type: 'base64', media_type: 'image/jpeg', data},
    });
  });

  it('rejects an image media type Claude does not accept', () => {
    expect(() =>
      block({inlineData: {mimeType: 'image/svg+xml', data: 'x'}}),
    ).toThrow(/image\/svg\+xml/);
  });

  it('rejects an inline media type that is neither an image nor a PDF', () => {
    expect(() =>
      block({inlineData: {mimeType: 'audio/mpeg', data: 'YXVkaW8='}}),
    ).toThrow(/does not support this part/);
  });

  it('rejects an inline part that carries no data', () => {
    expect(() => block({inlineData: {mimeType: 'image/png'}})).toThrow(
      /does not support this part/,
    );
  });
});

describe('partToMessageBlock text, thinking and code', () => {
  it('converts a plain text part', () => {
    expect(block({text: 'hello'})).toEqual({type: 'text', text: 'hello'});
  });

  it('converts a thinking part with its signature', () => {
    expect(
      block({
        text: 'My reasoning steps.',
        thought: true,
        thoughtSignature: 'roundtrip_sig',
      }),
    ).toEqual({
      type: 'thinking',
      thinking: 'My reasoning steps.',
      signature: 'roundtrip_sig',
    });
  });

  it('defaults a thinking part with no signature to an empty signature', () => {
    expect(block({text: 'reasoning', thought: true})).toEqual({
      type: 'thinking',
      thinking: 'reasoning',
      signature: '',
    });
  });

  it('converts a redacted thinking part', () => {
    expect(block({thought: true, thoughtSignature: 'encrypted_blob'})).toEqual({
      type: 'redacted_thinking',
      data: 'encrypted_blob',
    });
  });

  it('converts a function call part', () => {
    expect(
      block({functionCall: {id: 'toolu_1', name: 't', args: {a: 1}}}),
    ).toEqual({type: 'tool_use', id: 'toolu_1', name: 't', input: {a: 1}});
  });

  it('defaults missing function call args to an empty object', () => {
    expect(block({functionCall: {id: 'toolu_1', name: 't'}})).toMatchObject({
      input: {},
    });
  });

  it('rejects a function call with no name', () => {
    expect(() => block({functionCall: {id: 'toolu_1'}})).toThrow(
      /function call sent to Claude must have a name/,
    );
  });

  it('converts an executable code part', () => {
    expect(block({executableCode: {code: 'print(1)'}})).toEqual({
      type: 'text',
      text: 'Code:```python\nprint(1)\n```',
    });
  });

  it('converts a code execution result part', () => {
    expect(block({codeExecutionResult: {output: '1'}})).toEqual({
      type: 'text',
      text: 'Execution Result:```code_output\n1\n```',
    });
  });

  it('rejects a part with no recognised content', () => {
    expect(() => block({videoMetadata: {fps: 1}})).toThrow(
      /does not support this part/,
    );
  });
});

describe('contentToMessageParam', () => {
  const imagePart: Part = {
    inlineData: {mimeType: 'image/png', data: 'aW1n'},
  };
  const pdfPart: Part = {
    inlineData: {mimeType: 'application/pdf', data: 'cGRm'},
  };

  it.each([
    ['user', imagePart, 'user', 2, undefined],
    [
      'model',
      imagePart,
      'assistant',
      1,
      'Image data is not supported in Claude for assistant turns.',
    ],
    [
      'assistant',
      imagePart,
      'assistant',
      1,
      'Image data is not supported in Claude for assistant turns.',
    ],
    ['user', pdfPart, 'user', 2, undefined],
    [
      'model',
      pdfPart,
      'assistant',
      1,
      'PDF data is not supported in Claude for assistant turns.',
    ],
  ])(
    'a %s turn with media yields %s and %i blocks',
    (role, mediaPart, expectedRole, expectedBlocks, expectedWarning) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const content: Content = {role, parts: [{text: 'hi'}, mediaPart]};

      const result = contentToMessageParam(content, new ToolUseIdSanitizer());

      expect(result.role).toBe(expectedRole);
      expect(result.content).toHaveLength(expectedBlocks);
      if (expectedWarning) {
        expect(warn).toHaveBeenCalledExactlyOnceWith(expectedWarning);
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  it('handles a content with no parts', () => {
    expect(
      contentToMessageParam({role: 'user'}, new ToolUseIdSanitizer()),
    ).toEqual({role: 'user', content: []});
  });
});

describe('contentBlockToPart', () => {
  it('converts a thinking block', () => {
    expect(
      contentBlockToPart({
        type: 'thinking',
        thinking: 'Let me reason about this.',
        signature: 'sig_abc123',
      }),
    ).toEqual({
      text: 'Let me reason about this.',
      thought: true,
      thoughtSignature: 'sig_abc123',
    });
  });

  it('omits an empty thinking signature', () => {
    expect(
      contentBlockToPart({type: 'thinking', thinking: 'hm', signature: ''}),
    ).toEqual({text: 'hm', thought: true});
  });

  it('converts a redacted thinking block without text', () => {
    const part = contentBlockToPart({
      type: 'redacted_thinking',
      data: 'redacted_data',
    });
    expect(part).toEqual({thought: true, thoughtSignature: 'redacted_data'});
    expect(part.text).toBeUndefined();
  });

  it('converts a text block', () => {
    expect(
      contentBlockToPart({type: 'text', text: 'Hi there', citations: null}),
    ).toEqual({text: 'Hi there'});
  });

  it('converts a tool_use block', () => {
    expect(
      contentBlockToPart({
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'get_weather',
        input: {city: 'Paris'},
        caller: {type: 'direct'},
      }),
    ).toEqual({
      functionCall: {
        id: 'toolu_abc',
        name: 'get_weather',
        args: {city: 'Paris'},
      },
    });
  });

  it('rejects a tool_use block whose input is not an object', () => {
    expect(() =>
      contentBlockToPart({
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'get_weather',
        input: 'not-an-object',
        caller: {type: 'direct'},
      }),
    ).toThrow(/is not an object/);
  });

  it('rejects an unsupported block type', () => {
    expect(() =>
      contentBlockToPart({
        type: 'container_upload',
        file_id: 'f',
      }),
    ).toThrow(/Unsupported Claude content block type: container_upload/);
  });
});

describe('parseToolUseArgs', () => {
  it('returns an empty object for empty JSON', () => {
    expect(parseToolUseArgs('')).toEqual({});
  });

  it('parses an object', () => {
    expect(parseToolUseArgs('{"city":"Paris"}')).toEqual({city: 'Paris'});
  });

  it('rejects arguments that are not an object', () => {
    expect(() => parseToolUseArgs('[1,2]')).toThrow(/not an object/);
  });
});

describe('messageToLlmResponse', () => {
  it('converts every block and totals the usage', () => {
    const response = messageToLlmResponse(
      anthropicMessage(
        [
          {
            type: 'thinking',
            thinking: 'I need to think about this.',
            signature: 'sig_xyz',
          },
          {type: 'redacted_thinking', data: 'hidden'},
          {type: 'text', text: 'Here is my answer.', citations: null},
        ],
        anthropicUsage(10, 20),
      ),
    );

    expect(response.content).toEqual({
      role: 'model',
      parts: [
        {
          text: 'I need to think about this.',
          thought: true,
          thoughtSignature: 'sig_xyz',
        },
        {thought: true, thoughtSignature: 'hidden'},
        {text: 'Here is my answer.'},
      ],
    });
    expect(response.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    });
  });
});

describe('functionDeclarationToToolParam', () => {
  const cases: Array<[string, FunctionDeclaration, Tool]> = [
    [
      'no parameters',
      {name: 'get_current_time', description: 'Gets the current time.'},
      {
        name: 'get_current_time',
        description: 'Gets the current time.',
        input_schema: {type: 'object', properties: {}},
      },
    ],
    [
      'one optional parameter',
      {
        name: 'get_weather',
        description: 'Gets weather information for a given location.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            location: {
              type: Type.STRING,
              description: 'City and state, e.g., San Francisco, CA',
            },
          },
        },
      },
      {
        name: 'get_weather',
        description: 'Gets weather information for a given location.',
        input_schema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'City and state, e.g., San Francisco, CA',
            },
          },
        },
      },
    ],
    [
      'one required parameter',
      {
        name: 'get_stock_price',
        description: 'Gets the current price for a stock ticker.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            ticker: {
              type: Type.STRING,
              description: 'The stock ticker, e.g., AAPL',
            },
          },
          required: ['ticker'],
        },
      },
      {
        name: 'get_stock_price',
        description: 'Gets the current price for a stock ticker.',
        input_schema: {
          type: 'object',
          properties: {
            ticker: {
              type: 'string',
              description: 'The stock ticker, e.g., AAPL',
            },
          },
          required: ['ticker'],
        },
      },
    ],
    [
      'multiple mixed parameters',
      {
        name: 'submit_order',
        description: 'Submits a product order.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            product_id: {type: Type.STRING, description: 'The product ID'},
            quantity: {type: Type.INTEGER, description: 'The order quantity'},
            notes: {type: Type.STRING, description: 'Optional order notes'},
          },
          required: ['product_id', 'quantity'],
        },
      },
      {
        name: 'submit_order',
        description: 'Submits a product order.',
        input_schema: {
          type: 'object',
          properties: {
            product_id: {type: 'string', description: 'The product ID'},
            quantity: {type: 'integer', description: 'The order quantity'},
            notes: {type: 'string', description: 'Optional order notes'},
          },
          required: ['product_id', 'quantity'],
        },
      },
    ],
    [
      'a complex nested array-of-objects parameter',
      {
        name: 'create_playlist',
        description: 'Creates a playlist from a list of songs.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            playlist_name: {
              type: Type.STRING,
              description: 'The name for the new playlist',
            },
            songs: {
              type: Type.ARRAY,
              description: 'A list of songs to add to the playlist',
              items: {
                type: Type.OBJECT,
                properties: {
                  title: {type: Type.STRING},
                  artist: {type: Type.STRING},
                },
                required: ['title', 'artist'],
              },
            },
          },
          required: ['playlist_name', 'songs'],
        },
      },
      {
        name: 'create_playlist',
        description: 'Creates a playlist from a list of songs.',
        input_schema: {
          type: 'object',
          properties: {
            playlist_name: {
              type: 'string',
              description: 'The name for the new playlist',
            },
            songs: {
              type: 'array',
              description: 'A list of songs to add to the playlist',
              items: {
                type: 'object',
                properties: {
                  title: {type: 'string'},
                  artist: {type: 'string'},
                },
                required: ['title', 'artist'],
              },
            },
          },
          required: ['playlist_name', 'songs'],
        },
      },
    ],
    [
      'a nested object parameter',
      {
        name: 'update_profile',
        description: 'Updates a user profile.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            profile: {
              type: Type.OBJECT,
              description: 'The profile data',
              properties: {
                name: {type: Type.STRING, description: 'Full name'},
                address: {
                  type: Type.OBJECT,
                  description: 'Mailing address',
                  properties: {
                    city: {type: Type.STRING},
                    state: {type: Type.STRING},
                  },
                },
              },
            },
          },
          required: ['profile'],
        },
      },
      {
        name: 'update_profile',
        description: 'Updates a user profile.',
        input_schema: {
          type: 'object',
          properties: {
            profile: {
              type: 'object',
              description: 'The profile data',
              properties: {
                name: {type: 'string', description: 'Full name'},
                address: {
                  type: 'object',
                  description: 'Mailing address',
                  properties: {
                    city: {type: 'string'},
                    state: {type: 'string'},
                  },
                },
              },
            },
          },
          required: ['profile'],
        },
      },
    ],
    [
      'an anyOf parameter',
      {
        name: 'set_value',
        description: 'Sets a value that can be a string or integer.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            value: {
              description: 'A string or integer value',
              anyOf: [{type: Type.STRING}, {type: Type.INTEGER}],
            },
          },
          required: ['value'],
        },
      },
      {
        name: 'set_value',
        description: 'Sets a value that can be a string or integer.',
        input_schema: {
          type: 'object',
          properties: {
            value: {
              description: 'A string or integer value',
              anyOf: [{type: 'string'}, {type: 'integer'}],
            },
          },
          required: ['value'],
        },
      },
    ],
    [
      'a JSON Schema with additionalProperties',
      {
        name: 'store_metadata',
        description: 'Stores arbitrary key-value metadata.',
        parametersJsonSchema: {
          type: 'OBJECT',
          properties: {
            metadata: {
              type: 'OBJECT',
              description: 'Arbitrary metadata',
              additionalProperties: {type: 'STRING'},
            },
          },
          required: ['metadata'],
        },
      },
      {
        name: 'store_metadata',
        description: 'Stores arbitrary key-value metadata.',
        input_schema: {
          type: 'object',
          properties: {
            metadata: {
              type: 'object',
              description: 'Arbitrary metadata',
              additionalProperties: {type: 'string'},
            },
          },
          required: ['metadata'],
        },
      },
    ],
    [
      'a JSON Schema with combinators and a tuple items list',
      {
        name: 'validate_payload',
        description: 'Validates a payload with schema combinators.',
        parametersJsonSchema: {
          type: 'OBJECT',
          properties: {
            choice: {oneOf: [{type: 'STRING'}, {type: 'INTEGER'}]},
            config: {
              allOf: [
                {type: 'OBJECT', properties: {enabled: {type: 'BOOLEAN'}}},
              ],
            },
            blocked: {not: {type: 'NULL'}},
            tuple_value: {
              type: 'ARRAY',
              items: [{type: 'STRING'}, {type: 'INTEGER'}],
            },
            named: {$defs: {inner: {type: 'STRING'}}},
            conditional: {
              if: {type: 'STRING'},
              then: {type: 'STRING'},
              else: {type: 'INTEGER'},
            },
            listed: {type: 'ARRAY', prefixItems: [{type: 'BOOLEAN'}]},
          },
          required: ['choice'],
        },
      },
      {
        name: 'validate_payload',
        description: 'Validates a payload with schema combinators.',
        input_schema: {
          type: 'object',
          properties: {
            choice: {oneOf: [{type: 'string'}, {type: 'integer'}]},
            config: {
              allOf: [
                {type: 'object', properties: {enabled: {type: 'boolean'}}},
              ],
            },
            blocked: {not: {type: 'null'}},
            tuple_value: {
              type: 'array',
              items: [{type: 'string'}, {type: 'integer'}],
            },
            named: {$defs: {inner: {type: 'string'}}},
            conditional: {
              if: {type: 'string'},
              then: {type: 'string'},
              else: {type: 'integer'},
            },
            listed: {type: 'array', prefixItems: [{type: 'boolean'}]},
          },
          required: ['choice'],
        },
      },
    ],
    [
      'a JSON Schema using the less common applicator keywords',
      {
        name: 'validate_shape',
        description: 'Validates a shape.',
        parametersJsonSchema: {
          type: 'OBJECT',
          dependentSchemas: {a: {type: 'STRING'}},
          patternProperties: {'^x-': {type: 'INTEGER'}},
          propertyNames: {type: 'STRING'},
          unevaluatedProperties: {type: 'BOOLEAN'},
          properties: {
            tags: {type: 'ARRAY', contains: {type: 'STRING'}},
          },
        },
      },
      {
        name: 'validate_shape',
        description: 'Validates a shape.',
        input_schema: {
          type: 'object',
          dependentSchemas: {a: {type: 'string'}},
          patternProperties: {'^x-': {type: 'integer'}},
          propertyNames: {type: 'string'},
          unevaluatedProperties: {type: 'boolean'},
          properties: {
            tags: {type: 'array', contains: {type: 'string'}},
          },
        },
      },
    ],
    [
      'a plain JSON Schema',
      {
        name: 'search_database',
        description: 'Searches a database with given criteria.',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            query: {type: 'string', description: 'The search query'},
            limit: {type: 'integer', description: 'Maximum number of results'},
          },
          required: ['query'],
        },
      },
      {
        name: 'search_database',
        description: 'Searches a database with given criteria.',
        input_schema: {
          type: 'object',
          properties: {
            query: {type: 'string', description: 'The search query'},
            limit: {type: 'integer', description: 'Maximum number of results'},
          },
          required: ['query'],
        },
      },
    ],
  ];

  it.each(cases)('converts %s', (_name, declaration, expected) => {
    expect(functionDeclarationToToolParam(declaration)).toEqual(expected);
  });

  it('omits required when the parameter list is empty', () => {
    const tool = functionDeclarationToToolParam({
      name: 'noop',
      parameters: {type: Type.OBJECT, properties: {}, required: []},
    });
    expect(tool.input_schema).toEqual({type: 'object', properties: {}});
    expect(tool.description).toBe('');
  });

  it('rejects a declaration with no name', () => {
    expect(() => functionDeclarationToToolParam({description: 'x'})).toThrow(
      /must have a name/,
    );
  });

  it('rejects a JSON Schema that does not describe an object', () => {
    expect(() =>
      functionDeclarationToToolParam({
        name: 'bad',
        parametersJsonSchema: {type: 'STRING'},
      }),
    ).toThrow(/must describe an object/);
  });
});

describe('buildThinkingParam', () => {
  it('enables manual budgeting for a positive budget', () => {
    expect(
      buildThinkingParam({thinkingConfig: {thinkingBudget: 5000}}),
    ).toEqual({type: 'enabled', budget_tokens: 5000});
  });

  it('disables thinking for a zero budget', () => {
    expect(buildThinkingParam({thinkingConfig: {thinkingBudget: 0}})).toEqual({
      type: 'disabled',
    });
  });

  it.each([-1, -5])('selects adaptive thinking for the budget %i', (budget) => {
    expect(
      buildThinkingParam({thinkingConfig: {thinkingBudget: budget}}),
    ).toEqual({type: 'adaptive'});
  });

  it('rejects a thinking config with no budget', () => {
    expect(() => buildThinkingParam({thinkingConfig: {}})).toThrow(
      /thinking_budget must be set explicitly/,
    );
  });

  it('returns undefined without a config', () => {
    expect(buildThinkingParam()).toBeUndefined();
  });

  it('returns undefined for a config without a thinking config', () => {
    expect(buildThinkingParam({systemInstruction: 'test'})).toBeUndefined();
  });
});

describe('systemInstructionToText', () => {
  it('returns undefined when no instruction is set', () => {
    expect(systemInstructionToText()).toBeUndefined();
  });

  it('passes a string through', () => {
    expect(systemInstructionToText('Be helpful')).toBe('Be helpful');
  });

  it('joins an array of parts with newlines', () => {
    expect(systemInstructionToText([{text: 'one'}, 'two'])).toBe('one\ntwo');
  });

  it('flattens a Content', () => {
    expect(
      systemInstructionToText({
        role: 'user',
        parts: [{text: 'a'}, {text: 'b'}],
      }),
    ).toBe('a\nb');
  });

  it.each([{role: 'user'}, {role: 'user', parts: undefined}])(
    'flattens a Content with no parts',
    (instruction) => {
      expect(systemInstructionToText(instruction)).toBe('');
    },
  );

  it('flattens a part whose text is undefined', () => {
    expect(systemInstructionToText({text: undefined})).toBe('');
  });

  it('flattens a part with no text', () => {
    expect(
      systemInstructionToText({inlineData: {mimeType: 'image/png', data: 'x'}}),
    ).toBe('');
  });
});
