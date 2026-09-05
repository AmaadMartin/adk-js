/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {FinishReason, Part, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  AnthropicMessageBlock,
  buildUsageMetadata,
  contentBlockToPart,
  contentToMessageParam,
  extractThinkingTokenCount,
  extractTokenCounts,
  functionDeclarationToToolParam,
  messageToLlmResponse,
  partToMessageBlock,
  toClaudeRole,
  toGoogleGenAiFinishReason,
  ToolUseIdSanitizer,
} from '../../src/models/anthropic_converters.js';
import {logger} from '../../src/utils/logger.js';

/** Anthropic-safe id pattern, the one the sanitizer preserves verbatim. */
const VALID_TOOL_USE_ID = /^[a-zA-Z0-9_-]+$/;

/** Base64 of the string `pdf-bytes`, used wherever real bytes do not matter. */
const PDF_DATA = Buffer.from('pdf-bytes', 'utf-8').toString('base64');

/** Base64 of the string `chart-bytes`. */
const IMAGE_DATA = Buffer.from('chart-bytes', 'utf-8').toString('base64');

function convert(part: Part): AnthropicMessageBlock {
  return partToMessageBlock(part, new ToolUseIdSanitizer());
}

function toolResult(
  response: Record<string, unknown>,
  id = 'test_id',
): Anthropic.ToolResultBlockParam {
  const block = convert({functionResponse: {id, name: 'tool', response}});
  if (block.type !== 'tool_result') {
    return expect.fail(`expected a tool_result block, got ${block.type}`);
  }
  return block;
}

function toolResultText(
  response: Record<string, unknown>,
  id = 'test_id',
): string {
  const content = toolResult(response, id).content;
  if (typeof content !== 'string') {
    return expect.fail('expected the tool result content to be a string');
  }
  return content;
}

function usage(overrides: Partial<Anthropic.Usage> = {}): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 10,
    output_tokens: 20,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  };
}

function message(
  overrides: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: 'msg_1',
    container: null,
    content: [],
    model: 'claude-sonnet-4-20250514',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: usage(),
    ...overrides,
  };
}

describe('toClaudeRole', () => {
  it.each([
    ['model', 'assistant'],
    ['assistant', 'assistant'],
    ['user', 'user'],
    ['function', 'user'],
    ['tool', 'user'],
    ['', 'user'],
    [undefined, 'user'],
  ])('collapses %s to %s', (adkRole, claudeRole) => {
    expect(toClaudeRole(adkRole)).toBe(claudeRole);
  });
});

describe('toGoogleGenAiFinishReason', () => {
  it.each([
    ['end_turn', FinishReason.STOP],
    ['stop_sequence', FinishReason.STOP],
    ['tool_use', FinishReason.STOP],
    ['pause_turn', FinishReason.STOP],
    ['max_tokens', FinishReason.MAX_TOKENS],
    ['refusal', FinishReason.SAFETY],
    ['model_context_window_exceeded', FinishReason.FINISH_REASON_UNSPECIFIED],
  ] as Array<[Anthropic.StopReason, FinishReason]>)(
    'maps %s to %s',
    (stopReason, expected) => {
      expect(toGoogleGenAiFinishReason(stopReason)).toBe(expected);
    },
  );

  it('returns undefined when Anthropic reported no stop reason', () => {
    expect(toGoogleGenAiFinishReason(null)).toBeUndefined();
    expect(toGoogleGenAiFinishReason(undefined)).toBeUndefined();
  });
});

describe('functionDeclarationToToolParam', () => {
  it('builds an empty object schema for a function with no parameters', () => {
    expect(
      functionDeclarationToToolParam({name: 'ping', description: 'Pings.'}),
    ).toEqual({
      name: 'ping',
      description: 'Pings.',
      input_schema: {type: 'object', properties: {}},
    });
  });

  it('falls back to an empty description', () => {
    expect(functionDeclarationToToolParam({name: 'ping'}).description).toBe('');
  });

  it('omits required when no parameter is required', () => {
    const tool = functionDeclarationToToolParam({
      name: 'search',
      description: 'Searches.',
      parameters: {
        type: Type.OBJECT,
        properties: {query: {type: Type.STRING, description: 'The query'}},
      },
    });

    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {query: {type: 'string', description: 'The query'}},
    });
  });

  it('carries the required list through', () => {
    const tool = functionDeclarationToToolParam({
      name: 'play',
      description: 'Plays a playlist.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          playlistName: {type: Type.STRING},
          songs: {type: Type.ARRAY, items: {type: Type.STRING}},
        },
        required: ['playlistName', 'songs'],
      },
    });

    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {
        playlistName: {type: 'string'},
        songs: {type: 'array', items: {type: 'string'}},
      },
      required: ['playlistName', 'songs'],
    });
  });

  it('lowercases the types of a nested object parameter', () => {
    const tool = functionDeclarationToToolParam({
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
                properties: {city: {type: Type.STRING}},
              },
            },
          },
        },
        required: ['profile'],
      },
    });

    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          description: 'The profile data',
          properties: {
            name: {type: 'string', description: 'Full name'},
            address: {type: 'object', properties: {city: {type: 'string'}}},
          },
        },
      },
      required: ['profile'],
    });
  });

  it('lowercases the types inside an anyOf parameter', () => {
    const tool = functionDeclarationToToolParam({
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
    });

    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {
        value: {
          description: 'A string or integer value',
          anyOf: [{type: 'string'}, {type: 'integer'}],
        },
      },
      required: ['value'],
    });
  });

  it('passes a parametersJsonSchema through, with types lowercased', () => {
    const tool = functionDeclarationToToolParam({
      name: 'search_database',
      description: 'Searches a database.',
      parametersJsonSchema: {
        type: 'OBJECT',
        properties: {
          query: {type: 'STRING', description: 'The search query'},
          limit: {type: 'INTEGER'},
        },
        required: ['query'],
      },
    });

    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {
        query: {type: 'string', description: 'The search query'},
        limit: {type: 'integer'},
      },
      required: ['query'],
    });
  });

  it('lowercases the types under every schema combinator key', () => {
    const tool = functionDeclarationToToolParam({
      name: 'validate_payload',
      description: 'Validates a payload with schema combinators.',
      parametersJsonSchema: {
        type: 'OBJECT',
        properties: {
          choice: {oneOf: [{type: 'STRING'}, {type: 'INTEGER'}]},
          config: {
            allOf: [{type: 'OBJECT', properties: {enabled: {type: 'BOOLEAN'}}}],
          },
          blocked: {not: {type: 'NULL'}},
          tupleValue: {
            type: 'ARRAY',
            items: [{type: 'STRING'}, {type: 'INTEGER'}],
          },
          bag: {type: 'OBJECT', additionalProperties: {type: 'STRING'}},
        },
        $defs: {Named: {type: 'OBJECT'}},
        required: ['choice'],
      },
    });

    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {
        choice: {oneOf: [{type: 'string'}, {type: 'integer'}]},
        config: {
          allOf: [{type: 'object', properties: {enabled: {type: 'boolean'}}}],
        },
        blocked: {not: {type: 'null'}},
        tupleValue: {
          type: 'array',
          items: [{type: 'string'}, {type: 'integer'}],
        },
        bag: {type: 'object', additionalProperties: {type: 'string'}},
      },
      $defs: {Named: {type: 'object'}},
      required: ['choice'],
    });
  });

  it('rejects a declaration with no function name', () => {
    expect(() =>
      functionDeclarationToToolParam({description: 'Nameless.'}),
    ).toThrowError('Anthropic tool definitions require a function name');
  });

  it('falls back to an empty object schema for a non-object schema', () => {
    expect(
      functionDeclarationToToolParam({
        name: 'search',
        parametersJsonSchema: 'not-a-schema',
      }).input_schema,
    ).toEqual({type: 'object'});
  });

  it('does not mutate the caller declaration', () => {
    const parametersJsonSchema = {
      type: 'OBJECT',
      properties: {query: {type: 'STRING'}},
    };

    functionDeclarationToToolParam({name: 'search', parametersJsonSchema});

    expect(parametersJsonSchema).toEqual({
      type: 'OBJECT',
      properties: {query: {type: 'STRING'}},
    });
  });
});

describe('partToMessageBlock tool results', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts the text of a content array', () => {
    const block = toolResult(
      {content: [{type: 'text', text: '{"name":"root"}'}]},
      'test_id_123',
    );

    expect(block.tool_use_id).toBe('test_id_123');
    expect(block.is_error).toBe(false);
    expect(block.content).toBe('{"name":"root"}');
  });

  it('joins several content items with newlines', () => {
    expect(
      toolResultText({
        content: [
          {type: 'text', text: 'First part'},
          {type: 'text', text: 'Second part'},
        ],
      }),
    ).toBe('First part\nSecond part');
  });

  it('renders a non-text content item as JSON', () => {
    expect(toolResultText({content: [{type: 'image', id: 7}, 'plain']})).toBe(
      '{"type":"image","id":7}\nplain',
    );
  });

  it('uses a traditional result string unchanged', () => {
    expect(toolResultText({result: 'This is the result from the tool'})).toBe(
      'This is the result from the tool',
    );
  });

  it('serializes an object result as JSON', () => {
    expect(
      JSON.parse(
        toolResultText({result: {topic: 'travel', active: true, count: null}}),
      ),
    ).toEqual({topic: 'travel', active: true, count: null});
  });

  it('serializes a list result as JSON', () => {
    expect(toolResultText({result: ['item1', 'item2']})).toBe(
      '["item1","item2"]',
    );
  });

  it('does not drop an empty object result', () => {
    expect(toolResultText({result: {}})).toBe('{}');
  });

  it('does not drop an empty list result', () => {
    expect(toolResultText({result: []})).toBe('[]');
  });

  it('renders a non-string scalar result as text', () => {
    expect(toolResultText({result: 42})).toBe('42');
  });

  it('serializes a nested object result as JSON', () => {
    const text = toolResultText({
      result: {results: [{id: 1, tags: ['a', 'b']}], hasMore: false},
    });

    expect(JSON.parse(text)).toEqual({
      results: [{id: 1, tags: ['a', 'b']}],
      hasMore: false,
    });
  });

  it('serializes an arbitrary response object wholesale', () => {
    const text = toolResultText({
      skillName: 'my_skill',
      instructions: 'Step 1: do this.',
      frontmatter: {version: '1.0'},
    });

    expect(JSON.parse(text)).toEqual({
      skillName: 'my_skill',
      instructions: 'Step 1: do this.',
      frontmatter: {version: '1.0'},
    });
  });

  it('does not drop an error response', () => {
    expect(
      JSON.parse(
        toolResultText({error: 'Not found.', errorCode: 'SKILL_NOT_FOUND'}),
      ),
    ).toEqual({error: 'Not found.', errorCode: 'SKILL_NOT_FOUND'});
  });

  it('leaves an empty response empty', () => {
    expect(toolResultText({})).toBe('');
  });

  it('passes a scalar string content through', () => {
    expect(toolResultText({content: 'Hello'})).toBe('Hello');
  });

  it('prefers a string content over its sibling keys', () => {
    const fileText = 'Line one\nLine two';
    expect(toolResultText({skillName: 'my-skill', content: fileText})).toBe(
      fileText,
    );
  });

  it('falls through to the JSON dump when content is an empty string', () => {
    expect(JSON.parse(toolResultText({content: ''}))).toEqual({content: ''});
  });

  it('falls through to the JSON dump when content is an empty array', () => {
    expect(JSON.parse(toolResultText({content: []}))).toEqual({content: []});
  });

  it('keeps sibling keys when content is an empty string', () => {
    expect(JSON.parse(toolResultText({content: '', extra: 'keep me'}))).toEqual(
      {content: '', extra: 'keep me'},
    );
  });

  it('treats a missing response as empty', () => {
    const block = convert({functionResponse: {id: 'test_id', name: 'tool'}});
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'test_id',
      content: '',
      is_error: false,
    });
  });

  it('appends an image a tool attached to its response', () => {
    const withImage = convert({
      functionResponse: {
        id: 'test_id',
        name: 'tool',
        response: {result: 'Here is the chart'},
        parts: [{inlineData: {mimeType: 'image/png', data: IMAGE_DATA}}],
      },
    });

    expect(withImage).toEqual({
      type: 'tool_result',
      tool_use_id: 'test_id',
      is_error: false,
      content: [
        {type: 'text', text: 'Here is the chart'},
        {
          type: 'image',
          source: {type: 'base64', media_type: 'image/png', data: IMAGE_DATA},
        },
      ],
    });
  });

  it('omits the leading text block when the tool sent only an image', () => {
    const block = toolResult({}, 'test_id');
    expect(block.content).toBe('');

    const imageOnly = convert({
      functionResponse: {
        id: 'test_id',
        name: 'tool',
        response: {},
        parts: [{inlineData: {mimeType: 'image/jpeg', data: IMAGE_DATA}}],
      },
    });

    expect(imageOnly).toEqual({
      type: 'tool_result',
      tool_use_id: 'test_id',
      is_error: false,
      content: [
        {
          type: 'image',
          source: {type: 'base64', media_type: 'image/jpeg', data: IMAGE_DATA},
        },
      ],
    });
  });

  it('appends a PDF a tool attached to its response', () => {
    const block = convert({
      functionResponse: {
        id: 'test_id',
        name: 'tool',
        response: {result: 'See the report'},
        parts: [{inlineData: {mimeType: 'application/pdf', data: PDF_DATA}}],
      },
    });

    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'test_id',
      is_error: false,
      content: [
        {type: 'text', text: 'See the report'},
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: PDF_DATA,
          },
        },
      ],
    });
  });

  it('drops tool result media Claude cannot carry, with a warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const block = convert({
      functionResponse: {
        id: 'test_id',
        name: 'tool',
        response: {result: 'ok'},
        parts: [{inlineData: {mimeType: 'audio/wav', data: IMAGE_DATA}}],
      },
    });

    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'test_id',
      content: 'ok',
      is_error: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/Dropping tool result media/);
  });

  it('skips a response part carrying no data', () => {
    const block = convert({
      functionResponse: {
        id: 'test_id',
        name: 'tool',
        response: {result: 'ok'},
        parts: [{inlineData: {mimeType: 'image/png'}}, {}],
      },
    });

    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'test_id',
      content: 'ok',
      is_error: false,
    });
  });
});

describe('partToMessageBlock media', () => {
  it('converts a PDF part into a document block', () => {
    expect(
      convert({inlineData: {mimeType: 'application/pdf', data: PDF_DATA}}),
    ).toEqual({
      type: 'document',
      source: {type: 'base64', media_type: 'application/pdf', data: PDF_DATA},
    });
  });

  it('accepts a PDF mime type carrying parameters', () => {
    expect(
      convert({
        inlineData: {
          mimeType: 'application/pdf; charset=binary',
          data: PDF_DATA,
        },
      }),
    ).toEqual({
      type: 'document',
      source: {type: 'base64', media_type: 'application/pdf', data: PDF_DATA},
    });
  });

  it('converts an image part into an image block', () => {
    expect(
      convert({inlineData: {mimeType: 'image/PNG;q=1', data: IMAGE_DATA}}),
    ).toEqual({
      type: 'image',
      source: {type: 'base64', media_type: 'image/png', data: IMAGE_DATA},
    });
  });

  it('rejects an image part with no data', () => {
    expect(() => convert({inlineData: {mimeType: 'image/png'}})).toThrowError(
      'Anthropic image parts require MIME type and data',
    );
  });

  it('rejects a PDF part with no data', () => {
    expect(() =>
      convert({inlineData: {mimeType: 'application/pdf'}}),
    ).toThrowError('Anthropic PDF parts require data');
  });

  it('rejects an unsupported image MIME type', () => {
    expect(() =>
      convert({inlineData: {mimeType: 'image/bmp', data: IMAGE_DATA}}),
    ).toThrowError('Unsupported Anthropic image MIME type: image/bmp');
  });
});

describe('partToMessageBlock text and code', () => {
  it('converts a text part', () => {
    expect(convert({text: 'Hello'})).toEqual({type: 'text', text: 'Hello'});
  });

  it('fences executable code as python', () => {
    expect(convert({executableCode: {code: 'print(1)'}})).toEqual({
      type: 'text',
      text: 'Code:```python\nprint(1)\n```',
    });
  });

  it('fences an absent code body as an empty block', () => {
    expect(convert({executableCode: {}})).toEqual({
      type: 'text',
      text: 'Code:```python\n\n```',
    });
  });

  it('fences a code execution result as code output', () => {
    expect(convert({codeExecutionResult: {output: '1'}})).toEqual({
      type: 'text',
      text: 'Execution Result:```code_output\n1\n```',
    });
  });

  it('fences an absent result output as an empty block', () => {
    expect(convert({codeExecutionResult: {}})).toEqual({
      type: 'text',
      text: 'Execution Result:```code_output\n\n```',
    });
  });

  it('rejects a part Claude cannot receive', () => {
    expect(() =>
      convert({fileData: {fileUri: 'gs://bucket/file'}}),
    ).toThrowError(/Not supported yet/);
  });
});

describe('ToolUseIdSanitizer', () => {
  it('preserves a valid tool call id', () => {
    const block = convert({functionCall: {id: 'toolu_01abc', name: 'test'}});
    expect(block).toEqual({
      type: 'tool_use',
      id: 'toolu_01abc',
      name: 'test',
      input: {},
    });
  });

  it('rejects a function call with no name', () => {
    expect(() => convert({functionCall: {id: 'toolu_01abc'}})).toThrowError(
      'Anthropic tool calls require a function name',
    );
  });

  it('carries the call arguments through', () => {
    expect(
      convert({
        functionCall: {id: 'toolu_01abc', name: 'test', args: {k: 'v'}},
      }),
    ).toEqual({
      type: 'tool_use',
      id: 'toolu_01abc',
      name: 'test',
      input: {k: 'v'},
    });
  });

  it('preserves a valid tool response id', () => {
    expect(toolResult({result: 'ok'}, 'toolu_01abc').tool_use_id).toBe(
      'toolu_01abc',
    );
  });

  it('preserves an ADK fallback id on both sides of the pair', () => {
    const adkId = 'adk-12345678-1234-1234-1234-123456789012';
    const sanitizer = new ToolUseIdSanitizer();
    const call = partToMessageBlock(
      {functionCall: {id: adkId, name: 't'}},
      sanitizer,
    );
    const response = partToMessageBlock(
      {functionResponse: {id: adkId, name: 't', response: {result: 'ok'}}},
      sanitizer,
    );

    expect(call).toMatchObject({id: adkId});
    expect(response).toMatchObject({tool_use_id: adkId});
  });

  it.each([
    ['an absent id', undefined],
    ['an empty id', ''],
    ['an id with invalid characters', 'invalid id with spaces!'],
  ])('replaces %s on a tool call', (_label, id) => {
    const block = convert({functionCall: {id, name: 'test'}});
    if (block.type !== 'tool_use') {
      return expect.fail(`expected a tool_use block, got ${block.type}`);
    }

    expect(block.id).toMatch(/^toolu_/);
    expect(block.id).toMatch(VALID_TOOL_USE_ID);
  });

  it.each([
    ['an absent id', undefined],
    ['an empty id', ''],
  ])('replaces %s on a tool response', (_label, id) => {
    const block = convert({
      functionResponse: {id, name: 'tool', response: {result: 'ok'}},
    });
    if (block.type !== 'tool_result') {
      return expect.fail(`expected a tool_result block, got ${block.type}`);
    }

    expect(block.tool_use_id).toMatch(/^toolu_/);
    expect(block.tool_use_id).toMatch(VALID_TOOL_USE_ID);
  });

  it('gives a call and its answer the same replacement id', () => {
    const sanitizer = new ToolUseIdSanitizer();
    const call = partToMessageBlock(
      {functionCall: {id: 'bad id!', name: 't'}},
      sanitizer,
    );
    const response = partToMessageBlock(
      {functionResponse: {id: 'bad id!', name: 't', response: {result: 'ok'}}},
      sanitizer,
    );
    if (call.type !== 'tool_use' || response.type !== 'tool_result') {
      return expect.fail('expected a tool_use and a tool_result block');
    }

    expect(call.id).toBe(response.tool_use_id);
  });

  it('gives two different invalid ids two different replacements', () => {
    const sanitizer = new ToolUseIdSanitizer();

    expect(sanitizer.sanitize('bad one!')).toBe('toolu_fallback_0');
    expect(sanitizer.sanitize('bad two!')).toBe('toolu_fallback_1');
    expect(sanitizer.sanitize('bad one!')).toBe('toolu_fallback_0');
  });
});

describe('partToMessageBlock thinking', () => {
  it('converts a signed thinking part', () => {
    expect(
      convert({
        thought: true,
        text: 'Let me think',
        thoughtSignature: Buffer.from('sig-abc', 'utf-8').toString('base64'),
      }),
    ).toEqual({
      type: 'thinking',
      thinking: 'Let me think',
      signature: 'sig-abc',
    });
  });

  it('converts an unsigned thinking part with an empty signature', () => {
    expect(convert({thought: true, text: 'Let me think'})).toEqual({
      type: 'thinking',
      thinking: 'Let me think',
      signature: '',
    });
  });

  it('converts a signature-only thought into a redacted thinking block', () => {
    expect(
      convert({
        thought: true,
        thoughtSignature: Buffer.from('encrypted', 'utf-8').toString('base64'),
      }),
    ).toEqual({type: 'redacted_thinking', data: 'encrypted'});
  });

  it('round-trips a thinking block signature byte for byte', () => {
    const original: Anthropic.ContentBlock = {
      type: 'thinking',
      thinking: 'Step by step',
      signature: 'EqQBCgIYAhIM+opaque/signature==',
    };

    expect(convert(contentBlockToPart(original))).toEqual(original);
  });

  it('round-trips a redacted thinking block byte for byte', () => {
    const original: Anthropic.ContentBlock = {
      type: 'redacted_thinking',
      data: 'EroBCkYIBBgCKkC+encrypted/blob==',
    };

    expect(convert(contentBlockToPart(original))).toEqual(original);
  });
});

describe('contentToMessageParam', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts a user turn, keeping its media', () => {
    expect(
      contentToMessageParam(
        {
          role: 'user',
          parts: [
            {text: 'Look'},
            {inlineData: {mimeType: 'image/png', data: IMAGE_DATA}},
          ],
        },
        new ToolUseIdSanitizer(),
      ),
    ).toEqual({
      role: 'user',
      content: [
        {type: 'text', text: 'Look'},
        {
          type: 'image',
          source: {type: 'base64', media_type: 'image/png', data: IMAGE_DATA},
        },
      ],
    });
  });

  it('drops an image on an assistant turn, with a warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: 'Here'},
            {inlineData: {mimeType: 'image/png', data: IMAGE_DATA}},
          ],
        },
        new ToolUseIdSanitizer(),
      ),
    ).toEqual({role: 'assistant', content: [{type: 'text', text: 'Here'}]});
    expect(warn).toHaveBeenCalledWith(
      'Image data is not supported in Claude for assistant turns.',
    );
  });

  it('drops a PDF on an assistant turn, with a warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(
      contentToMessageParam(
        {
          role: 'model',
          parts: [{inlineData: {mimeType: 'application/pdf', data: PDF_DATA}}],
        },
        new ToolUseIdSanitizer(),
      ),
    ).toEqual({role: 'assistant', content: []});
    expect(warn).toHaveBeenCalledWith(
      'PDF data is not supported in Claude for assistant turns.',
    );
  });

  it('converts a turn with no parts into an empty message', () => {
    expect(
      contentToMessageParam({role: 'user'}, new ToolUseIdSanitizer()),
    ).toEqual({role: 'user', content: []});
  });
});

describe('contentBlockToPart', () => {
  it('converts a signed thinking block', () => {
    expect(
      contentBlockToPart({
        type: 'thinking',
        thinking: 'Reasoning',
        signature: 'sig-abc',
      }),
    ).toEqual({
      text: 'Reasoning',
      thought: true,
      thoughtSignature: Buffer.from('sig-abc', 'utf-8').toString('base64'),
    });
  });

  it('converts an unsigned thinking block', () => {
    expect(
      contentBlockToPart({
        type: 'thinking',
        thinking: 'Reasoning',
        signature: '',
      }),
    ).toEqual({text: 'Reasoning', thought: true});
  });

  it('converts a redacted thinking block', () => {
    expect(
      contentBlockToPart({type: 'redacted_thinking', data: 'encrypted'}),
    ).toEqual({
      thought: true,
      thoughtSignature: Buffer.from('encrypted', 'utf-8').toString('base64'),
    });
  });

  it('converts a text block', () => {
    expect(
      contentBlockToPart({type: 'text', text: 'Hello', citations: null}),
    ).toEqual({text: 'Hello'});
  });

  it('converts a tool use block', () => {
    expect(
      contentBlockToPart({
        type: 'tool_use',
        id: 'toolu_1',
        name: 'search',
        input: {query: 'adk'},
        caller: {type: 'direct'},
      }),
    ).toEqual({
      functionCall: {id: 'toolu_1', name: 'search', args: {query: 'adk'}},
    });
  });

  it('defaults a non-object tool input to empty arguments', () => {
    expect(
      contentBlockToPart({
        type: 'tool_use',
        id: 'toolu_1',
        name: 'search',
        input: 'not-an-object',
        caller: {type: 'direct'},
      }),
    ).toEqual({functionCall: {id: 'toolu_1', name: 'search', args: {}}});
  });

  it('rejects a block type with no genai equivalent', () => {
    expect(() =>
      contentBlockToPart({
        type: 'container_upload',
        file_id: 'file_1',
      }),
    ).toThrowError('Unsupported content block type: container_upload');
  });
});

describe('token counts', () => {
  it('folds the cache tokens into the prompt count', () => {
    expect(
      extractTokenCounts(
        usage({
          input_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        }),
      ),
    ).toEqual({
      promptTokens: 18,
      outputTokens: 20,
      thinkingTokens: undefined,
      cachedInputTokens: 5,
      cacheCreationTokens: 3,
    });
  });

  it('reports no cache counts when Anthropic reported none', () => {
    expect(extractTokenCounts(usage())).toEqual({
      promptTokens: 10,
      outputTokens: 20,
      thinkingTokens: undefined,
      cachedInputTokens: undefined,
      cacheCreationTokens: undefined,
    });
  });

  it('clamps the thinking count to the output total', () => {
    expect(
      extractThinkingTokenCount(
        usage({
          output_tokens: 20,
          output_tokens_details: {thinking_tokens: 50},
        }),
      ),
    ).toBe(20);
  });

  it('keeps a thinking count below the output total', () => {
    expect(
      extractThinkingTokenCount(
        usage({output_tokens: 20, output_tokens_details: {thinking_tokens: 8}}),
      ),
    ).toBe(8);
  });

  it('reports no thinking count when Anthropic reported none', () => {
    expect(extractThinkingTokenCount(usage())).toBeUndefined();
  });

  it('keeps the thinking tokens out of the candidate count', () => {
    expect(
      buildUsageMetadata({
        promptTokens: 10,
        outputTokens: 20,
        thinkingTokens: 8,
      }),
    ).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 12,
      totalTokenCount: 30,
      thoughtsTokenCount: 8,
      cachedContentTokenCount: undefined,
      cacheCreationInputTokens: undefined,
    });
  });
});

describe('messageToLlmResponse', () => {
  it('converts the content, usage and finish reason', () => {
    expect(
      messageToLlmResponse(
        message({
          content: [{type: 'text', text: 'Hi', citations: null}],
          stop_reason: 'max_tokens',
          usage: usage({input_tokens: 4, output_tokens: 6}),
        }),
      ),
    ).toEqual({
      content: {role: 'model', parts: [{text: 'Hi'}]},
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 6,
        totalTokenCount: 10,
        thoughtsTokenCount: undefined,
        cachedContentTokenCount: undefined,
        cacheCreationInputTokens: undefined,
      },
      finishReason: FinishReason.MAX_TOKENS,
    });
  });

  it('splits the thinking tokens out of the candidate count', () => {
    const response = messageToLlmResponse(
      message({
        content: [
          {type: 'thinking', thinking: 'Hmm', signature: 'sig'},
          {type: 'text', text: 'Hi', citations: null},
        ],
        usage: usage({
          input_tokens: 4,
          output_tokens: 30,
          output_tokens_details: {thinking_tokens: 12},
        }),
      }),
    );

    expect(response.usageMetadata).toEqual({
      promptTokenCount: 4,
      candidatesTokenCount: 18,
      totalTokenCount: 34,
      thoughtsTokenCount: 12,
      cachedContentTokenCount: undefined,
      cacheCreationInputTokens: undefined,
    });
    expect(response.content?.parts?.[0]).toEqual({
      text: 'Hmm',
      thought: true,
      thoughtSignature: Buffer.from('sig', 'utf-8').toString('base64'),
    });
  });

  it('reports the cache read and cache creation counts', () => {
    expect(
      messageToLlmResponse(
        message({
          usage: usage({
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          }),
        }),
      ).usageMetadata,
    ).toEqual({
      promptTokenCount: 18,
      candidatesTokenCount: 20,
      totalTokenCount: 38,
      thoughtsTokenCount: undefined,
      cachedContentTokenCount: 5,
      cacheCreationInputTokens: 3,
    });
  });

  it('reports no finish reason when Anthropic reported none', () => {
    expect(
      messageToLlmResponse(message({stop_reason: null})).finishReason,
    ).toBeUndefined();
  });
});
