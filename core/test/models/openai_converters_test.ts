/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

import {LlmRequest, LlmResponse} from '@google/adk';
import {CallableTool, Type} from '@google/genai';
import type {OpenAI} from 'openai';

import {
  buildCreateParams,
  completionToLlmResponse,
  contentToOpenAiMessages,
  functionDeclarationToOpenAiTool,
  partToOpenAiContent,
  streamToLlmResponses,
  toOpenAiResponseFormat,
  toOpenAiRole,
} from '../../src/models/openai_converters.js';
import {logger} from '../../src/utils/logger.js';

/** Builds a completion whose single choice carries `message`. */
function completionWith(
  message: OpenAI.Chat.ChatCompletionMessage,
): OpenAI.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-1',
    created: 0,
    model: 'gpt-4o',
    object: 'chat.completion',
    choices: [{index: 0, finish_reason: 'stop', logprobs: null, message}],
  };
}

/** Builds a streamed chunk carrying `delta`. */
function chunkWith(
  delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta,
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chatcmpl-1',
    created: 0,
    model: 'gpt-4o',
    object: 'chat.completion.chunk',
    choices: [{index: 0, delta, finish_reason: null}],
  };
}

async function* stream(
  chunks: OpenAI.Chat.ChatCompletionChunk[],
): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collectStream(
  chunks: OpenAI.Chat.ChatCompletionChunk[],
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of streamToLlmResponses(stream(chunks))) {
    responses.push(response);
  }
  return responses;
}

function requestWith(config: LlmRequest['config']): LlmRequest {
  return {
    model: 'gpt-4o',
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    config,
    liveConnectConfig: {},
    toolsDict: {},
  };
}

describe('toOpenAiRole', () => {
  it('maps genai roles onto OpenAI roles', () => {
    expect(toOpenAiRole('model')).toBe('assistant');
    expect(toOpenAiRole('assistant')).toBe('assistant');
    expect(toOpenAiRole('system')).toBe('system');
    expect(toOpenAiRole('tool')).toBe('tool');
    expect(toOpenAiRole('user')).toBe('user');
    expect(toOpenAiRole(undefined)).toBe('user');
  });
});

describe('partToOpenAiContent', () => {
  it('turns an http file uri into an image url', () => {
    expect(
      partToOpenAiContent({fileData: {fileUri: 'https://example.com/a.png'}}),
    ).toEqual({
      type: 'image_url',
      image_url: {url: 'https://example.com/a.png'},
    });
  });

  it('yields empty content for a non-http file uri', () => {
    expect(
      partToOpenAiContent({fileData: {fileUri: 'gs://bucket/a.png'}}),
    ).toBe('');
  });

  it('yields empty content for a part OpenAI cannot carry', () => {
    expect(partToOpenAiContent({videoMetadata: {fps: 1}})).toBe('');
  });

  it('keeps a thought part without text as empty content', () => {
    expect(partToOpenAiContent({thought: true})).toBe('');
  });

  it('tolerates inline data with no bytes', () => {
    expect(partToOpenAiContent({inlineData: {mimeType: 'image/png'}})).toEqual({
      type: 'image_url',
      image_url: {url: 'data:image/png;base64,'},
    });
  });
});

describe('contentToOpenAiMessages', () => {
  it('emits one assistant message carrying text and tool calls', () => {
    const messages = contentToOpenAiMessages({
      role: 'model',
      parts: [
        {text: 'Looking that up'},
        {
          functionCall: {
            id: 'call_1',
            name: 'get_weather',
            args: {city: 'Paris'},
          },
        },
      ],
    });

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: 'Looking that up',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Paris"}',
            },
          },
        ],
      },
    ]);
  });

  it('sends empty arguments for a function call with none', () => {
    const messages = contentToOpenAiMessages({
      role: 'model',
      parts: [{functionCall: {name: 'ping'}}],
    });

    expect(messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {id: '', type: 'function', function: {name: 'ping', arguments: '{}'}},
        ],
      },
    ]);
  });

  it('sends an empty name and tool call id when genai supplies none', () => {
    const messages = contentToOpenAiMessages({
      role: 'tool',
      parts: [{functionResponse: {response: {ok: true}}}],
    });

    expect(messages).toEqual([
      {role: 'tool', tool_call_id: '', content: '{"ok":true}'},
    ]);
    expect(
      contentToOpenAiMessages({role: 'model', parts: [{functionCall: {}}]}),
    ).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {id: '', type: 'function', function: {name: '', arguments: '{}'}},
        ],
      },
    ]);
  });

  it('flattens multipart system content to text', () => {
    const messages = contentToOpenAiMessages({
      role: 'system',
      parts: [{text: 'Be brief.'}, {text: 'Be kind.'}],
    });

    expect(messages).toEqual([
      {role: 'system', content: 'Be brief.\nBe kind.'},
    ]);
  });

  it('emits no message for content with nothing to send', () => {
    expect(contentToOpenAiMessages({role: 'user', parts: []})).toEqual([]);
    expect(contentToOpenAiMessages({role: 'system'})).toEqual([]);
    expect(
      contentToOpenAiMessages({role: 'model', parts: [{text: ''}]}),
    ).toEqual([]);
  });
});

describe('functionDeclarationToOpenAiTool', () => {
  it('throws when the declaration has no name', () => {
    expect(() => functionDeclarationToOpenAiTool({description: 'x'})).toThrow(
      'FunctionDeclaration must have a name.',
    );
  });

  it('lowercases the types of a parametersJsonSchema', () => {
    const tool = functionDeclarationToOpenAiTool({
      name: 'search',
      parametersJsonSchema: {
        type: 'OBJECT',
        properties: {query: {type: 'STRING'}},
      },
    });

    expect(tool.function.description).toBe('');
    expect(tool.function.parameters).toEqual({
      type: 'object',
      properties: {query: {type: 'string'}},
    });
  });

  it('does not mutate the caller parametersJsonSchema', () => {
    const parametersJsonSchema = {type: 'OBJECT', properties: {}};

    functionDeclarationToOpenAiTool({name: 'search', parametersJsonSchema});

    expect(parametersJsonSchema.type).toBe('OBJECT');
  });

  it('omits required when the declaration lists none', () => {
    const tool = functionDeclarationToOpenAiTool({
      name: 'now',
      parameters: {type: Type.OBJECT},
    });

    expect(tool.function.parameters).toEqual({type: 'object', properties: {}});
  });
});

describe('completionToLlmResponse', () => {
  it('turns tool calls into function call parts carrying the call id', () => {
    const response = completionToLlmResponse(
      completionWith({
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {name: 'get_weather', arguments: '{"city":"Paris"}'},
          },
        ],
      }),
    );

    expect(response.content).toEqual({
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call_1',
            name: 'get_weather',
            args: {city: 'Paris'},
          },
        },
      ],
    });
  });

  it('warns and falls back to empty arguments on unparseable JSON', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const response = completionToLlmResponse(
      completionWith({
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {name: 'get_weather', arguments: 'not json'},
          },
        ],
      }),
    );

    expect(warn).toHaveBeenCalledWith(
      'Failed to parse tool call arguments as JSON.',
    );
    expect(response.content?.parts?.[0]?.functionCall?.args).toEqual({});
  });

  it('keeps empty arguments empty without warning', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const response = completionToLlmResponse(
      completionWith({
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {name: 'now', arguments: ''},
          },
        ],
      }),
    );

    expect(warn).not.toHaveBeenCalled();
    expect(response.content?.parts?.[0]?.functionCall?.args).toEqual({});
  });

  it('ignores a custom tool call', () => {
    const response = completionToLlmResponse(
      completionWith({
        role: 'assistant',
        content: 'done',
        refusal: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'custom',
            custom: {name: 'shell', input: 'ls'},
          },
        ],
      }),
    );

    expect(response.content?.parts).toEqual([{text: 'done'}]);
  });

  it('reports no cached count when the details omit one', () => {
    const completion = completionWith({
      role: 'assistant',
      content: 'hi',
      refusal: null,
    });

    const response = completionToLlmResponse({
      ...completion,
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_tokens_details: {},
      },
    });

    expect(response.usageMetadata).toEqual({
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2,
      cachedContentTokenCount: undefined,
    });
  });

  it('reports no usage counts when the completion carries no usage', () => {
    const response = completionToLlmResponse(
      completionWith({role: 'assistant', content: 'hi', refusal: null}),
    );

    expect(response.usageMetadata).toEqual({
      promptTokenCount: undefined,
      candidatesTokenCount: undefined,
      totalTokenCount: undefined,
      cachedContentTokenCount: undefined,
    });
  });

  it('yields no parts for a completion with no choices', () => {
    const completion = completionWith({
      role: 'assistant',
      content: 'hi',
      refusal: null,
    });

    const response = completionToLlmResponse({...completion, choices: []});

    expect(response.content).toEqual({role: 'model', parts: []});
  });
});

describe('streamToLlmResponses', () => {
  it('emits one partial response per text delta, then the full text', async () => {
    const responses = await collectStream([
      chunkWith({content: 'Hel'}),
      chunkWith({content: 'lo'}),
    ]);

    expect(responses).toEqual([
      {content: {role: 'model', parts: [{text: 'Hel'}]}, partial: true},
      {content: {role: 'model', parts: [{text: 'lo'}]}, partial: true},
      {content: {role: 'model', parts: [{text: 'Hello'}]}, partial: false},
    ]);
  });

  it('accumulates tool call fragments and emits them in index order', async () => {
    const responses = await collectStream([
      chunkWith({
        tool_calls: [
          {
            index: 1,
            id: 'call_b',
            type: 'function',
            function: {name: 'b', arguments: '{"x"'},
          },
        ],
      }),
      chunkWith({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: {name: 'a', arguments: '{}'},
          },
          {index: 1, function: {arguments: ':1}'}},
        ],
      }),
    ]);

    expect(responses).toEqual([
      {
        partial: false,
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'call_a', name: 'a', args: {}}},
            {functionCall: {id: 'call_b', name: 'b', args: {x: 1}}},
          ],
        },
      },
    ]);
  });

  it('accumulates a fragment that carries no function payload', async () => {
    const responses = await collectStream([
      chunkWith({
        tool_calls: [{index: 0, id: 'call_a', function: {name: 'now'}}],
      }),
      chunkWith({tool_calls: [{index: 0}]}),
    ]);

    expect(responses[0]?.content?.parts).toEqual([
      {functionCall: {id: 'call_a', name: 'now', args: {}}},
    ]);
  });

  it('skips a chunk with no choices', async () => {
    const empty = {...chunkWith({content: 'x'}), choices: []};

    const responses = await collectStream([empty, chunkWith({content: 'hi'})]);

    expect(responses).toEqual([
      {content: {role: 'model', parts: [{text: 'hi'}]}, partial: true},
      {content: {role: 'model', parts: [{text: 'hi'}]}, partial: false},
    ]);
  });

  it('warns and falls back to empty accumulated arguments', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const responses = await collectStream([
      chunkWith({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: {name: 'a', arguments: 'nope'},
          },
        ],
      }),
    ]);

    expect(warn).toHaveBeenCalledWith(
      'Failed to parse accumulated tool call arguments as JSON.',
    );
    expect(responses[0]?.content?.parts?.[0]?.functionCall?.args).toEqual({});
  });

  it('emits an empty final response for a stream with no deltas', async () => {
    const responses = await collectStream([chunkWith({})]);

    expect(responses).toEqual([
      {content: {role: 'model', parts: []}, partial: false},
    ]);
  });
});

describe('toOpenAiResponseFormat', () => {
  it('returns undefined when the request asks for nothing', () => {
    expect(toOpenAiResponseFormat(undefined)).toBeUndefined();
    expect(toOpenAiResponseFormat({})).toBeUndefined();
  });

  it('asks for a json object when only the mime type is set', () => {
    expect(
      toOpenAiResponseFormat({responseMimeType: 'application/json'}),
    ).toEqual({type: 'json_object'});
  });

  it('converts a genai schema into a strict json schema', () => {
    expect(
      toOpenAiResponseFormat({
        responseSchema: {
          title: 'Weather',
          type: Type.OBJECT,
          properties: {
            summary: {type: Type.STRING},
            celsius: {type: Type.INTEGER},
          },
        },
      }),
    ).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'Weather',
        strict: true,
        schema: {
          title: 'Weather',
          type: 'object',
          properties: {
            summary: {type: 'string'},
            celsius: {type: 'integer'},
          },
          additionalProperties: false,
          required: ['celsius', 'summary'],
        },
      },
    });
  });

  it('names an untitled schema "response"', () => {
    const format = toOpenAiResponseFormat({
      responseSchema: {type: Type.OBJECT, properties: {a: {type: Type.STRING}}},
    });

    expect(format).toMatchObject({json_schema: {name: 'response'}});
  });

  it('passes a plain json schema through without dropping its type', () => {
    const responseSchema = {
      type: 'object',
      properties: {a: {type: 'STRING'}},
    };

    const format = toOpenAiResponseFormat({responseSchema});

    expect(format).toEqual({
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
    expect(responseSchema.properties.a.type).toBe('STRING');
  });

  it('prefers the response schema over the mime type', () => {
    const format = toOpenAiResponseFormat({
      responseMimeType: 'application/json',
      responseSchema: {type: Type.OBJECT, properties: {}},
    });

    expect(format).toMatchObject({type: 'json_schema'});
  });
});

describe('buildCreateParams', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends tools and tool_choice auto when the request declares tools', () => {
    const params = buildCreateParams(
      requestWith({
        tools: [
          {
            functionDeclarations: [
              {name: 'get_weather', description: 'Get weather'},
            ],
          },
        ],
      }),
      'gpt-4o',
      4096,
    );

    expect(params.tool_choice).toBe('auto');
    expect(params.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {type: 'object', properties: {}},
        },
      },
    ]);
  });

  it('omits tools and tool_choice when the request declares none', () => {
    const params = buildCreateParams(requestWith({tools: []}), 'gpt-4o', 4096);

    expect(params.tools).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
  });

  it('ignores a callable tool, which declares no functions inline', () => {
    const callableTool: CallableTool = {
      tool: () => Promise.resolve({}),
      callTool: () => Promise.resolve([]),
    };

    const params = buildCreateParams(
      requestWith({tools: [callableTool]}),
      'gpt-4o',
      4096,
    );

    expect(params.tools).toBeUndefined();
  });

  it('sends the response format the request asks for', () => {
    const params = buildCreateParams(
      requestWith({responseMimeType: 'application/json'}),
      'gpt-4o',
      4096,
    );

    expect(params.response_format).toEqual({type: 'json_object'});
  });

  it('ignores a tool entry that declares no functions', () => {
    const withOtherTool = buildCreateParams(
      requestWith({tools: [{googleSearch: {}}]}),
      'gpt-4o',
      4096,
    );
    const withUnsetDeclarations = buildCreateParams(
      requestWith({tools: [{functionDeclarations: undefined}]}),
      'gpt-4o',
      4096,
    );

    expect(withOtherTool.tools).toBeUndefined();
    expect(withUnsetDeclarations.tools).toBeUndefined();
  });

  it('omits stop when the request lists no stop sequences', () => {
    const params = buildCreateParams(
      requestWith({stopSequences: []}),
      'gpt-4o',
      4096,
    );

    expect(params.stop).toBeUndefined();
  });

  it('sends a zero temperature rather than dropping it', () => {
    const params = buildCreateParams(
      requestWith({temperature: 0, topP: 0}),
      'gpt-4o',
      4096,
    );

    expect(params.temperature).toBe(0);
    expect(params.top_p).toBe(0);
  });

  it('falls back to the model ceiling and an empty message list', () => {
    const params = buildCreateParams(
      {contents: [], liveConnectConfig: {}, toolsDict: {}},
      'gpt-4o',
      512,
    );

    expect(params).toEqual({
      model: 'gpt-4o',
      messages: [],
      max_tokens: 512,
    });
  });

  it('renders a multipart system instruction as one system message', () => {
    const params = buildCreateParams(
      requestWith({
        systemInstruction: {parts: [{text: 'Be brief.'}, {text: 'Be kind.'}]},
      }),
      'gpt-4o',
      4096,
    );

    expect(params.messages[0]).toEqual({
      role: 'system',
      content: 'Be brief.\nBe kind.',
    });
  });
});
