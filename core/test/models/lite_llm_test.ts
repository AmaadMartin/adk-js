/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CacheControlInjectionPoint,
  CompletionArgs,
  ContextCacheConfig,
  LiteLlm,
  LiteLlmClient,
  LiteLlmParams,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  ModelResponse,
  ModelResponseStream,
  ToolCall,
} from '@google/adk';
import {FinishReason, FunctionCallingConfigMode, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {getTrackingHeaders} from '../../src/utils/client_labels.js';

/** A client that records what it was sent and replays canned responses. */
class RecordingClient implements LiteLlmClient {
  args?: CompletionArgs;
  abortSignal?: AbortSignal;

  constructor(
    private readonly response: ModelResponse = {},
    private readonly chunks: ModelResponseStream[] = [],
  ) {}

  async completion(
    args: CompletionArgs,
    abortSignal?: AbortSignal,
  ): Promise<ModelResponse> {
    this.args = args;
    this.abortSignal = abortSignal;
    return this.response;
  }

  async streamCompletion(
    args: CompletionArgs,
    abortSignal?: AbortSignal,
  ): Promise<AsyncIterable<ModelResponseStream>> {
    this.args = args;
    this.abortSignal = abortSignal;
    const chunks = this.chunks;
    return (async function* () {
      yield* chunks;
    })();
  }
}

/** Builds a request carrying only the fields the model reads. */
function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'hi'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

/** Drains the responses a generation produced. */
async function collect(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

/** A non-streaming response carrying one line of text. */
function textResponse(text = 'hello'): ModelResponse {
  return {
    model: 'gpt-4o',
    choices: [
      {message: {role: 'assistant', content: text}, finish_reason: 'stop'},
    ],
  };
}

/** A stream chunk carrying one text delta. */
function textChunk(text: string, finishReason?: string): ModelResponseStream {
  return {
    model: 'gpt-4o',
    choices: [
      {delta: {role: 'assistant', content: text}, finish_reason: finishReason},
    ],
  };
}

/** A base64 thought signature, the shape a Gemini thinking model returns. */
const THOUGHT_SIGNATURE = 'c2lnbmF0dXJl';

/** Builds a cache config, defaulting every field the test does not name. */
function cacheConfig(
  overrides: Partial<ContextCacheConfig> = {},
): ContextCacheConfig {
  return {ttlSeconds: 1800, minTokens: 0, ...overrides};
}

/** A non-streaming response carrying one tool call. */
function toolCallResponse(toolCall: Partial<ToolCall>): ModelResponse {
  return {
    model: 'gpt-4o',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              type: 'function',
              id: 'call_abc',
              function: {name: 'lookup', arguments: '{"q":"adk"}'},
              ...toolCall,
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

/** Returns the single function-call part of a response. */
function functionCallPart(response: LlmResponse): Part {
  const part = response.content?.parts?.find((candidate) =>
    Boolean(candidate.functionCall),
  );
  if (!part) {
    expect.fail('the response carried no function-call part');
  }
  return part;
}

/** A stream chunk that only reports why the stream ended. */
function finishChunk(finishReason: string): ModelResponseStream {
  return {
    model: 'gpt-4o',
    choices: [{delta: {role: 'assistant'}, finish_reason: finishReason}],
  };
}

/** A stream chunk carrying one tool-call delta. */
function toolChunk(
  toolCall: {id?: string; name?: string; args?: string; index?: number},
  finishReason?: string,
): ModelResponseStream {
  return {
    model: 'gpt-4o',
    choices: [
      {
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              id: toolCall.id,
              index: toolCall.index,
              function: {name: toolCall.name, arguments: toolCall.args},
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
  };
}

describe('LiteLlm', () => {
  describe('construction', () => {
    it('declares the provider prefixes it handles', () => {
      expect(LiteLlm.supportedModels).toContainEqual(/openai\/.*/);
      expect(LiteLlm.supportedModels).toContainEqual(/anthropic\/.*/);
      expect(LiteLlm.supportedModels).toContainEqual(/ollama\/(?!gemma3).*/);
    });

    it('is not registered with the model registry', () => {
      expect(() => LLMRegistry.resolve('openai/gpt-4o')).toThrow();
    });

    it('drops the request fields it owns and keeps the rest', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({
        model: 'openai/gpt-4o',
        client,
        additionalArgs: {
          model: 'evil/model',
          messages: [],
          tools: [],
          stream: true,
          temperature: 0.4,
        },
      });

      await collect(model.generateContentAsync(request()));

      expect(client.args?.model).toBe('openai/gpt-4o');
      expect(client.args?.messages).toHaveLength(1);
      expect(client.args?.tools).toBeUndefined();
      expect(client.args?.stream).toBeUndefined();
      expect(client.args?.temperature).toBe(0.4);
    });

    it('builds a fetch client when the caller supplies none', () => {
      expect(
        () =>
          new LiteLlm({
            model: 'openai/gpt-4o',
            apiBase: 'https://proxy.example.com/v1',
          }),
      ).not.toThrow();
    });

    it('rejects a live connection', async () => {
      const model = new LiteLlm({
        model: 'openai/gpt-4o',
        client: new RecordingClient(),
      });
      await expect(model.connect()).rejects.toThrow(
        'Live connection is not supported for openai/gpt-4o.',
      );
    });
  });

  describe('generateContentAsync', () => {
    it('yields one response for a non-streaming call', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(model.generateContentAsync(request()));

      expect(responses).toHaveLength(1);
      expect(responses[0].content?.parts).toEqual([{text: 'hello'}]);
      expect(responses[0].finishReason).toBe(FinishReason.STOP);
      expect(client.args?.messages).toEqual([{role: 'user', content: 'hi'}]);
    });

    it('prefers the model the request names', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(request({model: 'anthropic/claude-4'})),
      );

      expect(client.args?.model).toBe('anthropic/claude-4');
    });

    it('appends a user turn when the history has none', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(model.generateContentAsync(request({contents: []})));

      expect(client.args?.messages).toEqual([
        {
          role: 'user',
          content:
            'Handle the requests as specified in the System Instruction.',
        },
      ]);
    });

    it('appends text to a user turn that carries none', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(
          request({contents: [{role: 'user', parts: []}]}),
        ),
      );

      expect(client.args?.messages).toEqual([
        {
          role: 'user',
          content:
            'Handle the requests as specified in the System Instruction.',
        },
      ]);
    });

    it('sends the system instruction first', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(
          request({config: {systemInstruction: 'be nice'}}),
        ),
      );

      expect(client.args?.messages[0]).toEqual({
        role: 'system',
        content: 'be nice',
      });
    });

    it('sends a tool result as a tool message', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(
          request({
            contents: [
              {role: 'user', parts: [{text: 'add 2 and 4'}]},
              {
                role: 'model',
                parts: [
                  {functionCall: {id: 'c1', name: 'add', args: {a: 2, b: 4}}},
                ],
              },
              {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 'c1',
                      name: 'add',
                      response: {result: 6},
                    },
                  },
                ],
              },
            ],
          }),
        ),
      );

      expect(client.args?.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
      ]);
    });

    it('sends the tool choice the request asks for', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(
          request({
            config: {
              tools: [{functionDeclarations: [{name: 'add'}]}],
              toolConfig: {
                functionCallingConfig: {mode: FunctionCallingConfigMode.ANY},
              },
            },
          }),
        ),
      );

      expect(client.args?.tool_choice).toBe('required');
    });

    it('drops the tool choice when the request declares no tools', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(
          request({
            config: {
              toolConfig: {
                functionCallingConfig: {mode: FunctionCallingConfigMode.ANY},
              },
            },
          }),
        ),
      );

      expect(client.args?.tool_choice).toBeUndefined();
    });

    it('reports the usage the provider sent', async () => {
      const client = new RecordingClient({
        model: 'gpt-4o',
        choices: [{message: {role: 'assistant', content: 'hi'}}],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          prompt_tokens_details: {cached_tokens: 3},
          completion_tokens_details: {reasoning_tokens: 2},
        },
      });
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(model.generateContentAsync(request()));

      expect(response.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 2,
      });
    });

    it('reports the bedrock cache token counts', async () => {
      const client = new RecordingClient({
        choices: [{message: {role: 'assistant', content: 'hi'}}],
        usage: {
          prompt_tokens: 10,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 4,
        },
      });
      const model = new LiteLlm({model: 'bedrock/claude-3', client});

      const [response] = await collect(model.generateContentAsync(request()));

      expect(response.usageMetadata).toMatchObject({
        cachedContentTokenCount: 6,
        cacheCreationInputTokens: 4,
      });
    });

    it('forwards the abort signal', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});
      const controller = new AbortController();

      await collect(
        model.generateContentAsync(request(), false, controller.signal),
      );

      expect(client.abortSignal).toBe(controller.signal);
    });
  });

  describe('http options', () => {
    const httpOptions = {
      headers: {'X-Trace': 'abc'},
      timeout: 30000,
      retryOptions: {attempts: 3},
      extraBody: {custom: true},
    };

    it('maps every option onto its request field', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(request({config: {httpOptions}})),
      );

      expect(client.args?.extra_headers).toEqual({'X-Trace': 'abc'});
      expect(client.args?.timeout).toBe(30);
      expect(client.args?.num_retries).toBe(3);
      expect(client.args?.extra_body).toEqual({custom: true});
    });

    it('merges the request headers over the ones already set', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({
        model: 'openai/gpt-4o',
        client,
        additionalArgs: {extra_headers: {'X-Team': 'adk', 'X-Trace': 'old'}},
      });

      await collect(
        model.generateContentAsync(request({config: {httpOptions}})),
      );

      expect(client.args?.extra_headers).toEqual({
        'X-Team': 'adk',
        'X-Trace': 'abc',
      });
    });

    it('never mutates the caller options', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});
      const callerHeaders = {'X-Trace': 'abc'};

      await collect(
        model.generateContentAsync(
          request({config: {httpOptions: {headers: callerHeaders}}}),
        ),
      );

      expect(callerHeaders).toEqual({'X-Trace': 'abc'});
      expect(client.args?.extra_headers).not.toBe(callerHeaders);
    });

    it('leaves the request fields unset when there are no options', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(model.generateContentAsync(request({config: {}})));

      expect(client.args?.timeout).toBeUndefined();
      expect(client.args?.num_retries).toBeUndefined();
      expect(client.args?.extra_headers).toBeUndefined();
      expect(client.args?.extra_body).toBeUndefined();
    });
  });

  describe('tracking headers', () => {
    /** Runs one non-streaming call and returns the headers sent. */
    async function trackingHeaders(
      model: string,
      params: Partial<LiteLlmParams> = {},
      overrides: Partial<LlmRequest> = {},
    ): Promise<Record<string, string> | undefined> {
      const client = new RecordingClient(textResponse());
      const litellm = new LiteLlm({model, client, ...params});

      await collect(litellm.generateContentAsync(request(overrides)));

      return client.args?.headers;
    }

    it.each([['vertex_ai/test_model'], ['gemini/gemini-2.5-pro']])(
      'attributes a call to %s to ADK',
      async (model) => {
        const headers = await trackingHeaders(model);

        expect(headers?.['x-goog-api-client']).toContain('google-adk/');
        expect(headers?.['user-agent']).toBe(headers?.['x-goog-api-client']);
      },
    );

    it('sends no tracking headers to another provider', async () => {
      expect(await trackingHeaders('openai/gpt-4o')).toBeUndefined();
    });

    it('keeps a constructor header alongside the tracking headers', async () => {
      const headers = await trackingHeaders('vertex_ai/test_model', {
        headers: {custom: 'header'},
      });

      expect(headers?.['custom']).toBe('header');
      expect(headers?.['x-goog-api-client']).toContain('google-adk/');
    });

    it('appends the ADK labels to a caller value without losing it', async () => {
      const headers = await trackingHeaders('vertex_ai/test_model', {
        headers: {'x-goog-api-client': 'my-client/1.0'},
      });

      const parts = headers?.['x-goog-api-client']?.split(' ') ?? [];
      expect(parts).toContain('my-client/1.0');
      expect(parts.some((part) => part.startsWith('google-adk/'))).toBe(true);
      expect(new Set(parts).size).toBe(parts.length);
    });

    it('does not duplicate a label the caller already carries', async () => {
      const label = getTrackingHeaders()['x-goog-api-client'];
      const headers = await trackingHeaders('vertex_ai/test_model', {
        headers: {'x-goog-api-client': label},
      });

      expect(headers?.['x-goog-api-client']).toBe(label);
    });
  });

  describe('cache control injection points', () => {
    const cacheConfig: ContextCacheConfig = {ttlSeconds: 600, minTokens: 0};

    /** Runs one non-streaming call and returns the injection points sent. */
    async function injectionPoints(
      overrides: Partial<LlmRequest>,
      additionalArgs?: Record<string, unknown>,
    ): Promise<CacheControlInjectionPoint[] | undefined> {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({
        model: 'anthropic/claude-sonnet-4',
        client,
        additionalArgs,
      });

      await collect(model.generateContentAsync(request(overrides)));

      return client.args?.cache_control_injection_points;
    }

    it('sends no points when the request carries no cache config', async () => {
      expect(await injectionPoints({})).toBeUndefined();
    });

    it('marks the system instruction and the last message', async () => {
      expect(await injectionPoints({cacheConfig})).toEqual([
        {location: 'message', role: 'system', control: {type: 'ephemeral'}},
        {location: 'message', index: -1, control: {type: 'ephemeral'}},
      ]);
    });

    it.each([[300], [1800], [3599]])(
      'asks for the default cache at a lifetime of %i seconds',
      async (ttlSeconds) => {
        const points = await injectionPoints({
          cacheConfig: {...cacheConfig, ttlSeconds},
        });

        expect(points?.map((point) => point.control)).toEqual([
          {type: 'ephemeral'},
          {type: 'ephemeral'},
        ]);
      },
    );

    it.each([[3600], [86400]])(
      'asks for the hour-long cache at a lifetime of %i seconds',
      async (ttlSeconds) => {
        const points = await injectionPoints({
          cacheConfig: {...cacheConfig, ttlSeconds},
        });

        expect(points?.map((point) => point.control)).toEqual([
          {type: 'ephemeral', ttl: '1h'},
          {type: 'ephemeral', ttl: '1h'},
        ]);
      },
    );

    it('ignores the prompt size when the request carries no config', async () => {
      expect(
        await injectionPoints({cacheableContentsTokenCount: 10_000}),
      ).toBeUndefined();
    });

    it('treats a prompt size of zero as a size, not an absent one', async () => {
      expect(
        await injectionPoints({
          cacheConfig: {...cacheConfig, minTokens: 1},
          cacheableContentsTokenCount: 0,
        }),
      ).toBeUndefined();
    });

    it('asks for the default cache at a lifetime of one second', async () => {
      const points = await injectionPoints({
        cacheConfig: {...cacheConfig, ttlSeconds: 1},
      });

      expect(points?.[0].control).toEqual({type: 'ephemeral'});
    });

    it('leaves the cache fields it read on the request untouched', async () => {
      const config = {...cacheConfig, minTokens: 5000};
      const llmRequest = request({
        cacheConfig: config,
        cacheableContentsTokenCount: 10,
      });
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'anthropic/claude-sonnet-4', client});

      await collect(model.generateContentAsync(llmRequest));

      expect(llmRequest.cacheConfig).toEqual(config);
      expect(llmRequest.cacheableContentsTokenCount).toBe(10);
    });

    it('sends no points below the configured minimum token count', async () => {
      expect(
        await injectionPoints({
          cacheConfig: {...cacheConfig, minTokens: 5000},
          cacheableContentsTokenCount: 4999,
        }),
      ).toBeUndefined();
    });

    it('sends points at the configured minimum token count', async () => {
      expect(
        await injectionPoints({
          cacheConfig: {...cacheConfig, minTokens: 5000},
          cacheableContentsTokenCount: 5000,
        }),
      ).toHaveLength(2);
    });

    it('sends points on a first turn, whose size is unknown', async () => {
      expect(
        await injectionPoints({
          cacheConfig: {...cacheConfig, minTokens: 1000000},
        }),
      ).toHaveLength(2);
    });

    it('leaves points a caller named through additionalArgs alone', async () => {
      const callerPoints: CacheControlInjectionPoint[] = [
        {location: 'message', index: 0, control: {type: 'ephemeral'}},
      ];

      expect(
        await injectionPoints(
          {cacheConfig},
          {cache_control_injection_points: callerPoints},
        ),
      ).toEqual(callerPoints);
    });
  });

  describe('streaming', () => {
    it('asks for usage alongside the stream', async () => {
      const client = new RecordingClient({}, [textChunk('hi', 'stop')]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(model.generateContentAsync(request(), true));

      expect(client.args?.stream).toBe(true);
      expect(client.args?.stream_options).toEqual({include_usage: true});
    });

    it('yields a partial per delta and then the aggregate', async () => {
      const client = new RecordingClient({}, [
        textChunk('Hello '),
        textChunk('world'),
        textChunk('', 'stop'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses.map((response) => response.partial)).toEqual([
        true,
        true,
        false,
      ]);
      expect(responses[2].content?.parts).toEqual([{text: 'Hello world'}]);
      expect(responses[2].finishReason).toBe(FinishReason.STOP);
    });

    it('aggregates a tool call whose arguments arrive in pieces', async () => {
      const client = new RecordingClient({}, [
        toolChunk({id: 'c1', name: 'add', args: '{"a":'}),
        toolChunk({args: ' 1}'}),
        finishChunk('tool_calls'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].content?.parts).toEqual([
        {functionCall: {id: 'c1', name: 'add', args: {a: 1}}},
      ]);
    });

    it('separates parallel tool calls a provider indexed identically', async () => {
      const client = new RecordingClient({}, [
        toolChunk({id: 'c1', name: 'add', args: '{"a": 1}', index: 0}),
        toolChunk({id: 'c2', name: 'sub', args: '{"b": 2}', index: 0}),
        finishChunk('tool_calls'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(response.content?.parts).toEqual([
        {functionCall: {id: 'c1', name: 'add', args: {a: 1}}},
        {functionCall: {id: 'c2', name: 'sub', args: {b: 2}}},
      ]);
    });

    it('names a tool call after its index when the provider sends no id', async () => {
      const client = new RecordingClient({}, [
        toolChunk({name: 'add', args: '{}', index: 2}),
        finishChunk('tool_calls'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(response.content?.parts?.[0].functionCall?.id).toBe('2');
    });

    it('attaches usage that arrives after the finish reason', async () => {
      const client = new RecordingClient({}, [
        textChunk('hi'),
        textChunk('', 'stop'),
        {
          model: 'gpt-4o',
          choices: [],
          usage: {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3},
        },
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses[responses.length - 1].usageMetadata).toMatchObject({
        totalTokenCount: 3,
      });
    });

    it('reports the cache and reasoning counts a stream sends', async () => {
      const client = new RecordingClient({}, [
        textChunk('hi'),
        textChunk('', 'stop'),
        {
          model: 'claude-3',
          choices: [],
          usage: {
            prompt_tokens: 10,
            cache_read_input_tokens: 6,
            cache_creation_input_tokens: 4,
            completion_tokens_details: {reasoning_tokens: 9},
          },
        },
      ]);
      const model = new LiteLlm({model: 'bedrock/claude-3', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses[responses.length - 1].usageMetadata).toMatchObject({
        cachedContentTokenCount: 6,
        cacheCreationInputTokens: 4,
        thoughtsTokenCount: 9,
      });
    });

    it('attaches grounding metadata from any chunk', async () => {
      const client = new RecordingClient({}, [
        {
          ...textChunk('hi'),
          vertex_ai_grounding_metadata: {webSearchQueries: ['q']},
        },
        textChunk('', 'stop'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses[responses.length - 1].groundingMetadata).toEqual({
        webSearchQueries: ['q'],
      });
    });

    it('reports a token limit reached mid-stream', async () => {
      const client = new RecordingClient({}, [textChunk('hi', 'length')]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      const last = responses[responses.length - 1];
      expect(last.finishReason).toBe(FinishReason.MAX_TOKENS);
      expect(last.errorCode).toBe(FinishReason.MAX_TOKENS);
      expect(last.errorMessage).toBe('Maximum tokens reached');
    });

    it('reports tool arguments truncated by the token limit', async () => {
      const client = new RecordingClient({}, [
        toolChunk({id: 'c1', name: 'add', args: '{"a":'}),
        finishChunk('length'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(response.finishReason).toBe(FinishReason.MAX_TOKENS);
      expect(response.errorMessage).toContain(
        'Tool call arguments were truncated while streaming',
      );
      expect(response.content).toBeUndefined();
    });

    it('reports a stream a content filter ended before any content', async () => {
      const client = new RecordingClient({}, [
        {
          model: 'gpt-4o',
          choices: [
            {delta: {role: 'assistant'}, finish_reason: 'content_filter'},
          ],
        },
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].finishReason).toBe(FinishReason.SAFETY);
      expect(responses[0].errorCode).toBe(FinishReason.SAFETY);
    });

    it('yields nothing when a stream stops without content', async () => {
      const client = new RecordingClient({}, [
        {
          model: 'gpt-4o',
          choices: [{delta: {role: 'assistant'}, finish_reason: 'stop'}],
        },
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      expect(
        await collect(model.generateContentAsync(request(), true)),
      ).toEqual([]);
    });

    it('aggregates the text and the tool calls of one segment together', async () => {
      const client = new RecordingClient({}, [
        textChunk('working on it'),
        toolChunk({id: 'c1', name: 'add', args: '{}'}),
        finishChunk('tool_calls'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses.map((response) => response.partial)).toEqual([
        true,
        false,
      ]);
      expect(responses[1].content?.parts).toEqual([
        {text: 'working on it'},
        {functionCall: {id: 'c1', name: 'add', args: {}}},
      ]);
    });

    it('yields the text segment before the tool-call segment', async () => {
      const client = new RecordingClient({}, [
        textChunk('one'),
        finishChunk('stop'),
        toolChunk({id: 'c1', name: 'add', args: '{}'}),
        finishChunk('tool_calls'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses.map((response) => response.partial)).toEqual([
        true,
        false,
        false,
      ]);
      expect(responses[1].content?.parts).toEqual([{text: 'one'}]);
      expect(responses[2].content?.parts).toEqual([
        {functionCall: {id: 'c1', name: 'add', args: {}}},
      ]);
    });

    it('streams reasoning as partials and keeps it on the aggregate', async () => {
      const client = new RecordingClient({}, [
        {
          model: 'gpt-4o',
          choices: [{delta: {role: 'assistant', reasoning_content: 'think'}}],
        },
        textChunk('answer'),
        textChunk('', 'stop'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses[0]).toMatchObject({
        partial: true,
        content: {role: 'model', parts: [{text: 'think', thought: true}]},
      });
      expect(responses[responses.length - 1].content?.parts).toEqual([
        {text: 'think', thought: true},
        {text: 'answer'},
      ]);
    });

    it('finalizes a stream that ends without a finish reason', async () => {
      const client = new RecordingClient({}, [textChunk('hi')]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses[responses.length - 1]).toMatchObject({
        partial: false,
        finishReason: FinishReason.STOP,
      });
    });

    it('finalizes tool calls left open when the stream ends', async () => {
      const client = new RecordingClient({}, [
        toolChunk({id: 'c1', name: 'add', args: '{}'}),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(response.content?.parts?.[0].functionCall?.name).toBe('add');
      expect(response.finishReason).toBe(FinishReason.STOP);
    });

    it('keeps the model version of an earlier chunk', async () => {
      const client = new RecordingClient({}, [
        textChunk('hi'),
        {choices: [{delta: {role: 'assistant'}, finish_reason: 'stop'}]},
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const responses = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(responses[responses.length - 1].modelVersion).toBe('gpt-4o');
    });

    it('finalizes tool calls on a content-free stop chunk', async () => {
      const client = new RecordingClient({}, [
        toolChunk({id: 'c1', name: 'add', args: '{}'}),
        finishChunk('stop'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(response.content?.parts?.[0].functionCall?.name).toBe('add');
      expect(response.finishReason).toBe(FinishReason.STOP);
    });

    it('repairs tool arguments a provider closed as an object literal', async () => {
      const client = new RecordingClient({}, [
        toolChunk({id: 'c1', name: 'add', args: '{a: 1}'}),
        finishChunk('tool_calls'),
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(response.content?.parts?.[0].functionCall?.args).toEqual({a: 1});
    });

    it('attaches usage and grounding to a tool-call aggregate', async () => {
      const client = new RecordingClient({}, [
        toolChunk({id: 'c1', name: 'add', args: '{}'}),
        finishChunk('tool_calls'),
        {
          model: 'gpt-4o',
          choices: [],
          usage: {prompt_tokens: 1, completion_tokens: 2, total_tokens: 3},
          vertex_ai_grounding_metadata: {webSearchQueries: ['q']},
        },
      ]);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(
        model.generateContentAsync(request(), true),
      );

      expect(response.usageMetadata).toMatchObject({totalTokenCount: 3});
      expect(response.groundingMetadata).toEqual({webSearchQueries: ['q']});
    });

    it('yields nothing for an empty stream', async () => {
      const client = new RecordingClient({}, []);
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      expect(
        await collect(model.generateContentAsync(request(), true)),
      ).toEqual([]);
    });
  });

  describe('context caching', () => {
    it('sends no injection points without a cache config', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(model.generateContentAsync(request()));

      expect(client.args?.cache_control_injection_points).toBeUndefined();
    });

    it('marks the system message and the last message, in that order', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(request({cacheConfig: cacheConfig()})),
      );

      expect(client.args?.cache_control_injection_points).toEqual([
        {location: 'message', role: 'system', control: {type: 'ephemeral'}},
        {location: 'message', index: -1, control: {type: 'ephemeral'}},
      ]);
    });

    it.each([300, 1800, 3599])(
      'asks for the default cache lifetime at %d seconds',
      async (ttlSeconds) => {
        const client = new RecordingClient(textResponse());
        const model = new LiteLlm({model: 'openai/gpt-4o', client});

        await collect(
          model.generateContentAsync(
            request({cacheConfig: cacheConfig({ttlSeconds})}),
          ),
        );

        for (const point of client.args?.cache_control_injection_points ?? []) {
          expect(point.control).toEqual({type: 'ephemeral'});
        }
      },
    );

    it.each([3600, 86_400])(
      'asks for the hour-long cache at %d seconds',
      async (ttlSeconds) => {
        const client = new RecordingClient(textResponse());
        const model = new LiteLlm({model: 'openai/gpt-4o', client});

        await collect(
          model.generateContentAsync(
            request({cacheConfig: cacheConfig({ttlSeconds})}),
          ),
        );

        const points = client.args?.cache_control_injection_points;
        expect(points).toHaveLength(2);
        for (const point of points ?? []) {
          expect(point.control).toEqual({type: 'ephemeral', ttl: '1h'});
        }
      },
    );

    it('sends no injection points below the configured minimum', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(
          request({
            cacheConfig: cacheConfig({minTokens: 5000}),
            cacheableContentsTokenCount: 4999,
          }),
        ),
      );

      expect(client.args?.cache_control_injection_points).toBeUndefined();
    });

    it('sends the injection points once the minimum is met', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(
        model.generateContentAsync(
          request({
            cacheConfig: cacheConfig({minTokens: 5000}),
            cacheableContentsTokenCount: 5000,
          }),
        ),
      );

      expect(client.args?.cache_control_injection_points).toHaveLength(2);
    });

    it('leaves injection points the caller named alone', async () => {
      const callerPoints = [{location: 'tool_config'}];
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({
        model: 'openai/gpt-4o',
        client,
        additionalArgs: {cache_control_injection_points: callerPoints},
      });

      await collect(
        model.generateContentAsync(request({cacheConfig: cacheConfig()})),
      );

      expect(client.args?.cache_control_injection_points).toEqual(callerPoints);
    });
  });

  describe('tracking headers', () => {
    it.each([
      'vertex_ai/test-model',
      'gemini/gemini-2.5-flash',
      'litellm_proxy/vertex_ai/gemini-2.5-flash',
      'litellm_proxy/gemini/gemini-2.5-flash',
    ])('identifies ADK to %s', async (modelName) => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: modelName, client});

      await collect(model.generateContentAsync(request()));

      expect(client.args?.headers).toEqual(getTrackingHeaders());
    });

    it('sends no tracking headers to a non-Google provider', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      await collect(model.generateContentAsync(request()));

      expect(client.args?.headers).toBeUndefined();
    });

    it('keeps a caller header alongside the tracking headers', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({
        model: 'vertex_ai/test-model',
        client,
        additionalArgs: {headers: {'X-Trace': 'abc'}},
      });

      await collect(model.generateContentAsync(request()));

      expect(client.args?.headers).toEqual({
        ...getTrackingHeaders(),
        'X-Trace': 'abc',
      });
    });

    it('appends a caller value to the tracking labels it shares a key with', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({
        model: 'vertex_ai/test-model',
        client,
        additionalArgs: {headers: {'user-agent': 'my-app/1.0'}},
      });

      await collect(model.generateContentAsync(request()));

      expect(client.args?.headers?.['user-agent']).toBe(
        `${getTrackingHeaders()['user-agent']} my-app/1.0`,
      );
    });

    it('leaves the headers of the hop to the endpoint alone', async () => {
      const client = new RecordingClient(textResponse());
      const model = new LiteLlm({model: 'vertex_ai/test-model', client});

      await collect(
        model.generateContentAsync(
          request({
            config: {
              httpOptions: {headers: {'user-agent': 'my-app/1.0'}},
            },
          }),
        ),
      );

      expect(client.args?.extra_headers).toEqual({'user-agent': 'my-app/1.0'});
      expect(client.args?.headers).toEqual(getTrackingHeaders());
    });
  });

  describe('thought signatures', () => {
    it('reads a signature from the OpenAI-compatible extra content', async () => {
      const client = new RecordingClient(
        toolCallResponse({
          extra_content: {google: {thought_signature: THOUGHT_SIGNATURE}},
        }),
      );
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(model.generateContentAsync(request()));

      expect(functionCallPart(response).thoughtSignature).toBe(
        THOUGHT_SIGNATURE,
      );
    });

    it('reads a signature from the tool call provider fields', async () => {
      const client = new RecordingClient(
        toolCallResponse({
          provider_specific_fields: {thought_signature: THOUGHT_SIGNATURE},
        }),
      );
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(model.generateContentAsync(request()));

      expect(functionCallPart(response).thoughtSignature).toBe(
        THOUGHT_SIGNATURE,
      );
    });

    it('reads a signature from the function provider fields', async () => {
      const client = new RecordingClient(
        toolCallResponse({
          function: {
            name: 'lookup',
            arguments: '{"q":"adk"}',
            provider_specific_fields: {thought_signature: THOUGHT_SIGNATURE},
          },
        }),
      );
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(model.generateContentAsync(request()));

      expect(functionCallPart(response).thoughtSignature).toBe(
        THOUGHT_SIGNATURE,
      );
    });

    it('reads a signature embedded in the tool call id', async () => {
      const client = new RecordingClient(
        toolCallResponse({id: `call_abc__thought__${THOUGHT_SIGNATURE}`}),
      );
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(model.generateContentAsync(request()));

      expect(functionCallPart(response).thoughtSignature).toBe(
        THOUGHT_SIGNATURE,
      );
    });

    it('passes an empty location over for the next one', async () => {
      const client = new RecordingClient(
        toolCallResponse({
          extra_content: {google: {thought_signature: ''}},
          provider_specific_fields: {thought_signature: THOUGHT_SIGNATURE},
        }),
      );
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(model.generateContentAsync(request()));

      expect(functionCallPart(response).thoughtSignature).toBe(
        THOUGHT_SIGNATURE,
      );
    });

    it('leaves the field unset when the tool call carries no signature', async () => {
      const client = new RecordingClient(toolCallResponse({}));
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(model.generateContentAsync(request()));

      expect(functionCallPart(response).thoughtSignature).toBeUndefined();
    });

    it('drops a signature that is not base64 and keeps the tool call', async () => {
      const client = new RecordingClient(
        toolCallResponse({
          extra_content: {
            google: {thought_signature: '!!!not_valid_base64!!!'},
          },
        }),
      );
      const model = new LiteLlm({model: 'openai/gpt-4o', client});

      const [response] = await collect(model.generateContentAsync(request()));

      const part = functionCallPart(response);
      expect(part.thoughtSignature).toBeUndefined();
      expect(part.functionCall?.name).toBe('lookup');
    });

    it('sends the signature back on the following turn', async () => {
      const client = new RecordingClient(
        toolCallResponse({
          extra_content: {google: {thought_signature: THOUGHT_SIGNATURE}},
        }),
      );
      const model = new LiteLlm({model: 'openai/gpt-4o', client});
      const [response] = await collect(model.generateContentAsync(request()));
      const modelTurn = response.content;
      if (!modelTurn) {
        expect.fail('the first turn produced no content to send back');
      }

      await collect(
        model.generateContentAsync(
          request({
            contents: [{role: 'user', parts: [{text: 'hi'}]}, modelTurn],
          }),
        ),
      );

      const assistant = client.args?.messages.find((message) =>
        Boolean(message.tool_calls?.length),
      );
      expect(assistant?.tool_calls?.[0]).toMatchObject({
        provider_specific_fields: {thought_signature: THOUGHT_SIGNATURE},
        extra_content: {google: {thought_signature: THOUGHT_SIGNATURE}},
      });
    });
  });
});
