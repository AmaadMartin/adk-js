/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Anthropic from '@anthropic-ai/sdk';
import {FinishReason, Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  Claude,
  contentBlockToPart,
  contentToMessageParam,
  functionDeclarationToToolParam,
  MAX_TOKEN,
  messageToGenerateContentResponse,
  partToMessageBlock,
  toClaudeRole,
  toGoogleGenaiFinishReason,
} from '../../src/models/anthropic_llm.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {BaseTool} from '../../src/tools/base_tool.js';

const {mockCreate, mockConstructor} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockConstructor: vi.fn(),
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    messages = {create: mockCreate};
    constructor(opts: unknown) {
      mockConstructor(opts);
    }
  },
}));

function createMessage(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-v2@20241022',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message;
}

function createRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

describe('toClaudeRole', () => {
  it('maps model and assistant to assistant', () => {
    expect(toClaudeRole('model')).toBe('assistant');
    expect(toClaudeRole('assistant')).toBe('assistant');
  });

  it('maps any other role to user', () => {
    expect(toClaudeRole('user')).toBe('user');
    expect(toClaudeRole(undefined)).toBe('user');
  });
});

describe('toGoogleGenaiFinishReason', () => {
  it('maps terminal stop reasons to STOP', () => {
    for (const reason of ['end_turn', 'stop_sequence', 'tool_use']) {
      expect(toGoogleGenaiFinishReason(reason)).toBe(FinishReason.STOP);
    }
  });

  it('maps max_tokens to MAX_TOKENS', () => {
    expect(toGoogleGenaiFinishReason('max_tokens')).toBe(
      FinishReason.MAX_TOKENS,
    );
  });

  it('maps unknown reasons to FINISH_REASON_UNSPECIFIED', () => {
    expect(toGoogleGenaiFinishReason('refusal')).toBe(
      FinishReason.FINISH_REASON_UNSPECIFIED,
    );
    expect(toGoogleGenaiFinishReason(null)).toBe(
      FinishReason.FINISH_REASON_UNSPECIFIED,
    );
  });
});

describe('partToMessageBlock', () => {
  it('converts a text part', () => {
    expect(partToMessageBlock({text: 'hi'})).toEqual({
      text: 'hi',
      type: 'text',
    });
  });

  it('converts a function call part', () => {
    expect(
      partToMessageBlock({
        functionCall: {id: 'call_1', name: 'get_weather', args: {city: 'X'}},
      }),
    ).toEqual({
      id: 'call_1',
      name: 'get_weather',
      input: {city: 'X'},
      type: 'tool_use',
    });
  });

  it('defaults a missing function call id to an empty string', () => {
    expect(
      partToMessageBlock({functionCall: {name: 'get_weather', args: {}}}),
    ).toMatchObject({id: ''});
  });

  it('throws for a function call without a name', () => {
    expect(() => partToMessageBlock({functionCall: {args: {}}})).toThrow();
  });

  it('serializes a structured function response result', () => {
    expect(
      partToMessageBlock({
        functionResponse: {
          id: 'call_1',
          name: 'get_weather',
          response: {result: [{temp: 20}]},
        },
      }),
    ).toEqual({
      tool_use_id: 'call_1',
      type: 'tool_result',
      content: '[{"temp":20}]',
      is_error: false,
    });
  });

  it('keeps a string function response result as is', () => {
    expect(
      partToMessageBlock({
        functionResponse: {name: 'f', response: {result: 'sunny'}},
      }),
    ).toMatchObject({content: 'sunny', tool_use_id: ''});
  });

  it('uses empty content when the function response has no result', () => {
    expect(
      partToMessageBlock({
        functionResponse: {name: 'f', response: {other: 'value'}},
      }),
    ).toMatchObject({content: ''});
  });

  it('throws for unsupported parts', () => {
    expect(() =>
      partToMessageBlock({inlineData: {mimeType: 'image/png', data: ''}}),
    ).toThrow('Not supported yet.');
  });
});

describe('contentToMessageParam', () => {
  it('converts role and every part', () => {
    expect(
      contentToMessageParam({
        role: 'model',
        parts: [{text: 'a'}, {text: 'b'}],
      }),
    ).toEqual({
      role: 'assistant',
      content: [
        {text: 'a', type: 'text'},
        {text: 'b', type: 'text'},
      ],
    });
  });

  it('handles content without parts', () => {
    expect(contentToMessageParam({role: 'user'})).toEqual({
      role: 'user',
      content: [],
    });
  });
});

describe('contentBlockToPart', () => {
  it('converts a text block', () => {
    expect(
      contentBlockToPart({
        type: 'text',
        text: 'hi',
        citations: null,
      } as Anthropic.TextBlock),
    ).toEqual({text: 'hi'});
  });

  it('converts a tool use block with its id', () => {
    expect(
      contentBlockToPart({
        type: 'tool_use',
        id: 'toolu_1',
        name: 'get_weather',
        input: {city: 'X'},
      } as Anthropic.ToolUseBlock),
    ).toEqual({
      functionCall: {id: 'toolu_1', name: 'get_weather', args: {city: 'X'}},
    });
  });

  it('throws for a tool use block whose input is not an object', () => {
    expect(() =>
      contentBlockToPart({
        type: 'tool_use',
        id: 'toolu_1',
        name: 'f',
        input: 'text',
      } as Anthropic.ToolUseBlock),
    ).toThrow();
  });

  it('throws for unsupported blocks', () => {
    expect(() =>
      contentBlockToPart({
        type: 'thinking',
        thinking: '',
        signature: '',
      } as Anthropic.ThinkingBlock),
    ).toThrow('Not supported yet.');
  });
});

describe('messageToGenerateContentResponse', () => {
  it('wraps content blocks in a model content', () => {
    const response = messageToGenerateContentResponse(
      createMessage([
        {type: 'text', text: 'hi', citations: null} as Anthropic.TextBlock,
      ]),
    );
    expect(response).toEqual({
      content: {role: 'model', parts: [{text: 'hi'}]},
    });
  });
});

describe('functionDeclarationToToolParam', () => {
  it('lowercases top-level property types', () => {
    expect(
      functionDeclarationToToolParam({
        name: 'get_weather',
        description: 'Gets the weather.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            city: {type: Type.STRING, description: 'The city.'},
          },
        },
      }),
    ).toEqual({
      name: 'get_weather',
      description: 'Gets the weather.',
      input_schema: {
        type: 'object',
        properties: {city: {type: 'string', description: 'The city.'}},
      },
    });
  });

  it('handles a declaration without parameters or description', () => {
    expect(functionDeclarationToToolParam({name: 'noop'})).toEqual({
      name: 'noop',
      description: '',
      input_schema: {type: 'object', properties: {}},
    });
  });

  it('throws for a declaration without a name', () => {
    expect(() => functionDeclarationToToolParam({})).toThrow();
  });
});

describe('Claude', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-east5');
    mockCreate.mockReset();
    mockConstructor.mockReset();
    mockCreate.mockResolvedValue(
      createMessage([
        {type: 'text', text: 'hi', citations: null} as Anthropic.TextBlock,
      ]),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the default model', () => {
    expect(new Claude().model).toBe('claude-3-5-sonnet-v2@20241022');
  });

  it('supports claude-3 model names', () => {
    const [pattern] = Claude.supportedModels;
    expect(pattern).toBeInstanceOf(RegExp);
    expect((pattern as RegExp).test('claude-3-5-sonnet-v2@20241022')).toBe(
      true,
    );
    expect((pattern as RegExp).test('gemini-2.5-flash')).toBe(false);
  });

  it('creates the Vertex client from environment variables', async () => {
    const llm = new Claude();
    await llm.generateContentAsync(createRequest()).next();
    expect(mockConstructor).toHaveBeenCalledWith({
      projectId: 'test-project',
      region: 'us-east5',
    });
  });

  it('throws when the Vertex environment variables are missing', async () => {
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
    const llm = new Claude();
    await expect(
      llm.generateContentAsync(createRequest()).next(),
    ).rejects.toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set',
    );
  });

  it('throws when GOOGLE_CLOUD_PROJECT is missing', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    const llm = new Claude();
    await expect(
      llm.generateContentAsync(createRequest()).next(),
    ).rejects.toThrow('GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION');
  });

  it('sends a request without tools and yields the converted response', async () => {
    const llm = new Claude();
    const responses: LlmResponse[] = [];
    for await (const response of llm.generateContentAsync(
      createRequest({
        model: 'claude-3-opus@20240229',
        config: {systemInstruction: 'be brief'},
      }),
    )) {
      responses.push(response);
    }

    expect(responses).toEqual([
      {content: {role: 'model', parts: [{text: 'hi'}]}},
    ]);
    expect(mockCreate).toHaveBeenCalledWith(
      {
        model: 'claude-3-opus@20240229',
        system: 'be brief',
        messages: [{role: 'user', content: [{text: 'hello', type: 'text'}]}],
        tools: undefined,
        tool_choice: undefined,
        max_tokens: MAX_TOKEN,
      },
      {signal: undefined},
    );
  });

  it('falls back to the instance model when the request has none', async () => {
    const llm = new Claude({model: 'claude-3-haiku@20240307'});
    await llm.generateContentAsync(createRequest()).next();
    expect(mockCreate.mock.calls[0][0].model).toBe('claude-3-haiku@20240307');
  });

  it('sends no system prompt when the request has no system instruction', async () => {
    const llm = new Claude();
    await llm.generateContentAsync(createRequest()).next();
    expect(mockCreate.mock.calls[0][0].system).toBeUndefined();
  });

  it('sends the text of a content system instruction', async () => {
    const llm = new Claude();
    await llm
      .generateContentAsync(
        createRequest({
          config: {systemInstruction: {parts: [{text: 'a'}, {text: 'b'}]}},
        }),
      )
      .next();
    expect(mockCreate.mock.calls[0][0].system).toBe('a\nb');
  });

  it('sends tools and auto tool choice when tools are present', async () => {
    const llm = new Claude();
    await llm
      .generateContentAsync(
        createRequest({
          config: {
            tools: [{functionDeclarations: [{name: 'get_weather'}]}],
          },
          toolsDict: {get_weather: {} as BaseTool},
        }),
      )
      .next();

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toEqual([
      {
        name: 'get_weather',
        description: '',
        input_schema: {type: 'object', properties: {}},
      },
    ]);
    expect(params.tool_choice).toEqual({
      type: 'auto',
      disable_parallel_tool_use: true,
    });
  });

  it('forwards the abort signal to the client', async () => {
    const controller = new AbortController();
    const llm = new Claude();
    await llm
      .generateContentAsync(createRequest(), false, controller.signal)
      .next();
    expect(mockCreate.mock.calls[0][1]).toEqual({signal: controller.signal});
  });

  it('rejects live connections', async () => {
    await expect(new Claude().connect(createRequest())).rejects.toThrow(
      'Live connection is not supported',
    );
  });
});
