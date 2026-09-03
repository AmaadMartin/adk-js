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

import {getProviderFromModel} from '../../src/models/lite_llm_model_utils.js';
import {
  aggregateStreamingThoughtParts,
  appendFallbackUserContentIfMissing,
  buildRequestLog,
  contentToMessageParam,
  enforceStrictOpenAiSchema,
  ensureToolResults,
  functionDeclarationToToolParam,
  getCompletionInputs,
  getContent,
  mergeReasoningTexts,
  partHasPayload,
  ProviderOptions,
  toLiteLlmResponseFormat,
  toLiteLlmRole,
} from '../../src/models/lite_llm_request_converters.js';
import {messageToGenerateContentResponse} from '../../src/models/lite_llm_response_converters.js';
import {
  ChatMessage,
  ContentObject,
  ThinkingBlock,
} from '../../src/models/lite_llm_types.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {
  isJsonObject,
  JsonObject,
  JsonValue,
} from '../../src/utils/json_utils.js';

const OPENAI: ProviderOptions = {provider: 'openai', model: 'openai/gpt-4o'};
const GROQ: ProviderOptions = {provider: 'groq', model: 'groq/llama3'};
const VERTEX_GEMINI: ProviderOptions = {
  provider: 'vertex_ai',
  model: 'vertex_ai/gemini-2.5-flash',
};
const CLAUDE_MODEL_ONLY: ProviderOptions = {
  provider: '',
  model: 'anthropic/claude-4-sonnet',
};
const ANTHROPIC_NO_MODEL: ProviderOptions = {provider: 'anthropic', model: ''};

/** `thoughtSignature` carries base64 text, so fixtures spell it that way. */
const SIG_ROUND_TRIP = 'c2lnX3JvdW5kX3RyaXA=';
const SIG_A = 'c2lnX2E=';

/** Narrows a JSON value to an object, failing the test when it is not one. */
function asObject(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) {
    return expect.fail(`expected an object, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Narrows a JSON value to an array of objects, failing the test otherwise. */
function asObjectArray(value: JsonValue | undefined): JsonObject[] {
  if (!Array.isArray(value)) {
    return expect.fail(`expected an array, got ${JSON.stringify(value)}`);
  }
  return value.map(asObject);
}

/** Encodes text the way `inlineData.data` carries it. */
function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Builds a request carrying only the fields these converters read. */
function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}, ...overrides};
}

/** Returns true when the value is an Anthropic thinking block. */
function isThinkingBlock(value: unknown): value is ThinkingBlock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'thinking'
  );
}

/** Narrows the provider-shaped `thinking_blocks` field to typed blocks. */
function thinkingBlocks(message: ChatMessage): ThinkingBlock[] {
  const blocks: unknown = message.thinking_blocks;
  if (!Array.isArray(blocks) || !blocks.every(isThinkingBlock)) {
    return expect.fail(
      `expected thinking blocks, got ${JSON.stringify(blocks)}`,
    );
  }
  return blocks;
}

/** Narrows a message content to the block list it must be. */
function contentBlocks(message: ChatMessage): ContentObject[] {
  const {content} = message;
  if (!Array.isArray(content)) {
    return expect.fail(
      `expected a content list, got ${JSON.stringify(content)}`,
    );
  }
  return content;
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

  it('sends a thought signature on both provider channels', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {
              functionCall: {id: 'c1', name: 'add', args: {a: 1}},
              thoughtSignature: 'Y2Fs',
            },
          ],
        },
        GROQ,
      ),
    );
    expect(message.tool_calls).toEqual([
      {
        type: 'function',
        id: 'c1',
        function: {name: 'add', arguments: '{"a":1}'},
        provider_specific_fields: {thought_signature: 'Y2Fs'},
        extra_content: {google: {thought_signature: 'Y2Fs'}},
      },
    ]);
  });

  it('carries a signature from a provider message back out', () => {
    const response = messageToGenerateContentResponse({
      role: 'assistant',
      tool_calls: [
        {
          type: 'function',
          id: 'c1',
          function: {name: 'add', arguments: '{"a":1}'},
          extra_content: {google: {thought_signature: 'Y2Fs'}},
        },
      ],
    });
    const modelTurn = response.content;
    if (!modelTurn) {
      expect.fail('the provider message produced no content');
    }

    const message = singleMessage(contentToMessageParam(modelTurn, GROQ));

    expect(message.tool_calls?.[0]).toMatchObject({
      provider_specific_fields: {thought_signature: 'Y2Fs'},
      extra_content: {google: {thought_signature: 'Y2Fs'}},
    });
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

describe('contentToMessageParam tool result role', () => {
  /** Builds a turn carrying one function response per call id. */
  function responses(...callIds: string[]): Content {
    return {
      role: 'user',
      parts: callIds.map((id) => ({
        functionResponse: {id, name: 'get_weather', response: {status: 'ok'}},
      })),
    };
  }

  /** Converts a one-response turn on `model` and returns the role sent. */
  function roleFor(model: string): string | undefined {
    const converted = contentToMessageParam(responses('call_001'), {
      provider: getProviderFromModel(model),
      model,
    });
    return Array.isArray(converted) ? undefined : converted?.role;
  }

  it.each([
    ['ollama/gemma4:e2b'],
    ['google/gemma-4-26B-A4B'],
    ['ollama/Gemma4:31b'],
  ])('sends a tool result to %s as tool_responses', (model) => {
    expect(roleFor(model)).toBe('tool_responses');
  });

  it.each([
    ['ollama/llama3:8b'],
    ['ollama/qwen2.5-coder:3b'],
    ['anthropic/claude-3-opus'],
    ['openai/gpt-4o'],
    ['ollama/gemma3:4b'],
    [''],
  ])('sends a tool result to %s as tool', (model) => {
    expect(roleFor(model)).toBe('tool');
  });

  it('changes only the role, not the call id or the content', () => {
    expect(
      contentToMessageParam(responses('my_call_123'), {
        provider: 'ollama',
        model: 'ollama/gemma4:e2b',
      }),
    ).toEqual({
      role: 'tool_responses',
      tool_call_id: 'my_call_123',
      content: '{"status":"ok"}',
    });
  });

  it('sends every response of a Gemma 4 turn as tool_responses', () => {
    const converted = contentToMessageParam(
      responses('call_a', 'call_b', 'call_c'),
      {provider: 'ollama', model: 'ollama/gemma4:4b'},
    );

    expect(converted).toHaveLength(3);
    expect(
      Array.isArray(converted) && converted.map((message) => message.role),
    ).toEqual(['tool_responses', 'tool_responses', 'tool_responses']);
  });

  it('sends every response of a non-Gemma turn as tool', () => {
    const converted = contentToMessageParam(
      responses('call_a', 'call_b'),
      OPENAI,
    );

    expect(
      Array.isArray(converted) && converted.map((message) => message.role),
    ).toEqual(['tool', 'tool']);
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
    expect(ensureToolResults(messages, 'openai/gpt-4o')).toEqual(messages);
  });

  it('inserts a placeholder before the next non-tool message', () => {
    const healed = ensureToolResults(
      [assistantCall, {role: 'user', content: 'next'}],
      'openai/gpt-4o',
    );
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
    const healed = ensureToolResults([assistantCall], 'openai/gpt-4o');
    expect(healed).toHaveLength(2);
    expect(healed[1].role).toBe('tool');
  });

  it('inserts a placeholder only for the unanswered call', () => {
    const healed = ensureToolResults(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {type: 'function', id: 'c1', function: {name: 'a'}},
            {type: 'function', id: 'c2', function: {name: 'b'}},
          ],
        },
        {role: 'tool', tool_call_id: 'c1', content: '1'},
      ],
      'openai/gpt-4o',
    );
    expect(healed).toHaveLength(3);
    expect(healed[2].tool_call_id).toBe('c2');
  });

  it('leaves an assistant message with no tool calls alone', () => {
    const messages: ChatMessage[] = [{role: 'assistant', content: 'hi'}];
    expect(ensureToolResults(messages, 'openai/gpt-4o')).toEqual(messages);
  });

  it('ignores tool calls with no id', () => {
    const healed = ensureToolResults(
      [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{type: 'function', function: {name: 'a'}}],
        },
      ],
      'openai/gpt-4o',
    );
    expect(healed).toHaveLength(1);
  });

  it('returns an empty list unchanged', () => {
    expect(ensureToolResults([], 'openai/gpt-4o')).toEqual([]);
  });

  it('heals a Gemma 4 history with tool_responses placeholders', () => {
    const healed = ensureToolResults([assistantCall], 'ollama/gemma4:e2b');

    expect(healed[1]).toEqual({
      role: 'tool_responses',
      tool_call_id: 'c1',
      content:
        'Error: Missing tool result (tool execution may have been interrupted before a response was recorded).',
    });
  });

  it('accepts a tool_responses message as answering a Gemma 4 call', () => {
    const messages: ChatMessage[] = [
      assistantCall,
      {role: 'tool_responses', tool_call_id: 'c1', content: '6'},
    ];

    expect(ensureToolResults(messages, 'ollama/gemma4:e2b')).toEqual(messages);
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

    const properties = asObject(schema['properties']);
    expect(asObject(properties['nested'])['required']).toEqual(['x']);
    const list = asObject(properties['list']);
    expect(asObject(list['items'])['additionalProperties']).toBe(false);
    const choice = asObject(properties['choice']);
    expect(choice['default']).toBeNull();
    expect(asObjectArray(choice['anyOf'])[0]['required']).toEqual(['z']);
    expect(asObject(asObject(schema['$defs'])['Extra'])['required']).toEqual([
      'w',
    ]);
  });

  it('strips the siblings of a $ref', () => {
    const schema: JsonObject = {
      type: 'object',
      properties: {ref: {$ref: '#/$defs/Extra', description: 'dropped'}},
    };
    enforceStrictOpenAiSchema(schema);
    expect(asObject(schema['properties'])['ref']).toEqual({
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
    expect(asObject(format?.['json_schema'])['name']).toBe('response');
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

describe('aggregateStreamingThoughtParts', () => {
  it('rejoins the fragments of each streamed thinking block', () => {
    const aggregated = aggregateStreamingThoughtParts([
      {text: 'First block ', thought: true},
      {text: 'text.', thought: true},
      {text: '', thought: true, thoughtSignature: 'c2lnMQ=='},
      {text: 'Second block', thought: true, thoughtSignature: 'c2lnMg=='},
      {text: 'Trailing without sig', thought: true},
    ]);

    expect(aggregated).toStrictEqual([
      {text: 'First block text.', thought: true, thoughtSignature: 'c2lnMQ=='},
      {text: 'Second block', thought: true, thoughtSignature: 'c2lnMg=='},
      {text: 'Trailing without sig', thought: true},
    ]);
  });

  it('returns nothing for no parts', () => {
    expect(aggregateStreamingThoughtParts([])).toStrictEqual([]);
  });
});

describe('contentToMessageParam Anthropic thinking blocks', () => {
  it('sends a Claude model its thinking as a top-level array', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {
              text: 'deep thought',
              thought: true,
              thoughtSignature: SIG_ROUND_TRIP,
            },
            {text: 'Hello!'},
          ],
        },
        CLAUDE_MODEL_ONLY,
      ),
    );

    expect(thinkingBlocks(message)).toStrictEqual([
      {type: 'thinking', thinking: 'deep thought', signature: SIG_ROUND_TRIP},
    ]);
    expect(message.reasoning_content).toBeUndefined();
    expect(message.content).toBe('Hello!');
  });

  it('returns a parsed thinking block unchanged on the next turn', () => {
    const response = messageToGenerateContentResponse({
      role: 'assistant',
      content: 'Final answer',
      thinking_blocks: [
        {type: 'thinking', thinking: 'Let me reason...', signature: SIG_A},
      ],
    });
    const parts = response.content?.parts;
    if (!parts) {
      return expect.fail('expected the response to carry parts');
    }

    const message = singleMessage(
      contentToMessageParam(
        {role: 'model', parts},
        {
          provider: 'anthropic',
          model: 'anthropic/claude-4-sonnet',
        },
      ),
    );

    expect(thinkingBlocks(message)).toStrictEqual([
      {type: 'thinking', thinking: 'Let me reason...', signature: SIG_A},
    ]);
    expect(message.reasoning_content).toBeUndefined();
  });

  it('joins a thinking part and its trailing signature part', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: 'deep thought', thought: true},
            {text: '', thought: true, thoughtSignature: SIG_ROUND_TRIP},
            {text: 'Hello!'},
          ],
        },
        CLAUDE_MODEL_ONLY,
      ),
    );

    expect(thinkingBlocks(message)).toStrictEqual([
      {type: 'thinking', thinking: 'deep thought', signature: SIG_ROUND_TRIP},
    ]);
    expect(message.reasoning_content).toBeUndefined();
    expect(message.content).toBe('Hello!');
  });

  it('leaves a non-Anthropic model on reasoning_content', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [{text: 'thinking text', thought: true}, {text: 'Answer'}],
        },
        OPENAI,
      ),
    );

    expect(message.reasoning_content).toBe('thinking text');
    expect(message.thinking_blocks).toBeUndefined();
  });

  it('falls back to reasoning_content when no thought part is signed', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: 'thinking without sig', thought: true},
            {text: 'Response'},
          ],
        },
        CLAUDE_MODEL_ONLY,
      ),
    );

    expect(message.reasoning_content).toBe('thinking without sig');
    expect(message.thinking_blocks).toBeUndefined();
  });

  it('embeds the blocks in the content list when only the provider is known', () => {
    const response = messageToGenerateContentResponse({
      role: 'assistant',
      content: 'Final answer',
      thinking_blocks: [
        {type: 'thinking', thinking: 'Let me reason...', signature: SIG_A},
      ],
    });
    const parts = response.content?.parts;
    if (!parts) {
      return expect.fail('expected the response to carry parts');
    }

    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            ...parts,
            {functionCall: {id: 'c1', name: 'add', args: {a: 1, b: 2}}},
          ],
        },
        ANTHROPIC_NO_MODEL,
      ),
    );

    expect(contentBlocks(message)).toStrictEqual([
      {type: 'thinking', thinking: 'Let me reason...', signature: SIG_A},
      {type: 'text', text: 'Final answer'},
    ]);
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls?.[0].function?.name).toBe('add');
    expect(message.reasoning_content).toBeUndefined();
  });

  it('leaves a Bedrock Llama model on reasoning_content', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [{text: 'thinking text', thought: true}, {text: 'Answer'}],
        },
        {
          provider: 'bedrock',
          model: 'bedrock/meta.llama3-70b-instruct-v1:0',
        },
      ),
    );

    expect(message.reasoning_content).toBe('thinking text');
    expect(message.thinking_blocks).toBeUndefined();
    expect(message.content).toBe('Answer');
  });

  it('embeds an unsigned block for a Bedrock Claude model', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [{text: 'thinking text', thought: true}, {text: 'Answer'}],
        },
        {
          provider: 'bedrock',
          model: 'bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0',
        },
      ),
    );

    expect(contentBlocks(message)[0]).toStrictEqual({
      type: 'thinking',
      thinking: 'thinking text',
    });
    expect(message.reasoning_content).toBeUndefined();
  });

  it('leaves a Vertex AI Gemini model on reasoning_content', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [{text: 'thinking text', thought: true}, {text: 'Answer'}],
        },
        VERTEX_GEMINI,
      ),
    );

    expect(message.reasoning_content).toBe('thinking text');
    expect(message.thinking_blocks).toBeUndefined();
    expect(message.content).toBe('Answer');
  });

  it('embeds an unsigned block for a Claude model rather than falling through', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [{text: 'thinking text', thought: true}, {text: 'Answer'}],
        },
        {provider: 'anthropic', model: 'anthropic/claude-3-5-sonnet'},
      ),
    );

    expect(contentBlocks(message)[0]).toStrictEqual({
      type: 'thinking',
      thinking: 'thinking text',
    });
    expect(message.reasoning_content).toBeUndefined();
  });

  it('skips a thought part that carries no text', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: '', thought: true},
            {text: 'thinking text', thought: true},
            {text: 'Answer'},
          ],
        },
        ANTHROPIC_NO_MODEL,
      ),
    );

    expect(contentBlocks(message)).toStrictEqual([
      {type: 'thinking', thinking: 'thinking text'},
      {type: 'text', text: 'Answer'},
    ]);
  });

  it('puts the blocks ahead of a multipart content list', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: 'thinking text', thought: true},
            {text: 'look'},
            {inlineData: {data: 'AAA', mimeType: 'image/png'}},
          ],
        },
        ANTHROPIC_NO_MODEL,
      ),
    );

    expect(contentBlocks(message)).toStrictEqual([
      {type: 'thinking', thinking: 'thinking text'},
      {type: 'text', text: 'look'},
      {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
    ]);
  });

  it('sends null content when every thought part is text-less', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: '', thought: true, thoughtSignature: SIG_A},
            {functionCall: {id: 'c1', name: 'add', args: {a: 1}}},
          ],
        },
        ANTHROPIC_NO_MODEL,
      ),
    );

    expect(message.content).toBeNull();
    expect(message.tool_calls).toHaveLength(1);
    expect(message.reasoning_content).toBeUndefined();
  });

  it('rejoins thinking split across streaming deltas', () => {
    const message = singleMessage(
      contentToMessageParam(
        {
          role: 'model',
          parts: [
            {text: 'The user wants ', thought: true},
            {text: 'GST research ', thought: true},
            {text: 'on secondment.', thought: true},
            {
              text: '',
              thought: true,
              thoughtSignature: 'RXJFRENsc0lEQkFDR0FJZnVsbA==',
            },
            {functionCall: {id: 'c1', name: 'create_plan', args: {q: 'test'}}},
          ],
        },
        CLAUDE_MODEL_ONLY,
      ),
    );

    expect(thinkingBlocks(message)).toStrictEqual([
      {
        type: 'thinking',
        thinking: 'The user wants GST research on secondment.',
        signature: 'RXJFRENsc0lEQkFDR0FJZnVsbA==',
      },
    ]);
    expect(message.reasoning_content).toBeUndefined();
  });
});
