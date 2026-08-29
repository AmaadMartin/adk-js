/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  ChatCompletionResponse,
  chunkPieces,
  contentToMessage,
  functionDeclarationToTool,
  messageToLlmResponse,
  normalizeFinishReason,
  partsToMessageContent,
  requestFunctionDeclarations,
  requestToMessages,
  requestToTools,
  safeJsonStringify,
  toChatRole,
} from '../../src/models/chat_completion_converters.js';
import {LlmRequest} from '../../src/models/llm_request.js';

/** Base64 of `test_image_data`, used verbatim so a re-encode is visible. */
const IMAGE_BASE64 = 'dGVzdF9pbWFnZV9kYXRh';

/** Base64 of `test_video_data`. */
const VIDEO_BASE64 = 'dGVzdF92aWRlb19kYXRh';

/** Builds the minimal request shape the converters read. */
function request(partial: Partial<LlmRequest>): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}, ...partial};
}

describe('toChatRole', () => {
  it('maps genai roles to chat-completions roles', () => {
    expect(toChatRole('model')).toBe('assistant');
    expect(toChatRole('assistant')).toBe('assistant');
    expect(toChatRole('user')).toBe('user');
    expect(toChatRole(undefined)).toBe('user');
  });
});

describe('safeJsonStringify', () => {
  it('serializes a plain object', () => {
    expect(safeJsonStringify({a: 1})).toBe('{"a":1}');
  });

  it('falls back to the string form of a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(safeJsonStringify(circular)).toBe('[object Object]');
  });

  it('falls back to the string form of a BigInt', () => {
    expect(safeJsonStringify(BigInt(7))).toBe('7');
  });

  it('renders undefined, which JSON.stringify drops', () => {
    expect(safeJsonStringify(undefined)).toBe('undefined');
  });
});

describe('partsToMessageContent', () => {
  it('returns a bare string for a lone text part', () => {
    expect(partsToMessageContent([{text: 'Test text'}])).toBe('Test text');
  });

  it('returns a block list for two text parts', () => {
    expect(partsToMessageContent([{text: 'one'}, {text: 'two'}])).toEqual([
      {type: 'text', text: 'one'},
      {type: 'text', text: 'two'},
    ]);
  });

  it('embeds image data verbatim, without re-encoding it', () => {
    const content = partsToMessageContent([
      {inlineData: {mimeType: 'image/png', data: IMAGE_BASE64}},
    ]);

    expect(content).toEqual([
      {
        type: 'image_url',
        image_url: {url: `data:image/png;base64,${IMAGE_BASE64}`},
      },
    ]);
  });

  it('embeds video data verbatim, without re-encoding it', () => {
    const content = partsToMessageContent([
      {inlineData: {mimeType: 'video/mp4', data: VIDEO_BASE64}},
    ]);

    expect(content).toEqual([
      {
        type: 'video_url',
        video_url: {url: `data:video/mp4;base64,${VIDEO_BASE64}`},
      },
    ]);
  });

  it('keeps text and image blocks together', () => {
    const content = partsToMessageContent([
      {text: 'look'},
      {inlineData: {mimeType: 'image/png', data: IMAGE_BASE64}},
    ]);

    expect(content).toEqual([
      {type: 'text', text: 'look'},
      {
        type: 'image_url',
        image_url: {url: `data:image/png;base64,${IMAGE_BASE64}`},
      },
    ]);
  });

  it('rejects an unsupported MIME type and names it', () => {
    expect(() =>
      partsToMessageContent([
        {inlineData: {mimeType: 'application/pdf', data: 'ZmFrZQ=='}},
      ]),
    ).toThrow(/application\/pdf/);
  });

  it('returns null for an empty part list', () => {
    expect(partsToMessageContent([])).toBeNull();
  });
});

describe('contentToMessage', () => {
  it('converts a user text message', () => {
    const message = contentToMessage({
      role: 'user',
      parts: [{text: 'Test prompt'}],
    });

    expect(message).toEqual({role: 'user', content: 'Test prompt'});
  });

  it('converts an assistant text message', () => {
    const message = contentToMessage({
      role: 'assistant',
      parts: [{text: 'Test response'}],
    });

    expect(message).toEqual({role: 'assistant', content: 'Test response'});
  });

  it('converts a function call to a tool call with null content', () => {
    const message = contentToMessage({
      role: 'assistant',
      parts: [
        {
          functionCall: {
            id: 'test_tool_call_id',
            name: 'test_function',
            args: {test_arg: 'test_value'},
          },
        },
      ],
    });

    expect(message).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          type: 'function',
          id: 'test_tool_call_id',
          function: {
            name: 'test_function',
            arguments: '{"test_arg":"test_value"}',
          },
        },
      ],
    });
  });

  it('serializes a function call with no arguments as an empty object', () => {
    const message = contentToMessage({
      role: 'model',
      parts: [{functionCall: {id: 'id_1', name: 'noop'}}],
    });

    expect(message.tool_calls?.[0].function.arguments).toBe('{}');
  });

  it('converts a function response to a tool message', () => {
    const message = contentToMessage({
      role: 'tool',
      parts: [
        {
          functionResponse: {
            id: 'test_tool_call_id',
            name: 'test_function',
            response: {result: 'test_result'},
          },
        },
      ],
    });

    expect(message).toEqual({
      role: 'tool',
      tool_call_id: 'test_tool_call_id',
      content: '{"result":"test_result"}',
    });
  });

  it('treats a content with no parts as empty user content', () => {
    expect(contentToMessage({role: 'user'})).toEqual({
      role: 'user',
      content: null,
    });
  });
});

describe('functionDeclarationToTool', () => {
  it('converts a function with nested object and array parameters', () => {
    const declaration: FunctionDeclaration = {
      name: 'test_function',
      description: 'Test function description',
      parameters: {
        type: Type.OBJECT,
        properties: {
          test_arg: {type: Type.STRING},
          array_arg: {type: Type.ARRAY, items: {type: Type.STRING}},
          nested_arg: {
            type: Type.OBJECT,
            properties: {
              nested_key1: {type: Type.STRING},
              nested_key2: {type: Type.STRING},
            },
          },
        },
      },
    };

    expect(functionDeclarationToTool(declaration)).toEqual({
      type: 'function',
      function: {
        name: 'test_function',
        description: 'Test function description',
        parameters: {
          type: 'object',
          properties: {
            test_arg: {type: 'string'},
            array_arg: {type: 'array', items: {type: 'string'}},
            nested_arg: {
              type: 'object',
              properties: {
                nested_key1: {type: 'string'},
                nested_key2: {type: 'string'},
              },
            },
          },
        },
      },
    });
  });

  it('defaults a missing description to an empty string', () => {
    const declaration: FunctionDeclaration = {
      name: 'test_function_no_description',
      parameters: {
        type: Type.OBJECT,
        properties: {test_arg: {type: Type.STRING}},
      },
    };

    expect(functionDeclarationToTool(declaration).function).toEqual({
      name: 'test_function_no_description',
      description: '',
      parameters: {type: 'object', properties: {test_arg: {type: 'string'}}},
    });
  });

  it('emits empty properties for a function with no parameters', () => {
    const declaration: FunctionDeclaration = {
      name: 'test_function_empty_params',
      parameters: {type: Type.OBJECT, properties: {}},
    };

    expect(functionDeclarationToTool(declaration).function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('converts an array of objects', () => {
    const declaration: FunctionDeclaration = {
      name: 'test_function_nested_array',
      parameters: {
        type: Type.OBJECT,
        properties: {
          array_arg: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {nested_key: {type: Type.STRING}},
            },
          },
        },
      },
    };

    expect(functionDeclarationToTool(declaration).function.parameters).toEqual({
      type: 'object',
      properties: {
        array_arg: {
          type: 'array',
          items: {
            type: 'object',
            properties: {nested_key: {type: 'string'}},
          },
        },
      },
    });
  });

  it('emits required when the declaration lists mandatory arguments', () => {
    const declaration: FunctionDeclaration = {
      name: 'test_function',
      parameters: {
        type: Type.OBJECT,
        properties: {test_arg: {type: Type.STRING}},
        required: ['test_arg'],
      },
    };

    expect(
      functionDeclarationToTool(declaration).function.parameters.required,
    ).toEqual(['test_arg']);
  });

  it('omits required when the list is empty or absent', () => {
    const empty: FunctionDeclaration = {
      name: 'test_function',
      parameters: {type: Type.OBJECT, properties: {}, required: []},
    };
    const absent: FunctionDeclaration = {
      name: 'test_function',
      parameters: {type: Type.OBJECT, properties: {}},
    };

    expect(
      functionDeclarationToTool(empty).function.parameters,
    ).not.toHaveProperty('required');
    expect(
      functionDeclarationToTool(absent).function.parameters,
    ).not.toHaveProperty('required');
  });

  it('defaults a missing name to an empty string', () => {
    expect(functionDeclarationToTool({}).function).toEqual({
      name: '',
      description: '',
      parameters: {type: 'object', properties: {}},
    });
  });
});

describe('requestFunctionDeclarations', () => {
  it('returns an empty list when the request declares no tools', () => {
    expect(requestFunctionDeclarations(request({}))).toEqual([]);
  });

  it('returns an empty list for a tool with no declarations', () => {
    expect(
      requestFunctionDeclarations(request({config: {tools: [{}]}})),
    ).toEqual([]);
    expect(
      requestFunctionDeclarations(
        request({config: {tools: [{functionDeclarations: undefined}]}}),
      ),
    ).toEqual([]);
  });

  it('reads the declarations of the first tool', () => {
    const declaration: FunctionDeclaration = {name: 'test_function'};

    expect(
      requestFunctionDeclarations(
        request({config: {tools: [{functionDeclarations: [declaration]}]}}),
      ),
    ).toEqual([declaration]);
  });
});

describe('requestToMessages', () => {
  it('puts the system instruction first, as a system message', () => {
    const messages = requestToMessages(
      request({
        contents: [{role: 'user', parts: [{text: 'Test prompt'}]}],
        config: {systemInstruction: 'Test system instruction'},
      }),
    );

    expect(messages).toEqual([
      {role: 'system', content: 'Test system instruction'},
      {role: 'user', content: 'Test prompt'},
    ]);
  });

  it('omits the system message when the request has no instruction', () => {
    const messages = requestToMessages(
      request({contents: [{role: 'user', parts: [{text: 'hi'}]}]}),
    );

    expect(messages).toEqual([{role: 'user', content: 'hi'}]);
  });
});

describe('requestToTools', () => {
  it('returns undefined when the request declares no functions', () => {
    expect(requestToTools(request({}))).toBeUndefined();
  });

  it('converts every declared function', () => {
    const tools = requestToTools(
      request({
        config: {tools: [{functionDeclarations: [{name: 'test_function'}]}]},
      }),
    );

    expect(tools?.[0].function.name).toBe('test_function');
  });
});

describe('messageToLlmResponse', () => {
  it('converts a text message', () => {
    const response = messageToLlmResponse({
      role: 'assistant',
      content: 'Test response',
    });

    expect(response.content?.role).toBe('model');
    expect(response.content?.parts).toEqual([{text: 'Test response'}]);
    expect(response.partial).toBe(false);
  });

  it('converts a tool-call message', () => {
    const response = messageToLlmResponse({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          type: 'function',
          id: 'test_tool_call_id',
          function: {
            name: 'test_function',
            arguments: '{"test_arg": "test_value"}',
          },
        },
      ],
    });

    expect(response.content?.parts?.[0].functionCall).toEqual({
      id: 'test_tool_call_id',
      name: 'test_function',
      args: {test_arg: 'test_value'},
    });
  });

  it('parses empty arguments as an empty object', () => {
    const response = messageToLlmResponse({
      role: 'assistant',
      content: null,
      tool_calls: [
        {type: 'function', id: 'id_1', function: {name: 'noop', arguments: ''}},
      ],
    });

    expect(response.content?.parts?.[0].functionCall?.args).toEqual({});
  });

  it('puts text before the function call when both are present', () => {
    const response = messageToLlmResponse({
      role: 'assistant',
      content: 'Test response',
      tool_calls: [
        {
          type: 'function',
          id: 'test_tool_call_id',
          function: {name: 'test_function', arguments: '{}'},
        },
      ],
    });

    expect(response.content?.parts?.[0].text).toBe('Test response');
    expect(response.content?.parts?.[1].functionCall?.name).toBe(
      'test_function',
    );
  });

  it('marks a partial response', () => {
    const response = messageToLlmResponse(
      {role: 'assistant', content: 'zero, '},
      true,
    );

    expect(response.partial).toBe(true);
  });
});

describe('normalizeFinishReason', () => {
  it('renames the Anthropic tool_use reason', () => {
    expect(normalizeFinishReason('tool_use')).toBe('tool_calls');
  });

  it('passes other reasons through', () => {
    expect(normalizeFinishReason('stop')).toBe('stop');
  });

  it('reports an absent reason as undefined', () => {
    expect(normalizeFinishReason(undefined)).toBeUndefined();
    expect(normalizeFinishReason(null)).toBeUndefined();
  });
});

describe('chunkPieces', () => {
  it('yields one text piece for a buffered message', () => {
    const chunk: ChatCompletionResponse = {
      choices: [
        {
          message: {role: 'assistant', content: 'this is a test'},
          finish_reason: 'stop',
        },
      ],
    };

    expect([...chunkPieces(chunk)]).toEqual([
      [{kind: 'text', text: 'this is a test'}, 'stop'],
    ]);
  });

  it('yields one function piece for a tool-call delta', () => {
    const chunk: ChatCompletionResponse = {
      choices: [
        {
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                type: 'function',
                id: '1',
                function: {name: 'test_function', arguments: '{"key": "va'},
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };

    expect([...chunkPieces(chunk)]).toEqual([
      [
        {kind: 'function', id: '1', name: 'test_function', args: '{"key": "va'},
        undefined,
      ],
    ]);
  });

  it('yields the finish reason alone for a terminal chunk', () => {
    const chunk: ChatCompletionResponse = {
      choices: [
        {delta: {role: 'assistant', content: null}, finish_reason: 'tool_use'},
      ],
    };

    expect([...chunkPieces(chunk)]).toEqual([[undefined, 'tool_calls']]);
  });

  it('yields an empty tuple for a choice with neither message nor delta', () => {
    expect([...chunkPieces({choices: [{}]})]).toEqual([[undefined, undefined]]);
  });

  it('yields an empty tuple for a response with no choices', () => {
    expect([...chunkPieces({})]).toEqual([[undefined, undefined]]);
    expect([...chunkPieces({choices: []})]).toEqual([[undefined, undefined]]);
  });
});
