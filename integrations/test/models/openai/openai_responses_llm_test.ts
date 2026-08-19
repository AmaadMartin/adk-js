/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest, LlmResponse} from '@google/adk';
import {
  AzureOpenAiResponsesLlm,
  AzureOpenAiResponsesLlmParams,
  OpenAiResponsesLlm,
  OpenAiResponsesLlmParams,
} from '@google/adk-integrations';
import {FinishReason} from '@google/genai';
import OpenAI from 'openai';
import {afterEach, describe, expect, it} from 'vitest';
import {
  FakeFetch,
  fakeJsonFetch,
  fakeStreamFetch,
} from './fake_openai_fetch.js';

/** Builds a one-turn user request. */
function userRequest(config?: LlmRequest['config']): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    config,
    toolsDict: {},
    liveConnectConfig: {},
  };
}

/** Builds a provider whose client is wired to the fake fetch. */
function llmWith(
  fake: FakeFetch,
  params: OpenAiResponsesLlmParams = {},
): OpenAiResponsesLlm {
  return new OpenAiResponsesLlm({
    model: 'gpt-5',
    client: new OpenAI({apiKey: 'test-key', fetch: fake.fetch}),
    ...params,
  });
}

/** Drains the provider's responses into an array. */
async function collect(
  llm: OpenAiResponsesLlm,
  options: {
    request?: LlmRequest;
    stream?: boolean;
    abortSignal?: AbortSignal;
  } = {},
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  const stream = await llm.generateContentAsync(
    options.request ?? userRequest(),
    options.stream ?? false,
    options.abortSignal,
  );
  for await (const response of stream) {
    responses.push(response);
  }
  return responses;
}

/**
 * Drains an Azure provider with the global fetch replaced by the double.
 *
 * These tests exercise the client the provider builds for itself, so the
 * double cannot be handed in through the `client` option.
 */
async function collectAzure(
  params: AzureOpenAiResponsesLlmParams,
  fake: FakeFetch,
): Promise<LlmResponse[]> {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await collect(new AzureOpenAiResponsesLlm(params));
  } finally {
    globalThis.fetch = original;
  }
}

/** A completed response carrying one line of text. */
const HELLO_RESPONSE = {
  id: 'resp_1',
  model: 'gpt-5',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{type: 'output_text', text: 'Hello'}],
    },
  ],
};

/** A completed response carrying nothing. */
const EMPTY_RESPONSE = {id: 'resp_1', status: 'completed', output: []};

describe('OpenAiResponsesLlm', () => {
  it('claims no model patterns', () => {
    expect(OpenAiResponsesLlm.supportedModels).toEqual([]);
  });

  it('defaults the model to gpt-5', () => {
    expect(new OpenAiResponsesLlm().model).toBe('gpt-5');
  });

  it('refuses a live connection', async () => {
    await expect(
      new OpenAiResponsesLlm({model: 'gpt-5'}).connect(),
    ).rejects.toThrow('Live connection is not supported for gpt-5.');
  });

  it('posts a Responses request and surfaces the reply', async () => {
    const fake = fakeJsonFetch(HELLO_RESPONSE);

    const responses = await collect(llmWith(fake));

    expect(fake.requests[0].url).toBe('https://api.openai.com/v1/responses');
    expect(fake.requests[0].body).toMatchObject({
      model: 'gpt-5',
      stream: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{type: 'input_text', text: 'Hi'}],
        },
      ],
    });
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts).toEqual([{text: 'Hello'}]);
    expect(responses[0].interactionId).toBe('resp_1');
    expect(responses[0].customMetadata).toBeDefined();
  });

  it('drops the raw response metadata but keeps the usage', async () => {
    const fake = fakeJsonFetch({
      ...EMPTY_RESPONSE,
      usage: {input_tokens: 3, output_tokens: 2, total_tokens: 5},
    });

    const responses = await collect(
      llmWith(fake, {includeResponseMetadata: false}),
    );

    expect(responses[0].customMetadata).toBeUndefined();
    expect(responses[0].usageMetadata).toMatchObject({totalTokenCount: 5});
  });

  it('sends stop sequences as the body stop field', async () => {
    const fake = fakeJsonFetch(EMPTY_RESPONSE);

    await collect(llmWith(fake), {
      request: userRequest({stopSequences: ['END']}),
    });

    expect(fake.requests[0].body).toMatchObject({stop: ['END']});
  });

  it('lets extraRequestArgs override a computed key on the wire', async () => {
    const fake = fakeJsonFetch(EMPTY_RESPONSE);

    await collect(llmWith(fake, {extraRequestArgs: {model: 'gpt-5-mini'}}));

    expect(fake.requests[0].body).toMatchObject({model: 'gpt-5-mini'});
  });

  it('forwards the abort signal to the SDK', async () => {
    const fake = fakeJsonFetch(EMPTY_RESPONSE);
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(llmWith(fake), {abortSignal: controller.signal}),
    ).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  it('streams partials, a reasoning boundary and a final response', async () => {
    const fake = fakeStreamFetch([
      {
        type: 'response.created',
        sequence_number: 0,
        response: {id: 'resp_s', model: 'gpt-5'},
      },
      {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: 1,
        output_index: 0,
        summary_index: 0,
        item_id: 'rs_1',
        delta: 'Think',
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 2,
        output_index: 1,
        content_index: 0,
        item_id: 'msg_1',
        logprobs: [],
        delta: 'Hel',
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 3,
        output_index: 1,
        content_index: 0,
        item_id: 'msg_1',
        logprobs: [],
        delta: 'lo',
      },
      {
        type: 'response.completed',
        sequence_number: 4,
        response: {
          id: 'resp_s',
          model: 'gpt-5',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              summary: [{type: 'summary_text', text: 'Think'}],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{type: 'output_text', text: 'Hello'}],
            },
          ],
        },
      },
    ]);

    const responses = await collect(llmWith(fake), {stream: true});

    expect(fake.requests[0].body).toMatchObject({stream: true});
    expect(responses[0].partial).toBe(true);
    expect(responses[0].content?.parts).toEqual([
      {text: 'Think', thought: true},
    ]);
    expect(responses[1].content).toBeUndefined();
    expect(responses[1].customMetadata).toMatchObject({
      openai_response: {stream_event: {reasoning_done: true}},
    });
    expect(responses[2].content?.parts?.[0].text).toBe('Hel');
    expect(responses[3].content?.parts?.[0].text).toBe('lo');
    // The completed event carries the authoritative response, so the final
    // one is converted rather than assembled and leaves `partial` unset.
    expect(responses[4].partial).toBeUndefined();
    expect(responses[4].content?.parts).toEqual([
      {text: 'Think', thought: true, thoughtSignature: undefined},
      {text: 'Hello'},
    ]);
  });

  it('stops after a failed stream event', async () => {
    const fake = fakeStreamFetch([
      {
        type: 'response.output_text.delta',
        sequence_number: 0,
        output_index: 0,
        content_index: 0,
        item_id: 'msg_1',
        logprobs: [],
        delta: 'partial',
      },
      {
        type: 'response.failed',
        sequence_number: 1,
        response: {id: 'resp_1', status: 'failed'},
      },
    ]);

    const responses = await collect(llmWith(fake), {stream: true});

    expect(responses).toHaveLength(2);
    expect(responses[0].partial).toBe(true);
    expect(responses[1].finishReason).toBe(FinishReason.OTHER);
  });

  it('uses the client it was given over the api key', async () => {
    const provided = fakeJsonFetch(EMPTY_RESPONSE);
    const llm = new OpenAiResponsesLlm({
      model: 'gpt-5',
      apiKey: 'ignored',
      client: new OpenAI({apiKey: 'test-key', fetch: provided.fetch}),
    });

    await collect(llm);

    expect(provided.requests).toHaveLength(1);
    expect(provided.requests[0].headers.get('authorization')).toBe(
      'Bearer test-key',
    );
  });

  it('builds its client once and reuses it', async () => {
    const fake = fakeJsonFetch(EMPTY_RESPONSE);
    const llm = llmWith(fake);

    await collect(llm);
    await collect(llm);

    expect(fake.requests).toHaveLength(2);
  });

  it('resolves a callable api key', async () => {
    const fake = fakeJsonFetch(EMPTY_RESPONSE);
    const original = globalThis.fetch;
    globalThis.fetch = fake.fetch;
    try {
      await collect(new OpenAiResponsesLlm({apiKey: () => 'dynamic-key'}));
    } finally {
      globalThis.fetch = original;
    }

    expect(fake.requests[0].headers.get('authorization')).toBe(
      'Bearer dynamic-key',
    );
  });
});

describe('AzureOpenAiResponsesLlm', () => {
  const savedAzureKey = process.env['AZURE_OPENAI_API_KEY'];

  afterEach(() => {
    if (savedAzureKey === undefined) {
      delete process.env['AZURE_OPENAI_API_KEY'];
    } else {
      process.env['AZURE_OPENAI_API_KEY'] = savedAzureKey;
    }
  });

  it('posts to the Azure OpenAI-compatible v1 endpoint', async () => {
    const fake = fakeJsonFetch(EMPTY_RESPONSE);

    await collectAzure(
      {
        model: 'my-deployment',
        apiKey: 'test-key',
        azureEndpoint: 'https://example.openai.azure.com/',
      },
      fake,
    );

    expect(fake.requests[0].url).toBe(
      'https://example.openai.azure.com/openai/v1/responses',
    );
  });

  it('reads the api key from the Azure environment variable', async () => {
    process.env['AZURE_OPENAI_API_KEY'] = 'env-key';
    const fake = fakeJsonFetch(EMPTY_RESPONSE);

    await collectAzure(
      {
        model: 'my-deployment',
        azureEndpoint: 'https://example.openai.azure.com',
      },
      fake,
    );

    expect(fake.requests[0].headers.get('authorization')).toBe(
      'Bearer env-key',
    );
    expect(fake.requests[0].url).toBe(
      'https://example.openai.azure.com/openai/v1/responses',
    );
  });

  it('prefers an explicit api key over the environment variable', async () => {
    process.env['AZURE_OPENAI_API_KEY'] = 'env-key';
    const fake = fakeJsonFetch(EMPTY_RESPONSE);

    await collectAzure(
      {
        model: 'my-deployment',
        apiKey: 'explicit-key',
        azureEndpoint: 'https://example.openai.azure.com',
      },
      fake,
    );

    expect(fake.requests[0].headers.get('authorization')).toBe(
      'Bearer explicit-key',
    );
  });
});
