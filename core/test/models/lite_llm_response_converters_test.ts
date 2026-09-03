/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  applyFinishReason,
  BraceDepthTracker,
  buildToolCallFromJsonDict,
  convertReasoningValueToParts,
  extractCacheCreationTokens,
  extractCachedPromptTokens,
  extractGroundingMetadata,
  extractReasoningTokens,
  extractReasoningValue,
  extractThoughtSignatureFromToolCall,
  extractUsageMetadata,
  iterReasoningTexts,
  messageToGenerateContentResponse,
  modelResponseToChunks,
  modelResponseToGenerateContentResponse,
  parseToolCallArguments,
  parseToolCallsFromText,
  quoteUnquotedJsonObjectKeys,
  ResponseChunk,
  splitMessageContentAndToolCalls,
} from '../../src/models/lite_llm_response_converters.js';
import {
  ModelResponse,
  ModelResponseStream,
} from '../../src/models/lite_llm_types.js';
import {LlmResponse} from '../../src/models/llm_response.js';

/** Returns the error `JSON.parse` raises for a source that is not JSON. */
function jsonParseError(source: string): SyntaxError {
  try {
    JSON.parse(source);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return error;
    }
  }
  return expect.fail(`expected ${source} to be rejected by JSON.parse`);
}

/** Collects the chunks a response yields, dropping the finish reasons. */
function chunksOf(
  response: ModelResponse | ModelResponseStream,
): Array<ResponseChunk | undefined> {
  return [...modelResponseToChunks(response)].map(([chunk]) => chunk);
}

/** Collects the finish reason each chunk was paired with. */
function finishReasonsOf(
  response: ModelResponse | ModelResponseStream,
): Array<string | undefined> {
  return [...modelResponseToChunks(response)].map(([, reason]) => reason);
}

describe('BraceDepthTracker', () => {
  it('reports a completed top-level object', () => {
    expect(new BraceDepthTracker().feed('{"a": 1}')).toBe(true);
  });

  it('reports completion only once the object closes', () => {
    const tracker = new BraceDepthTracker();
    expect(tracker.feed('{"a": ')).toBe(false);
    expect(tracker.feed('{"b": 1}')).toBe(false);
    expect(tracker.feed('}')).toBe(true);
  });

  it('ignores braces inside strings', () => {
    expect(new BraceDepthTracker().feed('{"a": "}"}')).toBe(true);
  });

  it('ignores an escaped quote inside a string', () => {
    expect(new BraceDepthTracker().feed('{"a": "x\\"}y"}')).toBe(true);
  });

  it('ignores brackets', () => {
    expect(new BraceDepthTracker().feed('{"a": [1, 2]}')).toBe(true);
  });

  it('ignores a closing brace with nothing open', () => {
    expect(new BraceDepthTracker().feed('}}')).toBe(false);
  });
});

describe('quoteUnquotedJsonObjectKeys', () => {
  it('quotes bare keys', () => {
    expect(quoteUnquotedJsonObjectKeys('{a: 1, b: 2}')).toBe(
      '{"a": 1, "b": 2}',
    );
  });

  it('quotes a key separated from its colon by whitespace', () => {
    expect(quoteUnquotedJsonObjectKeys('{a : 1}')).toBe('{"a" : 1}');
  });

  it('leaves already-quoted keys alone', () => {
    expect(quoteUnquotedJsonObjectKeys('{"a": 1}')).toBe('{"a": 1}');
  });

  it('leaves string contents alone', () => {
    expect(quoteUnquotedJsonObjectKeys(`{a: "x, y: z"}`)).toBe(
      `{"a": "x, y: z"}`,
    );
  });

  it('leaves single-quoted strings alone', () => {
    expect(quoteUnquotedJsonObjectKeys("{a: 'b, c'}")).toBe('{"a": \'b, c\'}');
  });

  it('leaves an escaped quote inside a string alone', () => {
    expect(quoteUnquotedJsonObjectKeys('{a: "x\\"y"}')).toBe('{"a": "x\\"y"}');
  });

  it('leaves a bare word that is not a key alone', () => {
    expect(quoteUnquotedJsonObjectKeys('{a, b}')).toBe('{a, b}');
  });
});

describe('parseToolCallArguments', () => {
  it.each([[undefined], ['']])('returns an empty object for %s', (args) => {
    expect(parseToolCallArguments(args)).toEqual({});
  });

  it('parses strict JSON', () => {
    expect(parseToolCallArguments('{"a": 1}')).toEqual({a: 1});
  });

  it('repairs unquoted keys', () => {
    expect(parseToolCallArguments('{a: 1}')).toEqual({a: 1});
  });

  it('returns an empty object for JSON that is not an object', () => {
    expect(parseToolCallArguments('[1, 2]')).toEqual({});
  });

  it('throws the original parse error when nothing works', () => {
    expect(() => parseToolCallArguments('{"a": ')).toThrow(SyntaxError);
    expect(() => parseToolCallArguments('not json')).toThrow(SyntaxError);
  });

  it('throws the original parse error when the repair still fails', () => {
    expect(() => parseToolCallArguments('{a: }')).toThrow(SyntaxError);
  });

  it('accepts a Python dict literal', () => {
    expect(parseToolCallArguments("{'query': 'MATCH (n) RETURN n'}")).toEqual({
      query: 'MATCH (n) RETURN n',
    });
  });

  it('accepts Python values a JSON parser rejects', () => {
    expect(
      parseToolCallArguments("{'a': True, 'b': None, 'c': (1, 2)}"),
    ).toEqual({a: true, b: null, c: [1, 2]});
  });

  it('returns an empty object for a Python literal that is not a dict', () => {
    expect(parseToolCallArguments("('a', 'b')")).toEqual({});
  });

  it('accepts unquoted keys with single-quoted values', () => {
    expect(parseToolCallArguments("{query: 'MATCH (n)', limit: 5}")).toEqual({
      query: 'MATCH (n)',
      limit: 5,
    });
  });

  it('throws the error from the payload the provider sent, not the repair', () => {
    const original = jsonParseError('{a: }');
    const repaired = jsonParseError('{"a": }');
    expect(original.message).not.toBe(repaired.message);
    expect(() => parseToolCallArguments('{a: }')).toThrow(original.message);
  });
});

describe('buildToolCallFromJsonDict', () => {
  it('builds a call from a name and arguments', () => {
    expect(
      buildToolCallFromJsonDict({name: 'add', arguments: '{"a":1}'}, 3),
    ).toEqual({
      type: 'function',
      id: expect.stringMatching(/^adk_tool_call_/),
      function: {name: 'add', arguments: '{"a":1}'},
      index: 3,
    });
  });

  it('serializes object arguments', () => {
    expect(
      buildToolCallFromJsonDict({name: 'add', arguments: {a: 1}}, 0)?.function
        ?.arguments,
    ).toBe('{"a":1}');
  });

  it('prefers the id and index the payload carries', () => {
    const toolCall = buildToolCallFromJsonDict(
      {name: 'add', arguments: '{}', id: 'c9', index: 5},
      0,
    );
    expect(toolCall?.id).toBe('c9');
    expect(toolCall?.index).toBe(5);
  });

  it.each([
    [null],
    ['a string'],
    [{arguments: '{}'}],
    [{name: 'add'}],
    [{name: 7, arguments: '{}'}],
  ])('rejects %j', (candidate) => {
    expect(buildToolCallFromJsonDict(candidate, 0)).toBeUndefined();
  });
});

describe('parseToolCallsFromText', () => {
  it('returns nothing for empty text', () => {
    expect(parseToolCallsFromText('')).toEqual({toolCalls: []});
  });

  it('returns the whole text as the remainder when it holds no object', () => {
    expect(parseToolCallsFromText('just prose')).toEqual({
      toolCalls: [],
      remainder: 'just prose',
    });
  });

  it('extracts a tool call and keeps the prose around it', () => {
    const parsed = parseToolCallsFromText(
      'before {"name": "add", "arguments": "{}"} after',
    );
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].function?.name).toBe('add');
    expect(parsed.remainder).toBe('before  after');
  });

  it('extracts several tool calls and indexes them in order', () => {
    const parsed = parseToolCallsFromText(
      '{"name": "a", "arguments": "{}"}{"name": "b", "arguments": "{}"}',
    );
    expect(parsed.toolCalls.map((call) => call.index)).toEqual([0, 1]);
    expect(parsed.remainder).toBeUndefined();
  });

  it('keeps an object that is not a tool call in the remainder', () => {
    expect(parseToolCallsFromText('{"a": 1}')).toEqual({
      toolCalls: [],
      remainder: '{"a": 1}',
    });
  });

  it('keeps an unbalanced brace in the remainder', () => {
    expect(parseToolCallsFromText('{ oops')).toEqual({
      toolCalls: [],
      remainder: '{ oops',
    });
  });

  it('keeps a balanced object that is not JSON in the remainder', () => {
    expect(parseToolCallsFromText('{not json}')).toEqual({
      toolCalls: [],
      remainder: '{not json}',
    });
  });
});

describe('splitMessageContentAndToolCalls', () => {
  it('trusts structured tool calls', () => {
    const toolCall = {type: 'function' as const, id: 'c1'};
    expect(
      splitMessageContentAndToolCalls({
        role: 'assistant',
        content: '{"name": "add", "arguments": "{}"}',
        tool_calls: [toolCall],
      }),
    ).toEqual({
      content: '{"name": "add", "arguments": "{}"}',
      toolCalls: [toolCall],
    });
  });

  it('leaves a non-string content alone', () => {
    expect(
      splitMessageContentAndToolCalls({
        role: 'assistant',
        content: [{type: 'text', text: 'hi'}],
      }).toolCalls,
    ).toEqual([]);
  });

  it('parses tool calls a provider inlined into the text', () => {
    const split = splitMessageContentAndToolCalls({
      role: 'assistant',
      content: 'sure {"name": "add", "arguments": "{}"}',
    });
    expect(split.toolCalls).toHaveLength(1);
    expect(split.content).toBe('sure');
  });

  it('leaves plain text alone', () => {
    expect(
      splitMessageContentAndToolCalls({role: 'assistant', content: 'hello'}),
    ).toEqual({content: 'hello', toolCalls: []});
  });
});

describe('extractReasoningValue', () => {
  it('returns undefined when there is no message', () => {
    expect(extractReasoningValue(undefined)).toBeUndefined();
  });

  it('prefers thinking_blocks', () => {
    expect(
      extractReasoningValue({
        role: 'assistant',
        thinking_blocks: ['a'],
        reasoning_content: 'b',
        reasoning: 'c',
      }),
    ).toEqual(['a']);
  });

  it('prefers reasoning_content over reasoning', () => {
    expect(
      extractReasoningValue({
        role: 'assistant',
        reasoning_content: 'b',
        reasoning: 'c',
      }),
    ).toBe('b');
  });

  it('falls back to reasoning', () => {
    expect(extractReasoningValue({role: 'assistant', reasoning: 'c'})).toBe(
      'c',
    );
  });
});

describe('iterReasoningTexts', () => {
  it.each([
    [undefined, []],
    [null, []],
    ['a', ['a']],
    [
      ['a', ['b']],
      ['a', 'b'],
    ],
    [{text: 'a', reasoning: 'b'}, ['a', 'b']],
    [{content: 'a', reasoning_content: 'b'}, ['a', 'b']],
    [{other: 'a'}, []],
    [7, ['7']],
    [true, ['true']],
    [() => 'a', []],
  ])('reads %j', (value, expected) => {
    expect(iterReasoningTexts(value)).toEqual(expected);
  });
});

describe('convertReasoningValueToParts', () => {
  it('converts a plain string', () => {
    expect(convertReasoningValueToParts('thinking')).toEqual([
      {text: 'thinking', thought: true},
    ]);
  });

  it('drops empty fragments', () => {
    expect(convertReasoningValueToParts('')).toEqual([]);
  });

  it('reads anthropic thinking blocks', () => {
    expect(
      convertReasoningValueToParts([
        {type: 'thinking', thinking: 'step one', signature: 'Y2Fs'},
        {type: 'redacted', data: 'hidden'},
        {type: 'thinking', thinking: ''},
      ]),
    ).toEqual([{text: 'step one', thought: true, thoughtSignature: 'Y2Fs'}]);
  });

  it('keeps a signature-only block so the signature survives', () => {
    expect(
      convertReasoningValueToParts([
        {type: 'thinking', thinking: '', signature: 'Y2Fs'},
      ]),
    ).toEqual([{text: '', thought: true, thoughtSignature: 'Y2Fs'}]);
  });

  it('encodes a signature that did not arrive base64', () => {
    expect(
      convertReasoningValueToParts([
        {type: 'thinking', thinking: 'step one', signature: 'sig'},
      ]),
    ).toEqual([{text: 'step one', thought: true, thoughtSignature: 'c2ln'}]);
  });

  it('leaves a block with neither text nor a signature out', () => {
    expect(
      convertReasoningValueToParts([{type: 'thinking', thinking: ''}]),
    ).toEqual([]);
  });

  it('falls back to text extraction for other list items', () => {
    expect(
      convertReasoningValueToParts([
        {text: 'a'},
        'b',
        {type: 'other', text: 'c'},
      ]),
    ).toEqual([
      {text: 'a', thought: true},
      {text: 'b', thought: true},
      {text: 'c', thought: true},
    ]);
  });
});

describe('extractUsageMetadata', () => {
  it('reads the token counts', () => {
    expect(
      extractUsageMetadata({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
    ).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: undefined,
    });
  });

  it('defaults every count to zero', () => {
    expect(extractUsageMetadata({})).toMatchObject({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    });
  });

  it('reads cached tokens from the details object', () => {
    expect(
      extractUsageMetadata({prompt_tokens_details: {cached_tokens: 4}})
        .cachedContentTokenCount,
    ).toBe(4);
  });

  it('sums cached tokens across a details list', () => {
    expect(
      extractUsageMetadata({
        prompt_tokens_details: [{cached_tokens: 4}, {cached_tokens: 6}, {}],
      }).cachedContentTokenCount,
    ).toBe(10);
  });

  it.each([
    [{cached_prompt_tokens: 3}, 3],
    [{cached_tokens: 3}, 3],
    [{cache_read_input_tokens: 3}, 3],
    [{prompt_tokens_details: [], cache_read_input_tokens: 3}, 3],
  ])('reads cached tokens from %j', (usage, expected) => {
    expect(extractUsageMetadata(usage).cachedContentTokenCount).toBe(expected);
  });

  it('reads reasoning tokens, omitting a zero count', () => {
    expect(
      extractUsageMetadata({completion_tokens_details: {reasoning_tokens: 7}})
        .thoughtsTokenCount,
    ).toBe(7);
    expect(
      extractUsageMetadata({completion_tokens_details: {reasoning_tokens: 0}})
        .thoughtsTokenCount,
    ).toBeUndefined();
  });

  it.each([
    [{cache_creation_input_tokens: 8}, 8],
    [{cache_write_input_tokens: 9}, 9],
  ])('reads cache creation tokens from %j', (usage, expected) => {
    expect(extractUsageMetadata(usage).cacheCreationInputTokens).toBe(expected);
  });

  it('omits cache creation tokens when the provider sends none', () => {
    expect(extractUsageMetadata({}).cacheCreationInputTokens).toBeUndefined();
  });
});

describe('extractGroundingMetadata', () => {
  it('returns undefined when there is none', () => {
    expect(extractGroundingMetadata({})).toBeUndefined();
    expect(
      extractGroundingMetadata({vertex_ai_grounding_metadata: []}),
    ).toBeUndefined();
  });

  it('reads an object', () => {
    expect(
      extractGroundingMetadata({
        vertex_ai_grounding_metadata: {webSearchQueries: ['a']},
      }),
    ).toEqual({webSearchQueries: ['a']});
  });

  it('unwraps a single-element list', () => {
    expect(
      extractGroundingMetadata({
        vertex_ai_grounding_metadata: [{webSearchQueries: ['a']}],
      }),
    ).toEqual({webSearchQueries: ['a']});
  });

  it('drops a malformed value', () => {
    expect(
      extractGroundingMetadata({vertex_ai_grounding_metadata: 'nope'}),
    ).toBeUndefined();
  });

  it.each([
    ['webSearchQueries', {webSearchQueries: [1, 2]}],
    ['imageSearchQueries', {imageSearchQueries: 'one'}],
    ['retrievalQueries', {retrievalQueries: [{}]}],
    ['googleMapsWidgetContextToken', {googleMapsWidgetContextToken: 7}],
    ['groundingChunks', {groundingChunks: ['a']}],
    ['groundingSupports', {groundingSupports: {}}],
    ['sourceFlaggingUris', {sourceFlaggingUris: [null]}],
    ['retrievalMetadata', {retrievalMetadata: []}],
    ['searchEntryPoint', {searchEntryPoint: 'nope'}],
  ])('drops a payload whose %s has the wrong shape', (_field, payload) => {
    expect(
      extractGroundingMetadata({vertex_ai_grounding_metadata: payload}),
    ).toBeUndefined();
  });

  it('keeps a field the SDK type does not declare', () => {
    expect(
      extractGroundingMetadata({
        vertex_ai_grounding_metadata: {webSearchQueries: ['a'], future: 1},
      }),
    ).toEqual({webSearchQueries: ['a'], future: 1});
  });
});

describe('messageToGenerateContentResponse', () => {
  it('converts text', () => {
    expect(
      messageToGenerateContentResponse(
        {role: 'assistant', content: 'hi'},
        {modelVersion: 'gpt-4o'},
      ),
    ).toEqual({
      content: {role: 'model', parts: [{text: 'hi'}]},
      partial: false,
      modelVersion: 'gpt-4o',
    });
  });

  it('converts a tool call', () => {
    expect(
      messageToGenerateContentResponse({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            type: 'function',
            id: 'c1',
            function: {name: 'add', arguments: '{"a": 1}'},
          },
        ],
      }).content?.parts,
    ).toEqual([{functionCall: {id: 'c1', name: 'add', args: {a: 1}}}]);
  });

  it('repairs unquoted keys in tool call arguments', () => {
    expect(
      messageToGenerateContentResponse({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'c1',
            function: {name: 'add', arguments: '{a: 1}'},
          },
        ],
      }).content?.parts?.[0].functionCall?.args,
    ).toEqual({a: 1});
  });

  it('accepts Python dict literal tool call arguments', () => {
    expect(
      messageToGenerateContentResponse({
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'c1',
            function: {
              name: 'run_query',
              arguments: "{'query': 'MATCH (n) RETURN n'}",
            },
          },
        ],
      }).content?.parts?.[0].functionCall?.args,
    ).toEqual({query: 'MATCH (n) RETURN n'});
  });

  it('skips a tool call that is not a function call', () => {
    expect(
      messageToGenerateContentResponse({
        role: 'assistant',
        content: 'hi',
        tool_calls: [{id: 'c1'}],
      }).content?.parts,
    ).toEqual([{text: 'hi'}]);
  });

  it('reads tool calls a provider inlined into the text', () => {
    expect(
      messageToGenerateContentResponse({
        role: 'assistant',
        content: 'ok {"name": "add", "arguments": "{}"}',
      }).content?.parts,
    ).toEqual([
      {text: 'ok'},
      {
        functionCall: {
          id: expect.stringMatching(/^adk_tool_call_/),
          name: 'add',
          args: {},
        },
      },
    ]);
  });

  it('converts the reasoning payload into thought parts', () => {
    expect(
      messageToGenerateContentResponse({
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'because',
      }).content?.parts,
    ).toEqual([{text: 'because', thought: true}, {text: 'answer'}]);
  });

  it('prefers the thought parts the caller supplies', () => {
    expect(
      messageToGenerateContentResponse(
        {role: 'assistant', content: 'answer', reasoning_content: 'ignored'},
        {thoughtParts: [{text: 'supplied', thought: true}], isPartial: true},
      ),
    ).toEqual({
      content: {
        role: 'model',
        parts: [{text: 'supplied', thought: true}, {text: 'answer'}],
      },
      partial: true,
      modelVersion: undefined,
    });
  });
});

describe('applyFinishReason', () => {
  it('leaves the response alone when there is no reason', () => {
    const response: LlmResponse = {};
    applyFinishReason(response, undefined);
    expect(response).toEqual({});
  });

  it('records a clean stop without an error', () => {
    const response: LlmResponse = {};
    applyFinishReason(response, 'stop');
    expect(response).toEqual({finishReason: FinishReason.STOP});
  });

  it('records an error for any other reason', () => {
    const response: LlmResponse = {};
    applyFinishReason(response, 'content_filter');
    expect(response).toEqual({
      finishReason: FinishReason.SAFETY,
      errorCode: FinishReason.SAFETY,
      errorMessage: 'Finished with SAFETY',
    });
  });
});

describe('modelResponseToGenerateContentResponse', () => {
  it('converts a text response', () => {
    expect(
      modelResponseToGenerateContentResponse({
        model: 'gpt-4o',
        choices: [
          {message: {role: 'assistant', content: 'hi'}, finish_reason: 'stop'},
        ],
      }),
    ).toEqual({
      content: {role: 'model', parts: [{text: 'hi'}]},
      partial: false,
      modelVersion: 'gpt-4o',
      finishReason: FinishReason.STOP,
    });
  });

  it.each([
    [{model: 'gpt-4o'}],
    [{model: 'gpt-4o', choices: []}],
    [{model: 'gpt-4o', choices: [{message: {role: 'assistant' as const}}]}],
  ])('returns empty content for %j', (response: ModelResponse) => {
    expect(modelResponseToGenerateContentResponse(response)).toEqual({
      content: {role: 'model', parts: []},
      modelVersion: 'gpt-4o',
    });
  });

  it('records the error a non-stop finish reason implies', () => {
    expect(
      modelResponseToGenerateContentResponse({
        choices: [
          {message: {role: 'assistant'}, finish_reason: 'content_filter'},
        ],
      }),
    ).toMatchObject({
      finishReason: FinishReason.SAFETY,
      errorCode: FinishReason.SAFETY,
      errorMessage: 'Finished with SAFETY',
    });
  });

  it('attaches usage and grounding metadata', () => {
    const response = modelResponseToGenerateContentResponse({
      choices: [{message: {role: 'assistant', content: 'hi'}}],
      usage: {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3},
      vertex_ai_grounding_metadata: {webSearchQueries: ['q']},
    });
    expect(response.usageMetadata).toMatchObject({
      promptTokenCount: 1,
      candidatesTokenCount: 2,
      totalTokenCount: 3,
    });
    expect(response.groundingMetadata).toEqual({webSearchQueries: ['q']});
  });
});

describe('modelResponseToChunks', () => {
  it('yields a single empty chunk when there are no choices', () => {
    expect(chunksOf({})).toEqual([undefined]);
  });

  it('yields reasoning, then text, then tool calls', () => {
    expect(
      chunksOf({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hi',
              reasoning_content: 'because',
              tool_calls: [
                {
                  type: 'function',
                  id: 'c1',
                  function: {name: 'add', arguments: '{}'},
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ).toEqual([
      {kind: 'reasoning', parts: [{text: 'because', thought: true}]},
      {kind: 'text', text: 'hi'},
      {kind: 'function', id: 'c1', name: 'add', args: '{}', index: 0},
    ]);
  });

  it('pairs every chunk with the finish reason of its choice', () => {
    expect(
      finishReasonsOf({
        choices: [
          {message: {role: 'assistant', content: 'hi'}, finish_reason: 'stop'},
        ],
      }),
    ).toEqual(['stop']);
  });

  it('reads the delta of a stream chunk', () => {
    const stream: ModelResponseStream = {
      choices: [{delta: {role: 'assistant', content: 'partial'}}],
    };
    expect(chunksOf(stream)).toEqual([{kind: 'text', text: 'partial'}]);
  });

  it('falls back to the position when a tool call has no index', () => {
    expect(
      chunksOf({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {type: 'function', function: {name: 'a', arguments: '{}'}},
                {type: 'function', function: {name: 'b', arguments: '{}'}},
              ],
            },
          },
        ],
      }).map((chunk) => (chunk?.kind === 'function' ? chunk.index : undefined)),
    ).toEqual([0, 1]);
  });

  it('skips a tool call carrying neither a name nor arguments', () => {
    expect(
      chunksOf({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hi',
              tool_calls: [
                {type: 'function', id: 'c1', function: {}},
                {type: 'function', id: 'c2'},
                {id: 'c3', function: {name: 'a', arguments: '{}'}},
              ],
            },
          },
        ],
      }),
    ).toEqual([{kind: 'text', text: 'hi'}]);
  });

  it('yields the finish reason alone when a chunk carries no content', () => {
    expect([
      ...modelResponseToChunks({
        choices: [{delta: {role: 'assistant'}, finish_reason: 'stop'}],
      }),
    ]).toEqual([[undefined, 'stop']]);
  });

  it('yields usage as a trailing chunk of its own', () => {
    expect(
      chunksOf({
        choices: [{delta: {role: 'assistant', content: 'hi'}}],
        usage: {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3},
      }),
    ).toEqual([
      {kind: 'text', text: 'hi'},
      {
        kind: 'usage',
        usage: {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
          totalTokenCount: 3,
          cachedContentTokenCount: 0,
          thoughtsTokenCount: undefined,
        },
      },
    ]);
  });
});

describe('extractCachedPromptTokens', () => {
  it.each([
    [{prompt_tokens_details: {cached_tokens: 42}}, 42],
    [{prompt_tokens_details: [{cached_tokens: 10}, {cached_tokens: 5}]}, 15],
    [{cached_prompt_tokens: 33}, 33],
    [{cached_tokens: 21}, 21],
    [{cache_read_input_tokens: 17}, 17],
    [{prompt_tokens: 100}, 0],
    [{}, 0],
    ['not a dict', 0],
    [null, 0],
    [undefined, 0],
    [42, 0],
    [[{cached_tokens: 5}], 0],
    [{cached_tokens: 'not a number'}, 0],
    [{prompt_tokens_details: 'not a dict', cached_tokens: 7}, 7],
    [JSON.stringify({cached_tokens: 89}), 89],
    [JSON.stringify({some_key: 'x'}), 0],
    [JSON.stringify([1, 2]), 0],
  ])('reads %j as %i', (usage, expected) => {
    expect(extractCachedPromptTokens(usage)).toBe(expected);
  });
});

describe('extractCacheCreationTokens', () => {
  it.each([
    [{cache_creation_input_tokens: 12}, 12],
    [{cache_write_input_tokens: 8}, 8],
    [{cache_creation_input_tokens: 'no', cache_write_input_tokens: 8}, 8],
    [JSON.stringify({cache_creation_input_tokens: 4}), 4],
  ])('reads %j as %i', (usage, expected) => {
    expect(extractCacheCreationTokens(usage)).toBe(expected);
  });

  it.each([[{}], ['not a dict'], [null], [undefined], [42], [[]]])(
    'reports nothing for %j',
    (usage) => {
      expect(extractCacheCreationTokens(usage)).toBeUndefined();
    },
  );
});

describe('extractReasoningTokens', () => {
  it.each([
    [{completion_tokens_details: {reasoning_tokens: 64}}, 64],
    [JSON.stringify({completion_tokens_details: {reasoning_tokens: 7}}), 7],
    [{completion_tokens_details: {reasoning_tokens: 'lots'}}, 0],
    [{completion_tokens_details: 'not a dict'}, 0],
    [{}, 0],
    ['not a dict', 0],
    [null, 0],
    [undefined, 0],
    [42, 0],
  ])('reads %j as %i', (usage, expected) => {
    expect(extractReasoningTokens(usage)).toBe(expected);
  });
});

describe('extractUsageMetadata from a JSON string', () => {
  it('reads the counts a provider serialized', () => {
    expect(
      extractUsageMetadata(
        JSON.stringify({
          prompt_tokens: 11,
          completion_tokens: 22,
          total_tokens: 33,
          cached_tokens: 4,
          cache_creation_input_tokens: 5,
          completion_tokens_details: {reasoning_tokens: 6},
        }),
      ),
    ).toEqual({
      promptTokenCount: 11,
      candidatesTokenCount: 22,
      totalTokenCount: 33,
      cachedContentTokenCount: 4,
      thoughtsTokenCount: 6,
      cacheCreationInputTokens: 5,
    });
  });

  it('defaults every count to zero for a payload it cannot read', () => {
    expect(extractUsageMetadata('not a dict')).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
      thoughtsTokenCount: undefined,
    });
  });

  it('ignores a count that is not a number', () => {
    expect(extractUsageMetadata({prompt_tokens: '11'})).toMatchObject({
      promptTokenCount: 0,
    });
  });
});

describe('modelResponseToChunks usage typing', () => {
  it.each(['not a dict', JSON.stringify({prompt_tokens: 1})])(
    'refuses the usage %j a stream cannot report',
    (usage) => {
      expect(() => chunksOf({choices: [], usage})).toThrow(
        'Unexpected LiteLLM usage type: string',
      );
    },
  );
});

describe('extractThoughtSignatureFromToolCall', () => {
  it('splits a tool call id on the first separator only', () => {
    // Splitting on the last separator would find the valid base64 tail.
    expect(
      extractThoughtSignatureFromToolCall({id: 'a__thought__b__thought__Y2Fs'}),
    ).toBeUndefined();
    expect(extractThoughtSignatureFromToolCall({id: 'a__thought__Y2Fs'})).toBe(
      'Y2Fs',
    );
  });

  it('reports nothing for an id that ends at the separator', () => {
    expect(
      extractThoughtSignatureFromToolCall({id: 'call_1__thought__'}),
    ).toBeUndefined();
  });
});

describe('messageToGenerateContentResponse thought signatures', () => {
  it('keeps the separator in the function call id it reports', () => {
    const response = messageToGenerateContentResponse({
      role: 'assistant',
      tool_calls: [
        {
          type: 'function',
          id: 'call_1__thought__Y2Fs',
          function: {name: 'lookup', arguments: '{}'},
        },
      ],
    });

    expect(response.content?.parts?.[0]).toEqual({
      functionCall: {id: 'call_1__thought__Y2Fs', name: 'lookup', args: {}},
      thoughtSignature: 'Y2Fs',
    });
  });
});
