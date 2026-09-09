/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python reference tests for the labs OpenAI model, ported.
 *
 * Source: `tests/unittests/labs/openai/test_openai_llm.py` on adk-python
 * `main` at commit `a3bd1115`. Each `it(...)` title is the Python test name,
 * verbatim, so the two suites can be compared by name.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  Gemini,
  LLMRegistry,
  LlmRequest,
  OpenAIClient,
  OpenAILlm,
} from '@google/adk';
import {Type} from '@google/genai';
import type {OpenAI} from 'openai';

import {
  contentToOpenAiMessages,
  functionDeclarationToOpenAiTool,
  partToOpenAiContent,
} from '../../src/models/openai_converters.js';
import {lowercaseSchemaTypes} from '../../src/models/openai_schema.js';

const defaultClient = vi.hoisted(() => ({
  instance: undefined as OpenAIClient | undefined,
}));

const openAiConstructor = vi.hoisted(() =>
  vi.fn(function OpenAI(this: unknown) {
    return defaultClient.instance;
  }),
);

vi.mock('openai', () => ({OpenAI: openAiConstructor}));

/** A recorded call to `chat.completions.create`. */
interface RecordedCall {
  body: OpenAI.Chat.ChatCompletionCreateParams;
  options?: {signal?: AbortSignal};
}

/** What a {@link FakeOpenAIClient} replies with. */
type FakeResult =
  | {completion: OpenAI.Chat.ChatCompletion}
  | {chunks: OpenAI.Chat.ChatCompletionChunk[]};

/** An {@link OpenAIClient} that records every call and replays a canned reply. */
class FakeOpenAIClient implements OpenAIClient {
  readonly calls: RecordedCall[] = [];
  readonly chat: {completions: FakeCompletions};

  constructor(result: FakeResult) {
    this.chat = {completions: new FakeCompletions(this.calls, result)};
  }

  /** The single call the client received. */
  get onlyCall(): RecordedCall {
    const [call, ...rest] = this.calls;
    if (!call || rest.length > 0) {
      expect.fail(`expected exactly one call, got ${this.calls.length}`);
    }
    return call;
  }
}

class FakeCompletions {
  constructor(
    private readonly calls: RecordedCall[],
    private readonly result: FakeResult,
  ) {}

  create(
    body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    options?: {signal?: AbortSignal},
  ): Promise<OpenAI.Chat.ChatCompletion>;
  create(
    body: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    options?: {signal?: AbortSignal},
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>;
  create(
    body: OpenAI.Chat.ChatCompletionCreateParams,
    options?: {signal?: AbortSignal},
  ): Promise<
    OpenAI.Chat.ChatCompletion | AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
  > {
    this.calls.push({body, options});
    if ('chunks' in this.result) {
      return Promise.resolve(toAsyncIterable(this.result.chunks));
    }
    return Promise.resolve(this.result.completion);
  }
}

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/** Builds a completion carrying `content` and the given usage numbers. */
function textCompletion(
  content: string,
  usage?: OpenAI.CompletionUsage,
): OpenAI.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-1',
    created: 0,
    model: 'gpt-4o',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {role: 'assistant', content, refusal: null},
      },
    ],
    usage,
  };
}

/** Builds a streamed chunk carrying a text delta. */
function textChunk(content: string): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chatcmpl-1',
    created: 0,
    model: 'gpt-4o',
    object: 'chat.completion.chunk',
    choices: [{index: 0, delta: {content}, finish_reason: null}],
  };
}

/** The usage block of a completion, with an optional cached-token count. */
function usageWithCachedTokens(cachedTokens?: number): OpenAI.CompletionUsage {
  return {
    prompt_tokens: 100,
    completion_tokens: 5,
    total_tokens: 105,
    ...(cachedTokens === undefined
      ? {}
      : {prompt_tokens_details: {cached_tokens: cachedTokens}}),
  };
}

function helloRequest(model = 'gpt-4o'): LlmRequest {
  return {
    model,
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

async function collect(
  responses: AsyncGenerator<unknown, void>,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const response of responses) {
    collected.push(response);
  }
  return collected;
}

describe('OpenAILlm (adk-python reference tests)', () => {
  beforeEach(() => {
    openAiConstructor.mockClear();
    defaultClient.instance = undefined;
  });

  it('test_supported_models', () => {
    const models = OpenAILlm.supportedModels;
    expect(models).toHaveLength(2);
    expect(models[0]).toBe('gpt-.*');
    expect(models[1]).toBe('o\\d+-.*');
  });

  it('test_update_type_string', () => {
    const schema = {
      type: 'OBJECT',
      properties: {
        name: {type: 'STRING'},
        age: {type: 'INTEGER'},
        tags: {type: 'ARRAY', items: {type: 'STRING'}},
      },
    };

    lowercaseSchemaTypes(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: {type: 'string'},
        age: {type: 'integer'},
        tags: {type: 'array', items: {type: 'string'}},
      },
    });
  });

  it('test_function_declaration_to_openai_tool', () => {
    const tool = functionDeclarationToOpenAiTool({
      name: 'get_weather',
      description: 'Get weather',
      parameters: {
        type: Type.OBJECT,
        properties: {location: {type: Type.STRING}},
        required: ['location'],
      },
    });

    expect(tool.type).toBe('function');
    expect(tool.function.name).toBe('get_weather');
    expect(tool.function.parameters).toEqual({
      type: 'object',
      properties: {location: {type: 'string'}},
      required: ['location'],
    });
  });

  it('test_part_to_openai_content', () => {
    expect(partToOpenAiContent({text: 'Hello'})).toBe('Hello');
    expect(partToOpenAiContent({text: 'I am thinking', thought: true})).toBe(
      'Thought: I am thinking',
    );

    const image = partToOpenAiContent({
      inlineData: {data: 'ZmFrZV9kYXRh', mimeType: 'image/png'},
    });
    expect(image).toEqual({
      type: 'image_url',
      image_url: {url: 'data:image/png;base64,ZmFrZV9kYXRh'},
    });
  });

  it('test_content_to_openai_messages_with_empty_response', () => {
    const emptyResponse = contentToOpenAiMessages({
      role: 'tool',
      parts: [
        {
          functionResponse: {
            id: 'call_123',
            name: 'get_weather',
            response: {},
          },
        },
      ],
    });
    expect(emptyResponse).toEqual([
      {role: 'tool', tool_call_id: 'call_123', content: '{}'},
    ]);

    const absentResponse = contentToOpenAiMessages({
      role: 'tool',
      parts: [{functionResponse: {id: 'call_123', name: 'get_weather'}}],
    });
    expect(absentResponse).toEqual([
      {role: 'tool', tool_call_id: 'call_123', content: ''},
    ]);
  });

  it('test_generate_content_async', async () => {
    defaultClient.instance = new FakeOpenAIClient({
      completion: textCompletion('Hello there!', {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
    });
    const llm = new OpenAILlm({model: 'gpt-4o'});

    const responses = await collect(
      llm.generateContentAsync(helloRequest(), false),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      content: {role: 'model', parts: [{text: 'Hello there!'}]},
      usageMetadata: {totalTokenCount: 15},
    });
  });

  it('test_generate_content_async_with_config', async () => {
    const client = new FakeOpenAIClient({
      completion: textCompletion('Hello there!'),
    });
    defaultClient.instance = client;
    const llm = new OpenAILlm({model: 'gpt-4o'});
    const request: LlmRequest = {
      ...helloRequest(),
      config: {
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ['STOP'],
        maxOutputTokens: 100,
      },
    };

    await collect(llm.generateContentAsync(request, false));

    expect(client.onlyCall.body).toMatchObject({
      temperature: 0.7,
      top_p: 0.9,
      stop: ['STOP'],
      max_tokens: 100,
    });
  });

  it('test_generate_content_async_with_system_instruction', async () => {
    const client = new FakeOpenAIClient({
      completion: textCompletion('Hello there!'),
    });
    defaultClient.instance = client;
    const llm = new OpenAILlm({model: 'gpt-4o'});
    const request: LlmRequest = {
      ...helloRequest(),
      config: {systemInstruction: 'You are a helpful assistant.'},
    };

    await collect(llm.generateContentAsync(request, false));

    expect(client.onlyCall.body.messages).toEqual([
      {role: 'system', content: 'You are a helpful assistant.'},
      {role: 'user', content: 'Hello'},
    ]);
  });

  it('test_generate_content_async_with_image', async () => {
    const client = new FakeOpenAIClient({
      completion: textCompletion("It's an image."),
    });
    defaultClient.instance = client;
    const llm = new OpenAILlm({model: 'gpt-4o'});
    const request: LlmRequest = {
      model: 'gpt-4o',
      contents: [
        {
          role: 'user',
          parts: [
            {text: 'Analyze this'},
            {inlineData: {data: 'ZmFrZV9pbWFnZQ==', mimeType: 'image/png'}},
          ],
        },
      ],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await collect(llm.generateContentAsync(request, false));

    expect(client.onlyCall.body.messages).toEqual([
      {
        role: 'user',
        content: [
          {type: 'text', text: 'Analyze this'},
          {
            type: 'image_url',
            image_url: {url: 'data:image/png;base64,ZmFrZV9pbWFnZQ=='},
          },
        ],
      },
    ]);
  });

  it('test_generate_content_async_reports_cached_tokens', async () => {
    defaultClient.instance = new FakeOpenAIClient({
      completion: textCompletion('Hello there!', usageWithCachedTokens(64)),
    });
    const llm = new OpenAILlm({model: 'gpt-4o'});

    const responses = await collect(
      llm.generateContentAsync(helloRequest(), false),
    );

    expect(responses[0]).toMatchObject({
      usageMetadata: {cachedContentTokenCount: 64, promptTokenCount: 100},
    });
  });

  it('test_generate_content_async_zero_cached_tokens', async () => {
    defaultClient.instance = new FakeOpenAIClient({
      completion: textCompletion('Hello there!', usageWithCachedTokens(0)),
    });
    const llm = new OpenAILlm({model: 'gpt-4o'});

    const responses = await collect(
      llm.generateContentAsync(helloRequest(), false),
    );

    expect(responses[0]).toMatchObject({
      usageMetadata: {cachedContentTokenCount: 0},
    });
  });

  it('test_generate_content_async_absent_prompt_tokens_details', async () => {
    defaultClient.instance = new FakeOpenAIClient({
      completion: textCompletion('Hello there!', usageWithCachedTokens()),
    });
    const llm = new OpenAILlm({model: 'gpt-4o'});

    const responses = await collect(
      llm.generateContentAsync(helloRequest(), false),
    );

    expect(
      (responses[0] as {usageMetadata: {cachedContentTokenCount?: number}})
        .usageMetadata.cachedContentTokenCount,
    ).toBeUndefined();
  });

  it('test_generate_content_async_routes_through_provided_client', async () => {
    const client = new FakeOpenAIClient({
      completion: textCompletion('Hello there!'),
    });
    const llm = new OpenAILlm({model: 'my-model', client});

    const responses = await collect(
      llm.generateContentAsync(helloRequest('my-model'), false),
    );

    expect(openAiConstructor).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      content: {parts: [{text: 'Hello there!'}]},
    });
  });
});

describe('OpenAILlm', () => {
  beforeEach(() => {
    openAiConstructor.mockClear();
    defaultClient.instance = undefined;
  });

  it('defaults the model and the token ceiling', async () => {
    const client = new FakeOpenAIClient({completion: textCompletion('hi')});
    const llm = new OpenAILlm({client});

    expect(llm.model).toBe('gpt-4o');

    await collect(llm.generateContentAsync(helloRequest(), false));

    expect(client.onlyCall.body.max_tokens).toBe(4096);
  });

  it('applies a caller-supplied token ceiling', async () => {
    const client = new FakeOpenAIClient({completion: textCompletion('hi')});
    const llm = new OpenAILlm({client, maxTokens: 128});

    await collect(llm.generateContentAsync(helloRequest(), false));

    expect(client.onlyCall.body.max_tokens).toBe(128);
  });

  it('forwards the abort signal as a request option', async () => {
    const client = new FakeOpenAIClient({completion: textCompletion('hi')});
    const llm = new OpenAILlm({client});
    const controller = new AbortController();

    await collect(
      llm.generateContentAsync(helloRequest(), false, controller.signal),
    );

    expect(client.onlyCall.options).toEqual({signal: controller.signal});
  });

  it('builds the default client once and shares it', async () => {
    const client = new FakeOpenAIClient({completion: textCompletion('hi')});
    defaultClient.instance = client;
    const llm = new OpenAILlm({});

    await Promise.all([
      collect(llm.generateContentAsync(helloRequest(), false)),
      collect(llm.generateContentAsync(helloRequest(), false)),
    ]);

    expect(openAiConstructor).toHaveBeenCalledTimes(1);
    expect(client.calls).toHaveLength(2);
  });

  it('streams partial responses and then the full text', async () => {
    const client = new FakeOpenAIClient({
      chunks: [textChunk('Hel'), textChunk('lo')],
    });
    const llm = new OpenAILlm({client});

    const responses = await collect(
      llm.generateContentAsync(helloRequest(), true),
    );

    expect(client.onlyCall.body.stream).toBe(true);
    expect(responses).toEqual([
      {content: {role: 'model', parts: [{text: 'Hel'}]}, partial: true},
      {content: {role: 'model', parts: [{text: 'lo'}]}, partial: true},
      {content: {role: 'model', parts: [{text: 'Hello'}]}, partial: false},
    ]);
  });

  it('resolves gpt and o-series model names through the registry', () => {
    expect(LLMRegistry.resolve('gpt-4o')).toBe(OpenAILlm);
    expect(LLMRegistry.resolve('o1-preview')).toBe(OpenAILlm);
    expect(LLMRegistry.resolve('gemini-2.0-flash')).toBe(Gemini);
  });

  it('constructs from the registry with the resolved model name', () => {
    const llm = LLMRegistry.newLlm('gpt-4o-mini');

    expect(llm).toBeInstanceOf(OpenAILlm);
    expect(llm.model).toBe('gpt-4o-mini');
  });

  it('rejects a live connection', async () => {
    const llm = new OpenAILlm({model: 'gpt-4o'});

    await expect(llm.connect(helloRequest())).rejects.toThrow(
      'Live connection is not supported for gpt-4o.',
    );
  });
});
