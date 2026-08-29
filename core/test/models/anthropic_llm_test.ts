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
import type {AnthropicGenerateContentConfig} from '@google/adk';
import {
  AnthropicLlm,
  Claude,
  FunctionTool,
  LlmRequest,
  LlmResponse,
  version,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import type {Mock} from 'vitest';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  partToMessageBlock,
  ToolUseIdSanitizer,
} from '../../src/models/anthropic_utils.js';
import {logger} from '../../src/utils/logger.js';

import {
  anthropicMessage,
  anthropicUsage,
  asStream,
  blockDeltaEvent,
  blockStartEvent,
  blockStopEvent,
  failingStream,
  messageDeltaEvent,
  messageStartEvent,
  messageStopEvent,
} from './anthropic_test_utils.js';

const {create, stream, anthropicOptions, vertexOptions, credentialFields} =
  vi.hoisted(() => {
    const credentialFields: {
      apiKey: string | null;
      authToken: string | null;
      credentials: object | null;
    } = {apiKey: 'test-key', authToken: null, credentials: null};
    return {
      create: vi.fn(),
      stream: vi.fn(),
      anthropicOptions: vi.fn(),
      vertexOptions: vi.fn(),
      credentialFields,
    };
  });

/** Restores the credential the mocked SDK reports by default. */
function resetCredentials(): void {
  credentialFields.apiKey = 'test-key';
  credentialFields.authToken = null;
  credentialFields.credentials = null;
}

vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: class {
    messages = {create, stream};
    apiKey = credentialFields.apiKey;
    authToken = credentialFields.authToken;
    credentials = credentialFields.credentials;
    constructor(options?: unknown) {
      anthropicOptions(options);
    }
  },
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    messages = {create, stream};
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
  return sentParams(create, 'messages.create');
}

/** Returns the request body of the single `messages.stream` call. */
function streamedParams(): MessageCreateParams {
  return sentParams(stream, 'messages.stream');
}

function sentParams(method: Mock, name: string): MessageCreateParams {
  expect(method).toHaveBeenCalledOnce();
  const params: unknown = method.mock.calls[0][0];
  if (!isMessageCreateParams(params)) {
    return expect.fail(`${name} did not receive a request body.`);
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
  resetCredentials();
  create.mockResolvedValue(
    anthropicMessage(
      [{type: 'text', text: 'Hello, how can I help you?', citations: null}],
      anthropicUsage(13, 12),
    ),
  );
});

describe('supportedModels', () => {
  it('matches the adk-python pattern', () => {
    expect(AnthropicLlm.supportedModels).toEqual([/claude-.*/]);
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

  it('omits tool_choice when toolsDict holds an undeclared tool', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({toolsDict: {get_time: getTimeTool}});

    await collect(llm.generateContentAsync(request, false));

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
    stream.mockImplementation(() =>
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
    expect(create).not.toHaveBeenCalled();
    expect(streamedParams().messages).toEqual([
      {role: 'user', content: [{type: 'text', text: 'Hi'}]},
    ]);
  });

  it('accumulates streamed tool call arguments', async () => {
    stream.mockImplementation(() =>
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
    stream.mockImplementation(() =>
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

  it('ignores a signature delta', async () => {
    stream.mockImplementation(() =>
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
    stream.mockImplementation(() =>
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

  it('keeps a redacted thinking block in the final response', async () => {
    stream.mockImplementation(() =>
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

  it('rejects a content block type it has no part for', async () => {
    stream.mockImplementation(() =>
      asStream([
        messageStartEvent(1),
        blockStartEvent(0, {type: 'container_upload', file_id: 'f'}),
        blockStopEvent(0),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    await expect(
      collect(llm.generateContentAsync(makeRequest(), true)),
    ).rejects.toThrow(
      /Unsupported Claude content block type: container_upload/,
    );
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
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION/);
  });

  it('rejects generation without Vertex configuration', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    const llm = new Claude();

    await expect(
      collect(llm.generateContentAsync(makeRequest(), false)),
    ).rejects.toThrow(
      /needs GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION to be set/,
    );
  });

  it('names the model and the direct API alternative in the error', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    const llm = new Claude({model: 'claude-3-5-sonnet-v2@20241022'});

    const failure = await collect(
      llm.generateContentAsync(makeRequest(), false),
    ).catch((error: unknown) => error);

    expect(String(failure)).toContain('claude-3-5-sonnet-v2@20241022');
    expect(String(failure)).toContain('Vertex AI');
    expect(String(failure)).toContain('ANTHROPIC_API_KEY');
    expect(String(failure)).toContain('AnthropicLlm');
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

describe('generation config', () => {
  it('prefers maxOutputTokens over the constructor budget', async () => {
    const llm = new AnthropicLlm({maxTokens: 8192});
    const request = makeRequest({config: {maxOutputTokens: 512}});

    await collect(llm.generateContentAsync(request, false));

    expect(createdParams().max_tokens).toBe(512);
  });

  it('sends the stop sequences', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({config: {stopSequences: ['STOP', 'HALT']}});

    await collect(llm.generateContentAsync(request, false));

    expect(createdParams().stop_sequences).toEqual(['STOP', 'HALT']);
  });

  it('omits the stop sequences when the list is empty', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({config: {stopSequences: []}});

    await collect(llm.generateContentAsync(request, false));

    expect(createdParams()).not.toHaveProperty('stop_sequences');
  });

  it('forwards the sampling parameters and truncates top_k', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {temperature: 0.3, topP: 0.9, topK: 40.7},
    });

    await collect(llm.generateContentAsync(request, false));

    const params = createdParams();
    expect(params.temperature).toBe(0.3);
    expect(params.top_p).toBe(0.9);
    expect(params.top_k).toBe(40);
  });

  it('omits the sampling parameters when none are set', async () => {
    const llm = new AnthropicLlm();

    await collect(llm.generateContentAsync(makeRequest(), false));

    const params = createdParams();
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
  });

  it('drops the sampling parameters when thinking is enabled', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {temperature: 0.3, thinkingConfig: {thinkingBudget: 2048}},
    });

    await collect(llm.generateContentAsync(request, false));

    expect(createdParams()).not.toHaveProperty('temperature');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Sampling parameters'),
    );
  });

  it('keeps the sampling parameters when thinking is disabled', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {temperature: 0.3, thinkingConfig: {thinkingBudget: 0}},
    });

    await collect(llm.generateContentAsync(request, false));

    expect(createdParams().temperature).toBe(0.3);
  });

  it('drops the sampling parameters when an effort is set', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const llm = new AnthropicLlm();
    const config: AnthropicGenerateContentConfig = {effort: 'xhigh', topP: 0.9};

    await collect(llm.generateContentAsync(makeRequest({config}), false));

    const params = createdParams();
    expect(params).not.toHaveProperty('top_p');
    expect(params.output_config).toEqual({effort: 'xhigh'});
    expect(params).not.toHaveProperty('thinking');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Sampling parameters'),
    );
  });

  it('omits output_config when no effort is set', async () => {
    const llm = new AnthropicLlm();

    await collect(llm.generateContentAsync(makeRequest(), false));

    expect(createdParams()).not.toHaveProperty('output_config');
  });

  it('sends adaptive thinking for a negative budget', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {thinkingConfig: {thinkingBudget: -1}},
    });

    await collect(llm.generateContentAsync(request, false));

    const params = createdParams();
    expect(params.thinking).toEqual({type: 'adaptive'});
    expect(params).not.toHaveProperty('output_config');
  });
});

describe('tools from every entry', () => {
  it('collects the declarations of all the tool entries', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {
        tools: [
          {googleSearch: {}},
          {functionDeclarations: [{name: 'first', description: 'One.'}]},
          {functionDeclarations: [{name: 'second', description: 'Two.'}]},
        ],
      },
    });

    await collect(llm.generateContentAsync(request, false));

    const names = (createdParams().tools ?? []).map((tool) =>
      'name' in tool ? tool.name : undefined,
    );
    expect(names).toEqual(['first', 'second']);
  });
});

describe('finish reason', () => {
  it('maps the stop reason of a complete message', async () => {
    create.mockResolvedValue(
      anthropicMessage(
        [{type: 'text', text: 'Cut short.', citations: null}],
        anthropicUsage(1, 1),
        'max_tokens',
      ),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), false),
    );

    expect(responses[0].finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('takes the streamed stop reason from the message delta', async () => {
    stream.mockImplementation(() =>
      asStream([
        messageStartEvent(5),
        blockStartEvent(0, {type: 'text', text: '', citations: null}),
        blockDeltaEvent(0, {type: 'text_delta', text: 'Hi'}),
        blockStopEvent(0),
        messageDeltaEvent(3, 'refusal'),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses.at(-1)?.finishReason).toBe(FinishReason.SAFETY);
  });

  it('omits the finish reason when the stream reports none', async () => {
    stream.mockImplementation(() =>
      asStream([
        messageStartEvent(5),
        blockStartEvent(0, {type: 'text', text: '', citations: null}),
        blockDeltaEvent(0, {type: 'text_delta', text: 'Hi'}),
        blockStopEvent(0),
        messageDeltaEvent(3, null),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses.at(-1)?.finishReason).toBeUndefined();
  });
});

describe('streamed usage metadata', () => {
  it('folds the cache tokens the stream reports into the prompt count', async () => {
    stream.mockImplementation(() =>
      asStream([
        {
          type: 'message_start',
          message: anthropicMessage(
            [],
            anthropicUsage(10, 0, {cache_read_input_tokens: 4}),
          ),
        },
        messageDeltaEvent(6),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses.at(-1)?.usageMetadata).toEqual({
      promptTokenCount: 14,
      candidatesTokenCount: 6,
      totalTokenCount: 20,
      cachedContentTokenCount: 4,
    });
  });

  it('splits the thinking tokens the message delta reports', async () => {
    stream.mockImplementation(() =>
      asStream([
        messageStartEvent(10),
        messageDeltaEvent(20, 'end_turn', {
          output_tokens_details: {thinking_tokens: 8},
        }),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses.at(-1)?.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 12,
      totalTokenCount: 30,
      thoughtsTokenCount: 8,
    });
  });

  it('keeps the prompt count the message start reported', async () => {
    stream.mockImplementation(() =>
      asStream([
        messageStartEvent(11),
        messageDeltaEvent(7),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses.at(-1)?.usageMetadata?.promptTokenCount).toBe(11);
  });
});

describe('rate limiting', () => {
  it('adds the mitigation link to a 429 on the non-streaming path', async () => {
    const original = Object.assign(new Error('Too many requests'), {
      status: 429,
    });
    create.mockRejectedValue(original);
    const llm = new AnthropicLlm();

    const failure = await collect(
      llm.generateContentAsync(makeRequest(), false),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      return expect.fail('generation did not reject.');
    }
    expect(failure.message).toContain(
      'https://docs.anthropic.com/en/api/errors#http-errors',
    );
    expect(failure.message).toContain('Too many requests');
    expect(failure).toBe(original);
  });

  it('keeps the retry fields the SDK error carries on a 429', async () => {
    const original = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: {'retry-after': '30'},
    });
    create.mockRejectedValue(original);
    const llm = new AnthropicLlm();

    const failure = await collect(
      llm.generateContentAsync(makeRequest(), false),
    ).catch((error: unknown) => error);

    if (!(failure instanceof Error) || !('status' in failure)) {
      return expect.fail('the rate-limit error lost its status.');
    }
    expect(failure.status).toBe(429);
    expect(failure).toHaveProperty('headers', {'retry-after': '30'});
  });

  it('adds the mitigation link to a 429 raised mid-stream', async () => {
    stream.mockReturnValue(
      failingStream(Object.assign(new Error('Slow down'), {status: 429})),
    );
    const llm = new AnthropicLlm();

    const failure = await collect(
      llm.generateContentAsync(makeRequest(), true),
    ).catch((error: unknown) => error);

    expect(String(failure)).toContain(
      'https://docs.anthropic.com/en/api/errors#http-errors',
    );
  });

  it('propagates a non-429 error unchanged', async () => {
    const original = Object.assign(new Error('Server error'), {status: 500});
    create.mockRejectedValue(original);
    const llm = new AnthropicLlm();

    const failure = await collect(
      llm.generateContentAsync(makeRequest(), false),
    ).catch((error: unknown) => error);

    expect(failure).toBe(original);
  });

  it('describes a rejection that is not an object', async () => {
    create.mockRejectedValue('plain failure');
    const llm = new AnthropicLlm();

    const failure = await collect(
      llm.generateContentAsync(makeRequest(), false),
    ).catch((error: unknown) => error);

    expect(failure).toBe('plain failure');
  });

  it('describes a 429 that carries no message', async () => {
    create.mockRejectedValue({status: 429});
    const llm = new AnthropicLlm();

    const failure = await collect(
      llm.generateContentAsync(makeRequest(), false),
    ).catch((error: unknown) => error);

    expect(String(failure)).toContain('[object Object]');
  });
});

describe('Anthropic API credentials', () => {
  it('rejects when the SDK resolves no credential', async () => {
    credentialFields.apiKey = null;
    const llm = new AnthropicLlm();

    await expect(
      collect(llm.generateContentAsync(makeRequest(), false)),
    ).rejects.toThrow(/export ANTHROPIC_API_KEY=/);
  });

  it.each(['authToken', 'credentials'] as const)(
    'accepts a client that resolved only %s',
    async (field) => {
      credentialFields.apiKey = null;
      if (field === 'authToken') {
        credentialFields.authToken = 'token';
      } else {
        credentialFields.credentials = {};
      }
      const llm = new AnthropicLlm();

      const responses = await collect(
        llm.generateContentAsync(makeRequest(), false),
      );

      expect(responses).toHaveLength(1);
    },
  );

  it('skips credential resolution for an injected client', async () => {
    credentialFields.apiKey = null;
    const llm = new AnthropicLlm({client: {messages: {create, stream}}});

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), false),
    );

    expect(responses).toHaveLength(1);
    expect(anthropicOptions).not.toHaveBeenCalled();
  });

  it('lets Claude take an injected client without Vertex configuration', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    const llm = new Claude({client: {messages: {create, stream}}});

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), false),
    );

    expect(responses).toHaveLength(1);
    expect(vertexOptions).not.toHaveBeenCalled();
  });

  it('builds the client only when a request is sent', async () => {
    const llm = new AnthropicLlm();
    expect(anthropicOptions).not.toHaveBeenCalled();

    await collect(llm.generateContentAsync(makeRequest(), false));

    expect(anthropicOptions).toHaveBeenCalledOnce();
  });
});

describe('streamed thinking signature', () => {
  /** Builds the event sequence Claude really sends for a signed thinking block. */
  function signedThinkingStream(...signatures: string[]) {
    return asStream([
      messageStartEvent(5),
      blockStartEvent(0, {type: 'thinking', thinking: '', signature: ''}),
      blockDeltaEvent(0, {type: 'thinking_delta', thinking: 'Weighing it.'}),
      ...signatures.map((signature) =>
        blockDeltaEvent(0, {type: 'signature_delta', signature}),
      ),
      blockStopEvent(0),
      messageDeltaEvent(4),
      messageStopEvent(),
    ]);
  }

  it('keeps a signature that arrives as a delta, not in the block start', async () => {
    stream.mockImplementation(() => signedThinkingStream('sig_from_delta'));
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses.at(-1)?.content?.parts).toEqual([
      {
        text: 'Weighing it.',
        thought: true,
        thoughtSignature: 'sig_from_delta',
      },
    ]);
  });

  it('emits no partial for the signature delta', async () => {
    stream.mockImplementation(() => signedThinkingStream('sig_from_delta'));
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    const partials = responses.filter((response) => response.partial);
    expect(partials).toHaveLength(1);
    expect(partials[0].content?.parts).toEqual([
      {text: 'Weighing it.', thought: true},
    ]);
  });

  it('round-trips the streamed thinking block back to Claude', async () => {
    stream.mockImplementation(() => signedThinkingStream('sig_from_delta'));
    const llm = new AnthropicLlm();
    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );
    const thought = responses.at(-1)?.content?.parts?.[0];
    if (thought === undefined) {
      return expect.fail('the stream produced no thinking part.');
    }

    expect(partToMessageBlock(thought, new ToolUseIdSanitizer())).toEqual({
      type: 'thinking',
      thinking: 'Weighing it.',
      signature: 'sig_from_delta',
    });
  });
});

describe('streamed stop reason', () => {
  it('maps the reason the closing delta reports', async () => {
    stream.mockImplementation(() =>
      asStream([
        messageStartEvent(5),
        messageDeltaEvent(3, 'max_tokens'),
        messageStopEvent(),
      ]),
    );
    const llm = new AnthropicLlm();

    const responses = await collect(
      llm.generateContentAsync(makeRequest(), true),
    );

    expect(responses.at(-1)?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });
});

describe('system instruction', () => {
  it('omits system when the instruction flattens to nothing', async () => {
    const llm = new AnthropicLlm();
    const request = makeRequest({
      config: {systemInstruction: {role: 'user', parts: []}},
    });

    await collect(llm.generateContentAsync(request, false));

    expect(createdParams()).not.toHaveProperty('system');
  });
});

describe('streamed citations', () => {
  it('ignores a citations delta', async () => {
    stream.mockImplementation(() =>
      asStream([
        messageStartEvent(1),
        blockStartEvent(0, {type: 'text', text: 'x', citations: null}),
        blockDeltaEvent(0, {
          type: 'citations_delta',
          citation: {
            type: 'char_location',
            cited_text: 'quoted',
            document_index: 0,
            document_title: null,
            file_id: null,
            start_char_index: 0,
            end_char_index: 6,
          },
        }),
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
});
