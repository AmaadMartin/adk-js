/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {
  AnthropicClient,
  AnthropicCredentialError,
  AnthropicGenerateContentConfig,
  AnthropicLlm,
  AnthropicMessages,
  AnthropicRateLimitError,
  AnthropicRequestOptions,
  Claude,
  ContextCacheConfig,
  FunctionTool,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {FinishReason, ThinkingLevel} from '@google/genai';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {getClientLabels} from '../../src/utils/client_labels.js';
import {logger} from '../../src/utils/logger.js';

/**
 * Records how {@link Claude} constructs its Vertex client.
 *
 * The real `AnthropicVertex` would need Google Cloud credentials to make a
 * request, so the package is replaced with a double that answers from a canned
 * message and keeps the options it was built with.
 */
const vertexSdk = vi.hoisted(() => ({
  constructorOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    readonly region: string;
    readonly projectId: string | null;
    readonly messages = {create: async () => message()};

    constructor(options: Record<string, unknown>) {
      vertexSdk.constructorOptions.push(options);
      this.region = String(options['region']);
      this.projectId = String(options['projectId']);
    }
  },
}));

type StreamEvent = Anthropic.RawMessageStreamEvent;

/** What one `messages.create` call was given. */
interface RecordedCall {
  params: Anthropic.MessageCreateParams;
  options?: AnthropicRequestOptions;
}

/**
 * A client that answers from a scripted response and records every call.
 *
 * `messages.create` is overloaded in the SDK, so the fake declares the same
 * overloads and implements them once.
 */
class FakeAnthropicClient implements AnthropicClient, AnthropicMessages {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly answer: Anthropic.Message | StreamEvent[] | Error,
  ) {}

  get messages(): AnthropicMessages {
    return this;
  }

  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: AnthropicRequestOptions,
  ): Promise<Anthropic.Message>;
  create(
    params: Anthropic.MessageCreateParamsStreaming,
    options?: AnthropicRequestOptions,
  ): Promise<AsyncIterable<StreamEvent>>;
  async create(
    params: Anthropic.MessageCreateParams,
    options?: AnthropicRequestOptions,
  ): Promise<Anthropic.Message | AsyncIterable<StreamEvent>> {
    this.calls.push({params, options});
    if (this.answer instanceof Error) {
      throw this.answer;
    }
    return Array.isArray(this.answer)
      ? toAsyncIterable(this.answer)
      : this.answer;
  }

  /** The parameters of the single call the test made. */
  get lastParams(): Anthropic.MessageCreateParams {
    expect(this.calls).toHaveLength(1);
    return this.calls[0].params;
  }
}

/** A Vertex-flavoured fake, which carries a project and a region. */
class FakeVertexClient extends FakeAnthropicClient {
  readonly region = 'us-east5';
  readonly projectId: string | null = 'test-project';
}

async function* toAsyncIterable(
  events: StreamEvent[],
): AsyncIterable<StreamEvent> {
  for (const event of events) {
    yield event;
  }
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
    content: [{type: 'text', text: 'Hello, world!', citations: null}],
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

function messageStart(
  usageOverrides: Partial<Anthropic.Usage> = {},
): StreamEvent {
  return {
    type: 'message_start',
    message: message({usage: usage(usageOverrides)}),
  };
}

function messageDelta(
  stopReason: Anthropic.StopReason | null,
  outputTokens = 20,
  thinkingTokens?: number,
): StreamEvent {
  return {
    type: 'message_delta',
    delta: {
      container: null,
      stop_details: null,
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      input_tokens: null,
      output_tokens: outputTokens,
      output_tokens_details:
        thinkingTokens === undefined ? null : {thinking_tokens: thinkingTokens},
      server_tool_use: null,
    },
  };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'claude-sonnet-4-20250514',
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

async function collect(
  llm: AnthropicLlm,
  llmRequest: LlmRequest,
  stream = false,
  abortSignal?: AbortSignal,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(
    llmRequest,
    stream,
    abortSignal,
  )) {
    responses.push(response);
  }
  return responses;
}

/**
 * Intercepts the SDK's outbound HTTP call and answers with a canned message,
 * so the real client can be exercised without reaching Anthropic.
 */
function stubAnthropicFetch() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(message()), {
      status: 200,
      headers: {'content-type': 'application/json'},
    }),
  );
}

/** Writes a signed-in Anthropic profile, the on-disk credential source. */
function writeAnthropicProfile(configDir: string): void {
  mkdirSync(join(configDir, 'configs'), {recursive: true});
  mkdirSync(join(configDir, 'credentials'), {recursive: true});
  writeFileSync(
    join(configDir, 'configs', 'default.json'),
    JSON.stringify({
      version: '1.0',
      authentication: {type: 'user_oauth', client_id: ''},
    }),
  );
  writeFileSync(
    join(configDir, 'credentials', 'default.json'),
    JSON.stringify({
      version: '1.0',
      type: 'oauth_token',
      access_token: 'profile-access-token',
    }),
    // The SDK refuses to read a credentials file other users can read.
    {mode: 0o600},
  );
}

/**
 * Removes the named environment variables and returns a restore function.
 *
 * Only these keys are touched. Replacing `process.env` wholesale would swap
 * Node's case-insensitive Windows environment for a plain object, which then
 * breaks any test that spawns a child process.
 */
function withoutEnv(...names: string[]): () => void {
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

/** An error shaped like the SDK's `RateLimitError`, which carries a status. */
function rateLimitError(): Error {
  return Object.assign(new Error('Rate limit exceeded, please slow down.'), {
    status: 429,
  });
}

describe('AnthropicLlm registration', () => {
  it('serves every claude model name', () => {
    expect(Claude.supportedModels).toEqual([/claude-.*/]);
  });

  it('resolves a claude model name to Claude, not AnthropicLlm', () => {
    expect(LLMRegistry.resolve('claude-3-5-sonnet-v2@20241022')).toBe(Claude);
  });

  it('defaults each class to its own model', () => {
    expect(new AnthropicLlm().model).toBe('claude-sonnet-4-20250514');
    expect(new Claude().model).toBe('claude-3-5-sonnet-v2@20241022');
  });
});

describe('AnthropicLlm connect', () => {
  it('refuses a live connection', async () => {
    const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});

    await expect(llm.connect(request())).rejects.toThrowError(
      'Live connection is not supported for claude-sonnet-4-20250514.',
    );
  });
});

describe('AnthropicLlm non-streaming', () => {
  it('returns the model text', async () => {
    const client = new FakeAnthropicClient(message());
    const llm = new AnthropicLlm({client});

    const responses = await collect(llm, request());

    expect(responses).toHaveLength(1);
    expect(responses[0].content).toEqual({
      role: 'model',
      parts: [{text: 'Hello, world!'}],
    });
    expect(responses[0].usageMetadata?.promptTokenCount).toBe(10);
  });

  it('does not pass a stream parameter', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(new AnthropicLlm({client}), request());

    expect(client.lastParams).not.toHaveProperty('stream');
  });

  it('sends the conversation and the resolved model name', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(new AnthropicLlm({client}), request());

    expect(client.lastParams.model).toBe('claude-sonnet-4-20250514');
    expect(client.lastParams.messages).toEqual([
      {role: 'user', content: [{type: 'text', text: 'Hello'}]},
    ]);
  });

  it('falls back to the instance model when the request sets none', async () => {
    const client = new FakeAnthropicClient(message());
    const llm = new AnthropicLlm({client, model: 'claude-opus-4-20250514'});

    await collect(llm, request({model: undefined}));

    expect(client.lastParams.model).toBe('claude-opus-4-20250514');
  });

  it('extracts the model id from a Vertex resource name', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({
        model:
          'projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4@20250514',
      }),
    );

    expect(client.lastParams.model).toBe('claude-opus-4@20250514');
  });

  it('extracts the model id from a Vertex endpoint resource name', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({model: 'projects/p/locations/us-east5/endpoints/my-endpoint'}),
    );

    expect(client.lastParams.model).toBe('my-endpoint');
  });

  it('keeps an unrecognised resource name unchanged', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({model: 'projects/p/datasets/d'}),
    );

    expect(client.lastParams.model).toBe('projects/p/datasets/d');
  });

  it('sends the system instruction', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({config: {systemInstruction: 'You are helpful.'}}),
    );

    expect(client.lastParams.system).toBe('You are helpful.');
  });

  it('omits the system key when there is no system instruction', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(new AnthropicLlm({client}), request());

    expect(client.lastParams).not.toHaveProperty('system');
  });

  it('collects the declarations of every configured tool', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({
        config: {
          tools: [
            {functionDeclarations: [{name: 'first', description: 'First.'}]},
            {
              functionDeclarations: [
                {name: 'second', description: 'Second.'},
                {name: 'third', description: 'Third.'},
              ],
            },
            {googleSearch: {}},
          ],
        },
      }),
    );

    expect(client.lastParams.tools).toEqual([
      {
        name: 'first',
        description: 'First.',
        input_schema: {type: 'object', properties: {}},
      },
      {
        name: 'second',
        description: 'Second.',
        input_schema: {type: 'object', properties: {}},
      },
      {
        name: 'third',
        description: 'Third.',
        input_schema: {type: 'object', properties: {}},
      },
    ]);
  });

  it('omits the tools key when no tool is configured', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(new AnthropicLlm({client}), request());

    expect(client.lastParams).not.toHaveProperty('tools');
    expect(client.lastParams).not.toHaveProperty('tool_choice');
  });

  it('asks for automatic tool choice when the request has tools', async () => {
    const client = new FakeAnthropicClient(message());
    const search = new FunctionTool({
      name: 'search',
      description: 'Searches.',
      execute: async () => ({result: 'ok'}),
    });

    await collect(new AnthropicLlm({client}), request({toolsDict: {search}}));

    expect(client.lastParams.tool_choice).toEqual({type: 'auto'});
  });

  it('honours maxOutputTokens from the request', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client, maxTokens: 8192}),
      request({config: {maxOutputTokens: 4096}}),
    );

    expect(client.lastParams.max_tokens).toBe(4096);
  });

  it('falls back to the instance max tokens', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(new AnthropicLlm({client, maxTokens: 1234}), request());

    expect(client.lastParams.max_tokens).toBe(1234);
  });

  it('defaults max tokens to 8192', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(new AnthropicLlm({client}), request());

    expect(client.lastParams.max_tokens).toBe(8192);
  });

  it('passes the sampling parameters and stop sequences through', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({
        config: {
          temperature: 0.5,
          topP: 0.9,
          topK: 40.7,
          stopSequences: ['STOP'],
        },
      }),
    );

    expect(client.lastParams).toMatchObject({
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['STOP'],
    });
  });

  it('omits the sampling parameters the request left unset', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({config: {temperature: 0.5}}),
    );

    expect(client.lastParams).not.toHaveProperty('top_p');
    expect(client.lastParams).not.toHaveProperty('top_k');
    expect(client.lastParams).not.toHaveProperty('stop_sequences');
  });

  it('sets the finish reason from the stop reason', async () => {
    const client = new FakeAnthropicClient(
      message({stop_reason: 'max_tokens'}),
    );

    const responses = await collect(new AnthropicLlm({client}), request());

    expect(responses[0].finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('passes the abort signal to the client', async () => {
    const client = new FakeAnthropicClient(message());
    const controller = new AbortController();

    await collect(
      new AnthropicLlm({client}),
      request(),
      false,
      controller.signal,
    );

    expect(client.calls[0].options?.signal).toBe(controller.signal);
  });

  it('reuses one client across requests', async () => {
    const client = new FakeAnthropicClient(message());
    const llm = new AnthropicLlm({client});

    await collect(llm, request());
    await collect(llm, request());

    expect(client.calls).toHaveLength(2);
  });

  it('pairs invalid tool ids across a whole conversation', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({
        contents: [
          {role: 'user', parts: [{text: 'Search'}]},
          {
            role: 'model',
            parts: [{functionCall: {id: 'bad id!', name: 'search'}}],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'bad id!',
                  name: 'search',
                  response: {result: 'ok'},
                },
              },
            ],
          },
        ],
      }),
    );

    const messages = client.lastParams.messages;
    const call = messages[1].content[0];
    const answer = messages[2].content[0];
    if (
      typeof call === 'string' ||
      typeof answer === 'string' ||
      call.type !== 'tool_use' ||
      answer.type !== 'tool_result'
    ) {
      return expect.fail('expected a tool_use and a tool_result block');
    }

    expect(call.id).toBe('toolu_fallback_0');
    expect(answer.tool_use_id).toBe('toolu_fallback_0');
  });
});

describe('AnthropicLlm thinking and effort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the thinking parameter', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({config: {thinkingConfig: {thinkingBudget: 2048}}}),
    );

    expect(client.lastParams.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    });
  });

  it('omits the thinking parameter without a thinking config', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(new AnthropicLlm({client}), request());

    expect(client.lastParams).not.toHaveProperty('thinking');
    expect(client.lastParams).not.toHaveProperty('output_config');
  });

  it('sends the effort as output_config', async () => {
    const client = new FakeAnthropicClient(message());
    const config: AnthropicGenerateContentConfig = {effort: 'xhigh'};

    await collect(new AnthropicLlm({client}), request({config}));

    expect(client.lastParams.output_config).toEqual({effort: 'xhigh'});
    expect(client.lastParams).not.toHaveProperty('thinking');
  });

  it('warns and ignores a standard thinkingLevel', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({
        config: {
          thinkingConfig: {
            thinkingBudget: -1,
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
        },
      }),
    );

    expect(client.lastParams.thinking).toEqual({type: 'adaptive'});
    expect(client.lastParams).not.toHaveProperty('output_config');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects an effort combined with a thinkingLevel', async () => {
    const client = new FakeAnthropicClient(message());
    const config: AnthropicGenerateContentConfig = {
      effort: 'xhigh',
      thinkingConfig: {
        thinkingBudget: -1,
        thinkingLevel: ThinkingLevel.MINIMAL,
      },
    };

    await expect(
      collect(new AnthropicLlm({client}), request({config})),
    ).rejects.toThrowError(
      /thinkingLevel is not supported in AnthropicGenerateContentConfig/,
    );
    expect(client.calls).toHaveLength(0);
  });

  it('drops the sampling parameters when thinking is enabled', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({
        config: {
          temperature: 0.5,
          topP: 0.9,
          topK: 40,
          thinkingConfig: {thinkingBudget: 2048},
        },
      }),
    );

    expect(client.lastParams).not.toHaveProperty('temperature');
    expect(client.lastParams).not.toHaveProperty('top_p');
    expect(client.lastParams).not.toHaveProperty('top_k');
    expect(warn).toHaveBeenCalledWith(
      'Sampling parameters (temperature, top_p, top_k) are ignored because ' +
        'thinking/effort is enabled.',
    );
  });

  it('drops the sampling parameters when an effort is set', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const client = new FakeAnthropicClient(message());
    const config: AnthropicGenerateContentConfig = {
      effort: 'high',
      temperature: 0.5,
    };

    await collect(new AnthropicLlm({client}), request({config}));

    expect(client.lastParams).not.toHaveProperty('temperature');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the sampling parameters when thinking is disabled', async () => {
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({
        config: {temperature: 0.5, thinkingConfig: {thinkingBudget: 0}},
      }),
    );

    expect(client.lastParams.temperature).toBe(0.5);
  });

  it('does not warn when thinking is set without sampling parameters', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const client = new FakeAnthropicClient(message());

    await collect(
      new AnthropicLlm({client}),
      request({config: {thinkingConfig: {thinkingBudget: -1}}}),
    );

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('AnthropicLlm streaming', () => {
  it('passes stream true to the client', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      messageDelta('end_turn'),
    ]);

    await collect(new AnthropicLlm({client}), request(), true);

    expect(client.lastParams).toMatchObject({stream: true});
  });

  it('yields text chunks and then the aggregate', async () => {
    const client = new FakeAnthropicClient([
      messageStart({input_tokens: 4, output_tokens: 0}),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {type: 'text', text: '', citations: null},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'text_delta', text: 'Hello'},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'text_delta', text: ' world'},
      },
      {type: 'content_block_stop', index: 0},
      messageDelta('end_turn', 7),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses.map((response) => response.partial)).toEqual([
      true,
      true,
      false,
    ]);
    expect(responses[0].content).toEqual({
      role: 'model',
      parts: [{text: 'Hello'}],
    });
    expect(responses[2].content).toEqual({
      role: 'model',
      parts: [{text: 'Hello world'}],
    });
    expect(responses[2].usageMetadata).toMatchObject({
      promptTokenCount: 4,
      candidatesTokenCount: 7,
      totalTokenCount: 11,
    });
    expect(responses[2].finishReason).toBe(FinishReason.STOP);
  });

  it('accumulates a streamed tool call', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'search',
          input: {},
          caller: {type: 'direct'},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'input_json_delta', partial_json: '{"query":'},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'input_json_delta', partial_json: '"adk"}'},
      },
      messageDelta('tool_use'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts).toEqual([
      {functionCall: {id: 'toolu_1', name: 'search', args: {query: 'adk'}}},
    ]);
  });

  it('defaults a tool call with no streamed arguments to empty', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'ping',
          input: {},
          caller: {type: 'direct'},
        },
      },
      messageDelta('tool_use'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].content?.parts).toEqual([
      {functionCall: {id: 'toolu_1', name: 'ping', args: {}}},
    ]);
  });

  it('ignores argument deltas for a block that never started', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_delta',
        index: 3,
        delta: {type: 'input_json_delta', partial_json: '{"a":1}'},
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].content?.parts).toEqual([]);
  });

  it('starts a text block from its first delta', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'text_delta', text: 'Hi'},
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[1].content?.parts).toEqual([{text: 'Hi'}]);
  });

  it('yields thinking chunks and keeps the signature out of them', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {type: 'thinking', thinking: '', signature: ''},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'thinking_delta', thinking: 'Let me '},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'thinking_delta', thinking: 'think.'},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'signature_delta', signature: 'sig-abc'},
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses.map((response) => response.partial)).toEqual([
      true,
      true,
      false,
    ]);
    expect(responses[0].content?.parts).toEqual([
      {text: 'Let me ', thought: true},
    ]);
    expect(responses[2].content?.parts).toEqual([
      {
        text: 'Let me think.',
        thought: true,
        thoughtSignature: Buffer.from('sig-abc', 'utf-8').toString('base64'),
      },
    ]);
  });

  it('captures a signature delta for a block that never started', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'signature_delta', signature: 'sig-only'},
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].content?.parts).toEqual([
      {
        text: '',
        thought: true,
        thoughtSignature: Buffer.from('sig-only', 'utf-8').toString('base64'),
      },
    ]);
  });

  it('starts a thinking block from its first delta', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'thinking_delta', thinking: 'Hmm'},
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[1].content?.parts).toEqual([{text: 'Hmm', thought: true}]);
  });

  it('keeps a redacted thinking block in the final response', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {type: 'redacted_thinking', data: 'encrypted'},
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {type: 'text', text: 'Done', citations: null},
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].content?.parts).toEqual([
      {
        thought: true,
        thoughtSignature: Buffer.from('encrypted', 'utf-8').toString('base64'),
      },
      {text: 'Done'},
    ]);
  });

  it('orders the final parts by block index', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_start',
        index: 1,
        content_block: {type: 'text', text: 'second', citations: null},
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {type: 'text', text: 'first', citations: null},
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].content?.parts).toEqual([
      {text: 'first'},
      {text: 'second'},
    ]);
  });

  it('ignores a content block Claude has no genai part for', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {type: 'container_upload', file_id: 'file_1'},
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].content?.parts).toEqual([]);
  });

  it('ignores a delta type it does not consume', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'char_location',
            cited_text: 'x',
            document_index: 0,
            document_title: null,
            end_char_index: 1,
            file_id: null,
            start_char_index: 0,
          },
        },
      },
      messageDelta('end_turn'),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts).toEqual([]);
  });

  it('keeps the thinking tokens disjoint from the candidate count', async () => {
    const client = new FakeAnthropicClient([
      messageStart({input_tokens: 10, output_tokens: 0}),
      messageDelta('end_turn', 30, 12),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].usageMetadata).toMatchObject({
      promptTokenCount: 10,
      candidatesTokenCount: 18,
      thoughtsTokenCount: 12,
      totalTokenCount: 40,
    });
  });

  it('reports the cache read and cache creation counts', async () => {
    const client = new FakeAnthropicClient([
      messageStart({
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      }),
      messageDelta('end_turn', 20),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].usageMetadata).toMatchObject({
      promptTokenCount: 18,
      cachedContentTokenCount: 5,
      cacheCreationInputTokens: 3,
    });
  });

  it('keeps an earlier stop reason when a later delta reports none', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      messageDelta('max_tokens'),
      messageDelta(null),
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('reports no finish reason when the stream never sets one', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      {type: 'message_stop'},
    ]);

    const responses = await collect(
      new AnthropicLlm({client}),
      request(),
      true,
    );

    expect(responses[0].finishReason).toBeUndefined();
    expect(responses[0].usageMetadata).toMatchObject({promptTokenCount: 10});
  });

  it('omits the system key when there is no system instruction', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      messageDelta('end_turn'),
    ]);

    await collect(new AnthropicLlm({client}), request(), true);

    expect(client.lastParams).not.toHaveProperty('system');
  });

  it('passes the generation config and the thinking parameter', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      messageDelta('end_turn'),
    ]);

    await collect(
      new AnthropicLlm({client}),
      request({
        config: {temperature: 0.25, topP: 0.8, topK: 5, stopSequences: ['END']},
      }),
      true,
    );

    expect(client.lastParams).toMatchObject({
      temperature: 0.25,
      top_p: 0.8,
      top_k: 5,
      stop_sequences: ['END'],
    });
  });

  it('passes the thinking parameter when streaming', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      messageDelta('end_turn'),
    ]);

    await collect(
      new AnthropicLlm({client}),
      request({config: {thinkingConfig: {thinkingBudget: -1}}}),
      true,
    );

    expect(client.lastParams.thinking).toEqual({type: 'adaptive'});
  });

  it('passes the abort signal to the client', async () => {
    const client = new FakeAnthropicClient([
      messageStart(),
      messageDelta('end_turn'),
    ]);
    const controller = new AbortController();

    await collect(
      new AnthropicLlm({client}),
      request(),
      true,
      controller.signal,
    );

    expect(client.calls[0].options?.signal).toBe(controller.signal);
  });
});

describe('AnthropicLlm error handling', () => {
  it('wraps a rate limit error on the non-streaming path', async () => {
    const client = new FakeAnthropicClient(rateLimitError());

    const error = await collect(new AnthropicLlm({client}), request()).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AnthropicRateLimitError);
    expect((error as Error).message).toContain(
      'https://docs.anthropic.com/en/api/errors#http-errors',
    );
    expect((error as Error).message).toContain(
      'Rate limit exceeded, please slow down.',
    );
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('wraps a rate limit error on the streaming path', async () => {
    const client = new FakeAnthropicClient(rateLimitError());

    await expect(
      collect(new AnthropicLlm({client}), request(), true),
    ).rejects.toBeInstanceOf(AnthropicRateLimitError);
  });

  it('rethrows any other client error unchanged', async () => {
    const client = new FakeAnthropicClient(
      Object.assign(new Error('Bad request'), {status: 400}),
    );

    const error = await collect(new AnthropicLlm({client}), request()).catch(
      (err: unknown) => err,
    );

    expect(error).not.toBeInstanceOf(AnthropicRateLimitError);
    expect((error as Error).message).toBe('Bad request');
  });

  it('rethrows a non-Error rejection unchanged', async () => {
    const client = new FakeAnthropicClient(new Error('plain failure'));

    await expect(
      collect(new AnthropicLlm({client}), request()),
    ).rejects.toThrowError('plain failure');
  });
});

describe('Claude on Vertex AI', () => {
  let restoreEnv = () => {};

  beforeEach(() => {
    restoreEnv = withoutEnv('GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION');
  });

  afterEach(() => {
    restoreEnv();
  });

  it('accepts an injected Vertex client', async () => {
    const client = new FakeVertexClient(message());

    const responses = await collect(new Claude({client}), request());

    expect(responses).toHaveLength(1);
  });

  it('rejects an injected client that is not Vertex-backed', async () => {
    const client = new FakeAnthropicClient(message());

    await expect(collect(new Claude({client}), request())).rejects.toThrowError(
      'Claude requires an AnthropicVertex client.',
    );
  });

  it('explains how to reach the Anthropic API when the project is unset', async () => {
    const error = await collect(
      new Claude({model: 'claude-3-5-sonnet-v2@20241022'}),
      request(),
    ).catch((err: unknown) => err);
    const errorMessage = (error as Error).message;

    expect(errorMessage).toContain('claude-3-5-sonnet-v2@20241022');
    expect(errorMessage).toContain('Vertex AI');
    expect(errorMessage).toContain('GOOGLE_CLOUD_PROJECT');
    expect(errorMessage).toContain('GOOGLE_CLOUD_LOCATION');
    expect(errorMessage).toContain('ANTHROPIC_API_KEY');
    expect(errorMessage).not.toContain('AnthropicLlm');
    expect(errorMessage).not.toContain('anthropic_llm');
  });

  it('rejects when only the location is set', async () => {
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-east5';

    await expect(collect(new Claude(), request())).rejects.toThrowError(
      /GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set/,
    );
  });
});

describe('AnthropicLlm credential resolution', () => {
  let restoreEnv = () => {};
  let configDir = '';

  beforeEach(() => {
    restoreEnv = withoutEnv(
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_CONFIG_DIR',
    );
    // Point the SDK at an empty directory so a developer's own signed-in
    // Anthropic profile cannot make these tests pass or fail.
    configDir = mkdtempSync(join(tmpdir(), 'adk-anthropic-'));
    process.env['ANTHROPIC_CONFIG_DIR'] = configDir;
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('explains how to set a credential when the SDK finds none', async () => {
    const error = await collect(new AnthropicLlm(), request()).catch(
      (err: unknown) => err,
    );
    const errorMessage = (error as Error).message;

    expect(error).toBeInstanceOf(AnthropicCredentialError);
    expect(errorMessage).toContain('ANTHROPIC_API_KEY');
    expect(errorMessage).toContain('export ANTHROPIC_API_KEY=');
    expect(errorMessage).toContain('Could not resolve authentication method');
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it('calls the Anthropic API with a key from the environment', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
    const fetchStub = stubAnthropicFetch();

    const responses = await collect(new AnthropicLlm(), request());

    expect(responses[0].content?.parts).toEqual([{text: 'Hello, world!'}]);
    const [url, init] = fetchStub.mock.calls[0];
    expect(String(url)).toContain('/v1/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('sk-test-key');
  });

  it('calls the Anthropic API with an auth token from the environment', async () => {
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'tok-test';
    const fetchStub = stubAnthropicFetch();

    await collect(new AnthropicLlm(), request());

    const [, init] = fetchStub.mock.calls[0];
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer tok-test',
    );
  });

  it('accepts a credential the SDK resolved without an environment variable', async () => {
    writeAnthropicProfile(configDir);
    const fetchStub = stubAnthropicFetch();

    const responses = await collect(new AnthropicLlm(), request());

    expect(responses[0].content?.parts).toEqual([{text: 'Hello, world!'}]);
    const [, init] = fetchStub.mock.calls[0];
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer profile-access-token',
    );
  });
});

describe('Claude Vertex client construction', () => {
  let restoreEnv = () => {};

  beforeEach(() => {
    vertexSdk.constructorOptions.length = 0;
    restoreEnv = withoutEnv('GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION');
  });

  afterEach(() => {
    restoreEnv();
  });

  it('takes the project and the region from the environment', async () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'env-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-east5';

    await collect(new Claude(), request());

    expect(vertexSdk.constructorOptions[0]).toMatchObject({
      projectId: 'env-project',
      region: 'us-east5',
    });
  });

  it('prefers the project and region named in the model resource name', async () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'env-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-east5';
    const model =
      'projects/name-project/locations/europe-west1/publishers/anthropic/models/claude-opus-4@20250514';

    await collect(new Claude({model}), request({model}));

    expect(vertexSdk.constructorOptions[0]).toMatchObject({
      projectId: 'name-project',
      region: 'europe-west1',
    });
  });

  it('sends the ADK tracking headers to Vertex AI', async () => {
    process.env['GOOGLE_CLOUD_PROJECT'] = 'env-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-east5';

    await collect(new Claude(), request());

    const headers = vertexSdk.constructorOptions[0]['defaultHeaders'];
    expect(headers).toEqual({
      'x-goog-api-client': getClientLabels().join(' '),
      'user-agent': getClientLabels().join(' '),
    });
  });
});

const EPHEMERAL: Anthropic.CacheControlEphemeral = {type: 'ephemeral'};

function cacheConfig(
  overrides: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  return {cacheIntervals: 10, ttlSeconds: 1800, minTokens: 0, ...overrides};
}

/** A three-turn conversation with a system instruction and two tools. */
function cacheRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return request({
    contents: [
      {role: 'user', parts: [{text: 'Cache this'}]},
      {role: 'model', parts: [{text: 'Sure'}]},
      {role: 'user', parts: [{text: 'And this'}]},
    ],
    config: {
      systemInstruction: 'You are a helpful assistant',
      tools: [
        {
          functionDeclarations: [
            {name: 'first', description: 'a'},
            {name: 'second', description: 'b'},
          ],
        },
      ],
    },
    cacheConfig: cacheConfig(),
    ...overrides,
  });
}

/** Collects every cache breakpoint in a payload, keyed by where it sits. */
function breakpoints(
  params: Anthropic.MessageCreateParams,
): Record<string, Anthropic.CacheControlEphemeral | null> {
  const found: Record<string, Anthropic.CacheControlEphemeral | null> = {};
  if (Array.isArray(params.system)) {
    params.system.forEach((block, index) => {
      if (block.cache_control !== undefined) {
        found[`system[${index}]`] = block.cache_control;
      }
    });
  }
  (params.tools ?? []).forEach((tool, index) => {
    if ('cache_control' in tool && tool.cache_control !== undefined) {
      found[`tools[${index}]`] = tool.cache_control;
    }
  });
  params.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) {
      return;
    }
    message.content.forEach((block, blockIndex) => {
      if ('cache_control' in block && block.cache_control !== undefined) {
        found[`messages[${messageIndex}][${blockIndex}]`] = block.cache_control;
      }
    });
  });
  return found;
}

/** Runs one turn and returns the payload that reached `messages.create`. */
async function sentParams(
  llmRequest: LlmRequest,
  stream = false,
): Promise<Anthropic.MessageCreateParams> {
  const client = new FakeAnthropicClient(
    stream ? [messageStart(), messageDelta('end_turn')] : message(),
  );

  await collect(new AnthropicLlm({client}), llmRequest, stream);

  return client.lastParams;
}

describe('AnthropicLlm prompt caching', () => {
  it('sends no breakpoints when the app configured no caching', async () => {
    const params = await sentParams(cacheRequest({cacheConfig: undefined}));

    expect(params.system).toBe('You are a helpful assistant');
    expect(breakpoints(params)).toEqual({});
  });

  it('marks the tools, the system instruction and the conversation', async () => {
    const params = await sentParams(cacheRequest());

    expect(params.system).toEqual([
      {
        type: 'text',
        text: 'You are a helpful assistant',
        cache_control: EPHEMERAL,
      },
    ]);
    expect(breakpoints(params)).toEqual({
      'system[0]': EPHEMERAL,
      'tools[1]': EPHEMERAL,
      'messages[2][0]': EPHEMERAL,
    });
  });

  it('marks the same three breakpoints when streaming', async () => {
    const params = await sentParams(cacheRequest(), true);

    expect(params.stream).toBe(true);
    expect(breakpoints(params)).toEqual({
      'system[0]': EPHEMERAL,
      'tools[1]': EPHEMERAL,
      'messages[2][0]': EPHEMERAL,
    });
  });

  it('still marks the rest without a system instruction', async () => {
    const llmRequest = cacheRequest();
    delete llmRequest.config?.systemInstruction;

    const params = await sentParams(llmRequest);

    expect(params.system).toBeUndefined();
    expect(breakpoints(params)).toEqual({
      'tools[1]': EPHEMERAL,
      'messages[2][0]': EPHEMERAL,
    });
  });

  it.each([
    {ttlSeconds: 300, cacheControl: EPHEMERAL},
    {ttlSeconds: 1800, cacheControl: EPHEMERAL},
    {ttlSeconds: 3599, cacheControl: EPHEMERAL},
    {ttlSeconds: 3600, cacheControl: {type: 'ephemeral', ttl: '1h'}},
    {ttlSeconds: 86_400, cacheControl: {type: 'ephemeral', ttl: '1h'}},
  ])(
    'maps a lifetime of $ttlSeconds seconds onto one Claude offers',
    async ({ttlSeconds, cacheControl}) => {
      const params = await sentParams(
        cacheRequest({cacheConfig: cacheConfig({ttlSeconds})}),
      );

      expect(breakpoints(params)['system[0]']).toEqual(cacheControl);
    },
  );

  it.each([
    {
      name: 'thinking',
      trailingPart: {text: 'reasoning', thought: true},
    },
    {
      name: 'redacted_thinking',
      trailingPart: {
        thought: true,
        thoughtSignature: Buffer.from('opaque').toString('base64'),
      },
    },
  ])('never marks a trailing $name block', async ({name, trailingPart}) => {
    const params = await sentParams(
      cacheRequest({
        contents: [
          {role: 'user', parts: [{text: 'Question'}]},
          {role: 'model', parts: [{text: 'Answer'}, trailingPart]},
        ],
      }),
    );

    const blocks = params.messages[1].content;
    if (!Array.isArray(blocks)) {
      return expect.fail('the model turn must carry a list of blocks');
    }
    expect(blocks[1].type).toBe(name);
    expect(blocks[1]).not.toHaveProperty('cache_control');
    expect(breakpoints(params)['messages[1][1]']).toBeUndefined();
    expect(breakpoints(params)['messages[1][0]']).toEqual(EPHEMERAL);
  });

  it('walks back past a turn left with no blocks', async () => {
    const params = await sentParams(
      cacheRequest({
        contents: [
          {role: 'user', parts: [{text: 'Question'}]},
          {
            role: 'model',
            parts: [
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: 'bm90LWEtcmVhbC1wbmc=',
                },
              },
            ],
          },
        ],
      }),
    );

    expect(params.messages[1].content).toEqual([]);
    expect(breakpoints(params)).toEqual({
      'system[0]': EPHEMERAL,
      'tools[1]': EPHEMERAL,
      'messages[0][0]': EPHEMERAL,
    });
  });

  it('sends no breakpoints below the configured minimum', async () => {
    const params = await sentParams(
      cacheRequest({
        cacheConfig: cacheConfig({minTokens: 5000}),
        cacheableContentsTokenCount: 4999,
      }),
    );

    expect(params.system).toBe('You are a helpful assistant');
    expect(breakpoints(params)).toEqual({});
  });

  it('sends breakpoints at the configured minimum', async () => {
    const params = await sentParams(
      cacheRequest({
        cacheConfig: cacheConfig({minTokens: 5000}),
        cacheableContentsTokenCount: 5000,
      }),
    );

    expect(breakpoints(params)).toEqual({
      'system[0]': EPHEMERAL,
      'tools[1]': EPHEMERAL,
      'messages[2][0]': EPHEMERAL,
    });
  });

  it('marks the first turn of a session, whose size is unknown', async () => {
    const llmRequest = cacheRequest();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();

    const params = await sentParams(llmRequest);

    expect(breakpoints(params)).toEqual({
      'system[0]': EPHEMERAL,
      'tools[1]': EPHEMERAL,
      'messages[2][0]': EPHEMERAL,
    });
  });

  it('leaves a request without tools unmarked at the tool level', async () => {
    const params = await sentParams(
      cacheRequest({config: {systemInstruction: 'Only a system prompt'}}),
    );

    expect(params.tools).toBeUndefined();
    expect(breakpoints(params)).toEqual({
      'system[0]': EPHEMERAL,
      'messages[2][0]': EPHEMERAL,
    });
  });
});

describe('AnthropicLlm streamed tool arguments', () => {
  function toolCallStream(partialJson: string): StreamEvent[] {
    return [
      messageStart(),
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'weather',
          input: {},
          caller: {type: 'direct'},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'input_json_delta', partial_json: partialJson},
      },
      messageDelta('tool_use'),
    ];
  }

  it('names the tool when the streamed arguments are truncated', async () => {
    const client = new FakeAnthropicClient(toolCallStream('{"city": "Par'));

    await expect(
      collect(new AnthropicLlm({client}), request(), true),
    ).rejects.toThrowError(
      /^Invalid JSON in streamed arguments for tool weather: /,
    );
  });

  it('rejects streamed arguments that are not a JSON object', async () => {
    const client = new FakeAnthropicClient(toolCallStream('"Paris"'));

    await expect(
      collect(new AnthropicLlm({client}), request(), true),
    ).rejects.toThrowError(
      'Expected a JSON object for streamed arguments for tool weather.',
    );
  });
});
