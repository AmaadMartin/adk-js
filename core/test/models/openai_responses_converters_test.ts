/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Responses converter branches the ported adk-python suite does not reach.
 *
 * `openai_responses_llm_test.ts` holds the parity spec; this file covers the
 * edges around it: absent fields, unusual roles, and payload shapes the API
 * can send but the reference tests never build.
 */

import {
  Content,
  FinishReason,
  FunctionCallingConfigMode,
  Language,
  Type,
} from '@google/genai';
import type {OpenAI} from 'openai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  CallIdSanitizer,
  contentToResponseInputItems,
  functionCallPart,
  functionDeclarationToResponseTool,
  mapFinishReason,
  messageContentParts,
  openaiReasoningConfig,
  REASONING_NOT_GIVEN,
  reasoningParts,
  responseTextConfig,
  responseToLlmResponse,
  serializeSystemInstruction,
  serializeToolOutput,
  toolChoice,
  toResponsesRole,
  toUsageMetadata,
} from '../../src/models/openai_responses_converters.js';
import {logger} from '../../src/utils/logger.js';

import {
  functionCallItem,
  makeResponse,
  makeUsage,
  messageItem,
  reasoningItem,
} from './openai_responses_test_doubles.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serializeToolOutput', () => {
  it('returns an empty string for a missing result', () => {
    expect(serializeToolOutput(null)).toBe('');
    expect(serializeToolOutput(undefined)).toBe('');
  });

  it('returns a string result unchanged', () => {
    expect(serializeToolOutput('done')).toBe('done');
  });

  it('renders a non-text content entry and a scalar entry', () => {
    expect(
      serializeToolOutput({
        content: [{type: 'image', data: 'x'}, {type: 'text'}, 42],
      }),
    ).toBe('{"type":"image","data":"x"}\n{"type":"text"}\n42');
  });

  it('returns a string content field', () => {
    expect(serializeToolOutput({content: 'plain'})).toBe('plain');
  });

  it('unwraps a string result field', () => {
    expect(serializeToolOutput({result: 'ok'})).toBe('ok');
  });

  it('serializes a structured result field', () => {
    expect(serializeToolOutput({result: {n: 1}})).toBe('{"n":1}');
  });

  it('serializes anything else as JSON', () => {
    expect(serializeToolOutput({a: 1})).toBe('{"a":1}');
    expect(serializeToolOutput([1, 2])).toBe('[1,2]');
    expect(serializeToolOutput({content: [], result: null})).toBe(
      '{"content":[],"result":null}',
    );
  });
});

describe('serializeSystemInstruction', () => {
  it('returns undefined when there is no instruction', () => {
    expect(serializeSystemInstruction(undefined)).toBeUndefined();
    expect(serializeSystemInstruction('')).toBeUndefined();
  });

  it('accepts a string', () => {
    expect(serializeSystemInstruction('Be brief.')).toBe('Be brief.');
  });

  it('accepts a single part', () => {
    expect(serializeSystemInstruction({text: 'Be brief.'})).toBe('Be brief.');
    expect(serializeSystemInstruction({inlineData: {data: 'x'}})).toBe('');
  });

  it('accepts a content and concatenates its parts', () => {
    expect(
      serializeSystemInstruction({
        role: 'system',
        parts: [{text: 'Be '}, {text: 'brief.'}],
      }),
    ).toBe('Be brief.');
  });

  it('accepts a content with no parts', () => {
    expect(serializeSystemInstruction({role: 'system'})).toBe('');
  });

  it('accepts a list mixing strings and parts', () => {
    expect(serializeSystemInstruction(['Be ', {text: 'brief.'}])).toBe(
      'Be brief.',
    );
  });
});

describe('responseTextConfig', () => {
  it('asks for a JSON object when only the mime type says so', () => {
    expect(responseTextConfig({responseMimeType: 'application/json'})).toEqual({
      format: {type: 'json_object'},
    });
  });

  it('returns nothing when the request asks for no structured output', () => {
    expect(responseTextConfig({})).toBeUndefined();
  });

  it('returns nothing when the schema converts to an empty object', () => {
    expect(
      responseTextConfig({responseSchema: 'not a schema'}),
    ).toBeUndefined();
  });

  it('names an untitled schema `schema`', () => {
    expect(
      responseTextConfig({responseJsonSchema: {type: 'object'}}),
    ).toMatchObject({format: {name: 'schema'}});
  });

  it('names a schema whose title sanitizes to nothing `schema`', () => {
    expect(
      responseTextConfig({responseJsonSchema: {title: '', type: 'object'}}),
    ).toMatchObject({format: {name: 'schema'}});
  });

  it('replaces every character a schema name may not contain', () => {
    expect(
      responseTextConfig({
        responseJsonSchema: {title: 'a.b(c)$d', type: 'object'},
      }),
    ).toMatchObject({format: {name: 'a_b_c__d'}});
  });
});

describe('openaiReasoningConfig', () => {
  it('says nothing was given when the request has no thinking config', () => {
    expect(openaiReasoningConfig({})).toBe(REASONING_NOT_GIVEN);
  });
});

describe('toResponsesRole', () => {
  it.each([
    ['model', 'assistant'],
    ['assistant', 'assistant'],
    ['system', 'system'],
    ['developer', 'developer'],
    ['tool', 'user'],
    [undefined, 'user'],
  ])('maps %s to %s', (role, expected) => {
    expect(toResponsesRole(role)).toBe(expected);
  });
});

describe('CallIdSanitizer', () => {
  it('restarts its counter for each instance', () => {
    expect(new CallIdSanitizer().sanitize()).toBe('call_adk_fallback_0');
    expect(new CallIdSanitizer().sanitize()).toBe('call_adk_fallback_0');
  });

  it('passes an acceptable id through', () => {
    expect(new CallIdSanitizer().sanitize('call-1_A')).toBe('call-1_A');
  });

  it('gives every unusable id its own stable fallback', () => {
    const sanitizer = new CallIdSanitizer();

    expect([
      sanitizer.sanitize('bad id'),
      sanitizer.sanitize('other id'),
      sanitizer.sanitize('bad id'),
    ]).toEqual([
      'call_adk_fallback_0',
      'call_adk_fallback_1',
      'call_adk_fallback_0',
    ]);
  });
});

describe('contentToResponseInputItems', () => {
  it('returns nothing for a content with no parts', () => {
    expect(contentToResponseInputItems({role: 'user'})).toEqual([]);
  });

  it('drops a part that carries nothing it can send', () => {
    expect(
      contentToResponseInputItems({
        role: 'user',
        parts: [{thought: true}, {videoMetadata: {fps: 1}}],
      }),
    ).toEqual([]);
  });

  it('closes the buffered message before a skipped thought', () => {
    expect(
      contentToResponseInputItems({
        role: 'user',
        parts: [
          {text: 'before'},
          {text: 'thinking', thought: true},
          {text: 'after'},
        ],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'before'}],
      },
      {
        type: 'message',
        role: 'user',
        content: [{type: 'input_text', text: 'after'}],
      },
    ]);
  });

  it('defaults the mime type and data of bare inline data', () => {
    expect(
      contentToResponseInputItems({
        role: 'user',
        parts: [{inlineData: {}}],
      }),
    ).toEqual([
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

  it('sends file data with no mime type as a file url', () => {
    expect(
      contentToResponseInputItems({
        role: 'user',
        parts: [
          {fileData: {fileUri: 'https://example.com/a.bin'}},
          {fileData: {}},
        ],
      }),
    ).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {type: 'input_file', file_url: 'https://example.com/a.bin'},
          {type: 'input_file', file_url: ''},
        ],
      },
    ]);
  });

  it('drops assistant file data with a warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(
      contentToResponseInputItems({
        role: 'model',
        parts: [{fileData: {fileUri: 'file-abc'}}],
      }),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Media data is not supported in Responses assistant turns.',
    );
  });

  it('sends assistant code parts as assistant text', () => {
    const content: Content = {
      role: 'model',
      parts: [
        {executableCode: {language: Language.PYTHON, code: 'print(1)'}},
        {codeExecutionResult: {output: '1'}},
      ],
    };

    expect(contentToResponseInputItems(content)).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: 'Code:```python\nprint(1)\n```',
      },
      {
        type: 'message',
        role: 'assistant',
        content: 'Execution Result:```code_output\n1\n```',
      },
    ]);
  });

  it('logs which kind of replayed thought it skipped', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    contentToResponseInputItems({
      role: 'model',
      parts: [
        {text: 'summary', thought: true},
        {thought: true, thoughtSignature: 'encrypted'},
      ],
    });

    expect(debug.mock.calls.map(([message]) => message)).toEqual([
      'Skipping replayed OpenAI Responses reasoning summary because no prior ' +
        'reasoning item id is available.',
      'Skipping replayed OpenAI Responses reasoning part with encrypted ' +
        'content because no prior reasoning item id is available.',
    ]);
  });
});

describe('functionDeclarationToResponseTool', () => {
  it('sends an empty object schema when the function declares no parameters', () => {
    expect(
      functionDeclarationToResponseTool({name: 'ping'}).parameters,
    ).toEqual({type: 'object', properties: {}});
  });

  it('leaves a declared schema without required fields alone', () => {
    expect(
      functionDeclarationToResponseTool({
        name: 'ping',
        parameters: {type: Type.OBJECT, properties: {a: {type: Type.STRING}}},
      }).parameters,
    ).toEqual({type: 'object', properties: {a: {type: 'string'}}});
  });
});

describe('toolChoice', () => {
  it('returns nothing when the request configures no mode', () => {
    expect(toolChoice({})).toBeUndefined();
    expect(toolChoice({toolConfig: {}})).toBeUndefined();
    expect(
      toolChoice({
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.MODE_UNSPECIFIED,
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe('toUsageMetadata', () => {
  it('returns nothing when the API reported no usage', () => {
    expect(toUsageMetadata(undefined)).toBeUndefined();
  });

  it('reads every token count the API reported', () => {
    expect(
      toUsageMetadata(
        makeUsage({
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
          input_tokens_details: {cache_write_tokens: 0, cached_tokens: 1},
          output_tokens_details: {reasoning_tokens: 2},
        }),
      ),
    ).toEqual({
      promptTokenCount: 2,
      candidatesTokenCount: 3,
      totalTokenCount: 5,
      cachedContentTokenCount: 1,
      thoughtsTokenCount: 2,
    });
  });
});

describe('mapFinishReason', () => {
  it.each([
    ['cancelled', FinishReason.OTHER],
    ['failed', FinishReason.OTHER],
    ['completed', FinishReason.STOP],
    ['in_progress', undefined],
    [undefined, undefined],
  ] as const)('maps status %s', (status, expected) => {
    expect(mapFinishReason(makeResponse({status}))).toBe(expected);
  });

  it('maps an incomplete response that did not run out of tokens to OTHER', () => {
    expect(
      mapFinishReason(
        makeResponse({
          status: 'incomplete',
          incomplete_details: {reason: 'content_filter'},
        }),
      ),
    ).toBe(FinishReason.OTHER);
  });

  it('maps an incomplete response with no stated reason to OTHER', () => {
    expect(mapFinishReason(makeResponse({status: 'incomplete'}))).toBe(
      FinishReason.OTHER,
    );
  });
});

describe('messageContentParts', () => {
  it('returns nothing for a message with no content', () => {
    expect(messageContentParts({...messageItem(''), content: []})).toEqual([]);
  });
});

describe('reasoningParts', () => {
  it('reads both the summary and the reasoning text', () => {
    expect(
      reasoningParts(
        reasoningItem({
          summary: [
            {type: 'summary_text', text: 'first'},
            {type: 'summary_text', text: ''},
          ],
          content: [{type: 'reasoning_text', text: 'second'}],
        }),
      ),
    ).toEqual({
      parts: [
        {text: 'first', thought: true},
        {text: 'second', thought: true},
      ],
      metadata: {id: 'rs_1'},
    });
  });

  it('reports no metadata for an item with no id and no encrypted content', () => {
    expect(reasoningParts({type: 'reasoning', id: '', summary: []})).toEqual({
      parts: [],
      metadata: {},
    });
  });
});

describe('functionCallPart', () => {
  it('falls back to the item id when there is no call id', () => {
    expect(
      functionCallPart(
        functionCallItem({call_id: '', id: 'fc_1', arguments: '{"a":1}'}),
      ).functionCall,
    ).toEqual({id: 'fc_1', name: 'get_weather', args: {a: 1}});
  });

  it('warns and yields an empty name when the call has none', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(functionCallPart(functionCallItem({name: ''})).functionCall).toEqual(
      {id: 'call_123', name: '', args: {}},
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'OpenAI Responses function call is missing a name.',
    );
  });
});

describe('responseToLlmResponse', () => {
  it('records an item it cannot map under unmapped_output', () => {
    const webSearch: OpenAI.Responses.ResponseOutputItem = {
      id: 'ws_1',
      type: 'web_search_call',
      status: 'completed',
      action: {type: 'search'},
    };

    const llmResponse = responseToLlmResponse(
      makeResponse({status: 'completed', output: [webSearch]}),
      {includeResponseMetadata: true},
    );

    expect(llmResponse.content).toBeUndefined();
    expect(llmResponse.customMetadata).toEqual({
      openai_response: {
        id: 'resp_123',
        status: 'completed',
        output: [webSearch],
        unmapped_output: [webSearch],
      },
    });
  });

  it('reports an error code with no message when the API explains nothing', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({status: 'cancelled'}),
      {includeResponseMetadata: false},
    );

    expect(llmResponse.errorCode).toBe(FinishReason.OTHER);
    expect(llmResponse.errorMessage).toBeUndefined();
    expect(llmResponse.customMetadata).toBeUndefined();
  });

  it('keeps the usage block in the metadata', () => {
    const llmResponse = responseToLlmResponse(
      makeResponse({
        status: 'completed',
        usage: makeUsage({input_tokens: 1, output_tokens: 1, total_tokens: 2}),
      }),
      {includeResponseMetadata: true},
    );

    expect(llmResponse.customMetadata).toEqual({
      openai_response: expect.objectContaining({
        usage: expect.objectContaining({total_tokens: 2}),
      }),
    });
  });
});
