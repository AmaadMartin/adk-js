/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MessageCreateParams,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import {
  AnthropicLlm,
  Claude,
  FunctionTool,
  LlmRequest,
  LlmResponse,
  version,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  anthropicMessage,
  anthropicUsage,
  asStream,
  blockDeltaEvent,
  blockStartEvent,
  blockStopEvent,
  messageDeltaEvent,
  messageStartEvent,
  messageStopEvent,
} from './anthropic_test_utils.js';

const {create, anthropicOptions, vertexOptions} = vi.hoisted(() => ({
  create: vi.fn(),
  anthropicOptions: vi.fn(),
  vertexOptions: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: class {
    messages = {create};
    constructor(options?: unknown) {
      anthropicOptions(options);
    }
  },
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    messages = {create};
    constructor(options?: unknown) {
      vertexOptions(options);
    }
  },
}));

const getTimeTool = new FunctionTool({
  name: 'get_time',
  description: 'Gets the time.',
  execute: () => 'now',
});

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'claude-sonnet-4-20250514',
    contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    config: {systemInstruction: 'You are helpful'},
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

async function collect(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

/** Returns the request body of the single `messages.create` call. */
function createdParams(): MessageCreateParams {
  expect(create).toHaveBeenCalledOnce();
  const params: unknown = create.mock.calls[0][0];
  if (!isMessageCreateParams(params)) {
    return expect.fail('messages.create did not receive a request body.');
  }
  return params;
}

function isMessageCreateParams(value: unknown): value is MessageCreateParams {
  return typeof value === 'object' && value !== null && 'messages' in value;
}

function isToolUseBlock(block: unknown): block is ToolUseBlockParam {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'tool_use'
  );
}

function isToolResultBlock(block: unknown): block is ToolResultBlockParam {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'tool_result'
  );
}

function blocksOf(message: MessageParam): unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  create.mockResolvedValue(
    anthropicMessage(
      [{type: 'text', text: 'Hello, how can I help you?', citations: null}],
      anthropicUsage(13, 12),
    ),
  );
});

describe('supportedModels', () => {
  it('matches the adk-python patterns', () => {
    expect(AnthropicLlm.supportedModels).toEqual([
      /claude-3-.*/,
      /claude-.*-4.*/,
    ]);
  });

  it('is inherited by Claude', () => {
    expect(Claude.supportedModels).toEqual(AnthropicLlm.supportedModels);
  });
});

describe('non-streaming generation', () => {
  it('yields one response from the direct Anthropic API', async () => {
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), false),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0].text).toBe(
      'Hello, how can I help you?',
    );
    expect(responses[0].usageMetadata?.totalTokenCount).toBe(25);
    expect(anthropicOptions).toHaveBeenCalledOnce();
  });

  it('yields one response from Vertex AI', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');
    const llm = new Claude();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), false),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0].text).toBe(
      'Hello, how can I help you?',
    );
  });

  it('omits stream from the request body', async () => {
    const llm = new AnthropicLlm();
    await collect(llm.generateContentAsync(makeRequest(), false));
    expect(createdParams()).not.toHaveProperty('stream');
  });

  it('sends the default max_tokens', async () => {
    const llm = new AnthropicLlm();
    await collect(llm.generateContentAsync(makeRequest(), false));
    expect(createdParams().max_tokens).toBe(8192);
  });

  it('sends a max_tokens override from the constructor', async () => {
    const llm = new Claude({maxTokens: 4096});
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'p');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'l');
    await collect(llm.generateContentAsync(makeRequest(), false));
    expect(createdParams().max_tokens).toBe(4096);
  });

  it('sends the system instruction', async () => {
    const llm = new AnthropicLlm();
    await collect(llm.generateContentAsync(makeRequest(), false));
    expect(createdParams().system).toBe('You are helpful');
  });

  it('forwards the abort signal as a request option', async () => {
    const llm = new AnthropicLlm();
    const controller = new AbortController();

    await collect(
      llm.generateContentAsync(makeRequest(), false, controller.signal),
    );

    expect(create.mock.calls[0][1]).toEqual({signal: controller.signal});
  });

  it('reuses one client across calls', async () => {
    const llm = new AnthropicLlm();
    await collect(llm.generateContentAsync(makeRequest(), false));
    await collect(llm.generateContentAsync(makeRequest(), false));
    expect(anthropicOptions).toHaveBeenCalledOnce();
  });
});

describe('tools', () => {
  it('sends the declared tools and lets the model choose', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {
        systemInstruction: 'You are helpful',
        tools: [
          {
            functionDeclarations: [
              {name: 'get_time', description: 'Gets the time.'},
            ],
          },
        ],
      },
      toolsDict: {get_time: getTimeTool},
    });

    await collect(llm.generateContentAsync(request, false));

    const params = createdParams();
    expect(params.tools).toEqual([
      {
        name: 'get_time',
        description: 'Gets the time.',
        input_schema: {type: 'object', properties: {}},
      },
    ]);
    expect(params.tool_choice).toEqual({type: 'auto'});
  });

  it('omits tools and tool_choice when none are declared', async () => {
    const llm = new AnthropicLlm();
    await collect(llm.generateContentAsync(makeRequest(), false));
    const params = createdParams();
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('tool_choice');
  });

  it('omits tools when the first entry declares no functions', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {tools: [{googleSearch: {}}]},
    });

    await collect(llm.generateContentAsync(request, false));

    expect(createdParams()).not.toHaveProperty('tools');
  });
});

describe('thinking', () => {
  it('sends the thinking parameter when a budget is configured', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {
        systemInstruction: 'Test',
        thinkingConfig: {thinkingBudget: 8000},
      },
    });

    await collect(llm.generateContentAsync(request, false));

    expect(createdParams().thinking).toEqual({
      type: 'enabled',
      budget_tokens: 8000,
    });
  });

  it('omits the thinking parameter when none is configured', async () => {
    const llm = new AnthropicLlm();
    await collect(llm.generateContentAsync(makeRequest(), false));
    expect(createdParams()).not.toHaveProperty('thinking');
  });
});

describe('streaming generation', () => {
  it('yields a partial per text delta then one aggregated response', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(10),
        blockStartEvent(0, {type: 'text', text: '', citations: null}),
        blockDeltaEvent(0, {type: 'text_delta', text: 'Hello '}),
        blockDeltaEvent(0, {type: 'text_delta', text: 'world!'}),
        blockStopEvent(0),
        messageDeltaEvent(5),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses).toHaveLength(3);
    expect(responses[0]).toMatchObject({
      partial: true,
      content: {parts: [{text: 'Hello '}]},
    });
    expect(responses[1]).toMatchObject({
      partial: true,
      content: {parts: [{text: 'world!'}]},
    });
    expect(responses[2].partial).toBe(false);
    expect(responses[2].content?.parts).toEqual([{text: 'Hello world!'}]);
    expect(responses[2].usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    });
    expect(createdParams().stream).toBe(true);
  });

  it('accumulates streamed tool call arguments', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(20),
        blockStartEvent(0, {type: 'text', text: '', citations: null}),
        blockDeltaEvent(0, {type: 'text_delta', text: 'Checking.'}),
        blockStopEvent(0),
        blockStartEvent(1, {
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'get_weather',
          input: {},
          caller: {type: 'direct'},
        }),
        blockDeltaEvent(1, {
          type: 'input_json_delta',
          partial_json: '{"city": ',
        }),
        blockDeltaEvent(1, {
          type: 'input_json_delta',
          partial_json: '"Paris"}',
        }),
        blockStopEvent(1),
        messageDeltaEvent(12),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses).toHaveLength(2);
    expect(responses[1].content?.parts).toEqual([
      {text: 'Checking.'},
      {
        functionCall: {
          id: 'toolu_abc',
          name: 'get_weather',
          args: {city: 'Paris'},
        },
      },
    ]);
  });

  it('defaults tool call arguments to an empty object', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(1),
        blockStartEvent(0, {
          type: 'tool_use',
          id: 'toolu_none',
          name: 'ping',
          input: {},
          caller: {type: 'direct'},
        }),
        blockStopEvent(0),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses[0].content?.parts).toEqual([
      {functionCall: {id: 'toolu_none', name: 'ping', args: {}}},
    ]);
  });

  it('starts a text block from a delta alone', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(1),
        blockDeltaEvent(0, {type: 'text_delta', text: 'lone text'}),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses[1].content?.parts).toEqual([{text: 'lone text'}]);
  });

  it('ignores an argument delta for an unknown block index', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(1),
        blockDeltaEvent(7, {type: 'input_json_delta', partial_json: '{}'}),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts).toEqual([]);
  });

  it('ignores a signature delta', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(1),
        blockStartEvent(0, {type: 'text', text: 'x', citations: null}),
        blockDeltaEvent(0, {type: 'signature_delta', signature: 'sig'}),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts).toEqual([{text: 'x'}]);
  });

  it('aggregates thinking deltas and keeps the signature', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(15),
        blockStartEvent(0, {type: 'thinking', thinking: '', signature: 'sig'}),
        blockDeltaEvent(0, {type: 'thinking_delta', thinking: 'Step 1: '}),
        blockDeltaEvent(0, {type: 'thinking_delta', thinking: 'analyze.'}),
        blockStopEvent(0),
        blockStartEvent(1, {type: 'text', text: '', citations: null}),
        blockDeltaEvent(1, {type: 'text_delta', text: 'The answer is 42.'}),
        blockStopEvent(1),
        messageDeltaEvent(10),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses).toHaveLength(4);
    expect(responses[0]).toMatchObject({
      partial: true,
      content: {parts: [{text: 'Step 1: ', thought: true}]},
    });
    expect(responses[1].content?.parts).toEqual([
      {text: 'analyze.', thought: true},
    ]);
    expect(responses[3].content?.parts).toEqual([
      {text: 'Step 1: analyze.', thought: true, thoughtSignature: 'sig'},
      {text: 'The answer is 42.'},
    ]);
    expect(responses[3].usageMetadata?.promptTokenCount).toBe(15);
    expect(responses[3].usageMetadata?.candidatesTokenCount).toBe(10);
  });

  it('starts a thinking block from a delta alone', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(1),
        blockDeltaEvent(0, {type: 'thinking_delta', thinking: 'lone'}),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses[1].content?.parts).toEqual([
      {text: 'lone', thought: true},
    ]);
  });

  it('keeps a redacted thinking block in the final response', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(8),
        blockStartEvent(0, {
          type: 'redacted_thinking',
          data: 'encrypted_blob',
        }),
        blockStopEvent(0),
        blockStartEvent(1, {type: 'text', text: '', citations: null}),
        blockDeltaEvent(1, {type: 'text_delta', text: 'Done.'}),
        blockStopEvent(1),
        messageDeltaEvent(4),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses[responses.length - 1].content?.parts).toEqual([
      {thought: true, thoughtSignature: 'encrypted_blob'},
      {text: 'Done.'},
    ]);
  });

  it('orders the final parts by block index, not by arrival', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(3),
        blockStartEvent(1, {type: 'text', text: 'second', citations: null}),
        blockStopEvent(1),
        blockStartEvent(0, {type: 'text', text: 'first', citations: null}),
        blockStopEvent(0),
        messageDeltaEvent(2),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses[0].content?.parts).toEqual([
      {text: 'first'},
      {text: 'second'},
    ]);
  });

  it('ignores a content block type it has no part for', async () => {
    create.mockResolvedValue(
      asStream([
        messageStartEvent(1),
        blockStartEvent(0, {type: 'container_upload', file_id: 'f'}),
        blockStopEvent(0),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses[0].content?.parts).toEqual([]);
  });
});

describe('tool call id pairing', () => {
  it.each<
    [string, Array<string | undefined>, Array<string | undefined>, number]
  >([
    [
      'two distinct rejected ids',
      ['bad A!', 'bad B!'],
      ['bad A!', 'bad B!'],
      2,
    ],
    ['two empty ids', [''], [''], 1],
    ['a missing id and an empty id', [undefined], [''], 1],
    ['the same rejected id twice', ['bad!'], ['bad!'], 1],
  ])('pairs %s', async (_name, callIds, responseIds, expectedUnique) => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      contents: [
        {role: 'user', parts: [{text: 'Hi'}]},
        {
          role: 'model',
          parts: callIds.map((id, i) => ({
            functionCall: {id, name: `tool_${i}`, args: {}},
          })),
        },
        {
          role: 'user',
          parts: responseIds.map((id, i) => ({
            functionResponse: {id, name: `tool_${i}`, response: {result: 'ok'}},
          })),
        },
      ],
    });

    await collect(llm.generateContentAsync(request, false));

    const messages = createdParams().messages;
    const useIds = blocksOf(messages[1])
      .filter(isToolUseBlock)
      .map((b) => b.id);
    const resultIds = blocksOf(messages[2])
      .filter(isToolResultBlock)
      .map((b) => b.tool_use_id);

    expect(new Set(useIds).size).toBe(expectedUnique);
    expect(new Set(useIds)).toEqual(new Set(resultIds));
    for (const id of useIds) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('pairs a tool result with its call when the ids arrive out of order', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      contents: [
        {
          role: 'model',
          parts: [
            {functionCall: {id: 'bad A!', name: 'tool_a', args: {}}},
            {functionCall: {id: 'bad B!', name: 'tool_b', args: {}}},
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'bad B!',
                name: 'tool_b',
                response: {result: 'ok'},
              },
            },
            {
              functionResponse: {
                id: 'bad A!',
                name: 'tool_a',
                response: {result: 'ok'},
              },
            },
          ],
        },
      ],
    });

    await collect(llm.generateContentAsync(request, false));

    const messages = createdParams().messages;
    const useIds = blocksOf(messages[0])
      .filter(isToolUseBlock)
      .map((b) => b.id);
    const resultIds = blocksOf(messages[1])
      .filter(isToolResultBlock)
      .map((b) => b.tool_use_id);

    expect(resultIds).toEqual([useIds[1], useIds[0]]);
  });
});

describe('Claude on Vertex AI', () => {
  it('reads the project and the location from the environment', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');
    const llm = new Claude({model: 'claude-3-5-sonnet-v2@20241022'});

    await collect(llm.generateContentAsync(makeRequest(), false));

    expect(vertexOptions).toHaveBeenCalledOnce();
    expect(vertexOptions.mock.calls[0][0]).toMatchObject({
      projectId: 'env-project',
      region: 'env-location',
    });
  });

  it('prefers the project and the location in the model resource name', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');
    const llm = new Claude({
      model:
        'projects/test-project/locations/test-location/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022',
    });

    await collect(llm.generateContentAsync(makeRequest(), false));

    expect(vertexOptions.mock.calls[0][0]).toMatchObject({
      projectId: 'test-project',
      region: 'test-location',
    });
  });

  it('sends the ADK tracking headers', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'p');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'l');
    const llm = new Claude();

    await collect(llm.generateContentAsync(makeRequest(), false));

    const options: unknown = vertexOptions.mock.calls[0][0];
    expect(options).toMatchObject({
      defaultHeaders: {
        'x-goog-api-client': expect.stringContaining(`google-adk/${version}`),
        'user-agent': expect.stringContaining(`google-adk/${version}`),
      },
    });
  });

  it('constructs without Vertex configuration', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    expect(() => new Claude()).not.toThrow();
  });

  it('ignores the process environment in a browser', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');
    vi.stubGlobal('window', {});
    const llm = new Claude();

    await expect(
      collect(llm.generateContentAsync(makeRequest(), false)),
    ).rejects.toThrow(/must be set for using Anthropic on Vertex/);
  });

  it('rejects generation without Vertex configuration', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    const llm = new Claude();

    await expect(
      collect(llm.generateContentAsync(makeRequest(), false)),
    ).rejects.toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
    );
  });
});

describe('model name resolution', () => {
  it.each([
    [
      'projects/p/locations/l/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022',
      'claude-3-5-sonnet-v2@20241022',
    ],
    ['projects/p/locations/l/endpoints/my-endpoint', 'my-endpoint'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4-20250514'],
  ])('sends %s as %s', async (requestModel, expected) => {
    const llm = new AnthropicLlm();
    await collect(
      llm.generateContentAsync(makeRequest({model: requestModel}), false),
    );
    expect(createdParams().model).toBe(expected);
  });

  it('falls back to the constructor model when the request names none', async () => {
    const llm = new AnthropicLlm({model: 'claude-3-haiku-20240307'});
    await collect(
      llm.generateContentAsync(makeRequest({model: undefined}), false),
    );
    expect(createdParams().model).toBe('claude-3-haiku-20240307');
  });
});

describe('connect', () => {
  it('rejects because live is unsupported', async () => {
    await expect(new AnthropicLlm().connect()).rejects.toThrow(
      /Live connections are not supported/,
    );
  });
});
