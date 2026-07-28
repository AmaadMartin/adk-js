/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for {@link Claude} (Anthropic on Vertex AI) and its resolution
 * helpers. These exercise the Vertex transport, project/location resolution,
 * bearer-token auth wiring and the Vertex request-body contract with
 * `google-auth-library` and `globalThis.fetch` mocked at the module boundary.
 *
 * The base {@link AnthropicLlm} machinery reused by `Claude` is covered by
 * `anthropic_llm_test.ts`; this file focuses on the Vertex-specific code.
 */

import {
  AnthropicLlm,
  Claude,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AnthropicMessage,
  buildVertexEndpoint,
  buildVertexHost,
  resolveVertexConfig,
  resolveVertexModelId,
  toVertexRequestBody,
} from '../../src/models/anthropic_llm.js';
import {version} from '../../src/version.js';

const PROJECT_ENV = 'GOOGLE_CLOUD_PROJECT';
const LOCATION_ENV = 'GOOGLE_CLOUD_LOCATION';
const CLAUDE_DEFAULT_MODEL = 'claude-3-5-sonnet-v2@20241022';
const RESOURCE_NAME =
  'projects/test-project/locations/test-location/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022';

// Mock google-auth-library so the Vertex tests can assert the outbound request
// without real Application Default Credentials. A plain class (rather than a
// `vi.fn()`) survives `vi.restoreAllMocks()`; the module-level `let`s are read
// lazily so each test can reconfigure the credential behavior.
let mockRequestHeaders: Headers;
let authShouldThrow = false;

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      if (authShouldThrow) {
        throw new Error('ADC failure');
      }
      return {
        getRequestHeaders: async () => mockRequestHeaders,
      };
    }
  },
}));

function makeRequest(overrides: Record<string, unknown> = {}): LlmRequest {
  return {
    model: CLAUDE_DEFAULT_MODEL,
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    config: {},
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

function textMessage(text: string): AnthropicMessage {
  return {
    id: 'msg_test',
    model: CLAUDE_DEFAULT_MODEL,
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    content: [{type: 'text', text}],
    usage: {input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0},
  };
}

function mockFetchJson(message: AnthropicMessage): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => message,
    text: async () => JSON.stringify(message),
  });
}

function makeStreamBody(events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map(
    (event) =>
      `event: ${(event as {type: string}).type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function mockFetchStream(events: object[]): void {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValue({ok: true, status: 200, body: makeStreamBody(events)});
}

async function collect(
  gen: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of gen) {
    responses.push(response);
  }
  return responses;
}

function fetchedUrl(): string {
  return vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
}

function fetchedHeaders(): Record<string, string> {
  return vi.mocked(globalThis.fetch).mock.calls[0][1]!.headers as Record<
    string,
    string
  >;
}

function requestBody(): Record<string, unknown> {
  const call = vi.mocked(globalThis.fetch).mock.calls[0];
  return JSON.parse((call[1] as {body: string}).body);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('resolveVertexModelId', () => {
  it('extracts the bare model id from a publisher resource name', () => {
    expect(resolveVertexModelId(RESOURCE_NAME)).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('extracts the model id from an endpoint resource name', () => {
    expect(
      resolveVertexModelId('projects/p/locations/l/endpoints/my-endpoint'),
    ).toBe('my-endpoint');
  });

  it('passes a plain model id through unchanged', () => {
    expect(resolveVertexModelId('claude-sonnet-4-20250514')).toBe(
      'claude-sonnet-4-20250514',
    );
  });
});

describe('buildVertexHost', () => {
  it('resolves the global host', () => {
    expect(buildVertexHost('global')).toBe('https://aiplatform.googleapis.com');
  });

  it('resolves the multi-region hosts', () => {
    expect(buildVertexHost('us')).toBe(
      'https://aiplatform.us.rep.googleapis.com',
    );
    expect(buildVertexHost('eu')).toBe(
      'https://aiplatform.eu.rep.googleapis.com',
    );
  });

  it('treats any other value as a specific region', () => {
    expect(buildVertexHost('us-east5')).toBe(
      'https://us-east5-aiplatform.googleapis.com',
    );
  });
});

describe('buildVertexEndpoint', () => {
  it('builds the rawPredict URL for non-streaming', () => {
    expect(buildVertexEndpoint('https://h', 'p', 'l', 'm', false)).toBe(
      'https://h/v1/projects/p/locations/l/publishers/anthropic/models/m:rawPredict',
    );
  });

  it('builds the streamRawPredict URL for streaming', () => {
    expect(buildVertexEndpoint('https://h', 'p', 'l', 'm', true)).toBe(
      'https://h/v1/projects/p/locations/l/publishers/anthropic/models/m:streamRawPredict',
    );
  });
});

describe('toVertexRequestBody', () => {
  it('drops the model field and adds anthropic_version', () => {
    const result = toVertexRequestBody({
      model: 'claude-x',
      max_tokens: 10,
      messages: [],
      stream: true,
    });
    expect(result).not.toHaveProperty('model');
    expect(result['anthropic_version']).toBe('vertex-2023-10-16');
    expect(result['max_tokens']).toBe(10);
    expect(result['stream']).toBe(true);
  });
});

describe('resolveVertexConfig', () => {
  let originalProject: string | undefined;
  let originalLocation: string | undefined;

  beforeEach(() => {
    originalProject = process.env[PROJECT_ENV];
    originalLocation = process.env[LOCATION_ENV];
    delete process.env[PROJECT_ENV];
    delete process.env[LOCATION_ENV];
  });

  afterEach(() => {
    restoreEnv(PROJECT_ENV, originalProject);
    restoreEnv(LOCATION_ENV, originalLocation);
  });

  it('prefers a full resource name over explicit args and env vars', () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'env-location';
    expect(
      resolveVertexConfig(RESOURCE_NAME, 'arg-project', 'arg-loc'),
    ).toEqual({
      project: 'test-project',
      location: 'test-location',
      modelId: CLAUDE_DEFAULT_MODEL,
    });
  });

  it('prefers explicit args over env vars', () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'env-location';
    expect(resolveVertexConfig('claude-x', 'arg-project', 'arg-loc')).toEqual({
      project: 'arg-project',
      location: 'arg-loc',
      modelId: 'claude-x',
    });
  });

  it('falls back to environment variables', () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'env-location';
    expect(resolveVertexConfig('claude-x')).toEqual({
      project: 'env-project',
      location: 'env-location',
      modelId: 'claude-x',
    });
  });

  it('treats a non-matching resource-name prefix as a plain model', () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'env-location';
    expect(resolveVertexConfig('projects/incomplete')).toEqual({
      project: 'env-project',
      location: 'env-location',
      modelId: 'projects/incomplete',
    });
  });

  it('throws when neither project nor location can be resolved', () => {
    expect(() => resolveVertexConfig('claude-x')).toThrow(
      /GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set/,
    );
  });

  it('throws when only project is resolved (location missing)', () => {
    process.env[PROJECT_ENV] = 'env-project';
    expect(() => resolveVertexConfig('claude-x')).toThrow(
      /GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set/,
    );
  });

  it('throws when only location is resolved (project missing)', () => {
    process.env[LOCATION_ENV] = 'env-location';
    expect(() => resolveVertexConfig('claude-x')).toThrow(
      /GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set/,
    );
  });

  it('does not read env vars in a browser environment', () => {
    (globalThis as {window?: unknown}).window = {};
    try {
      expect(resolveVertexConfig('claude-x', 'p', 'l')).toEqual({
        project: 'p',
        location: 'l',
        modelId: 'claude-x',
      });
      process.env[PROJECT_ENV] = 'env-project';
      process.env[LOCATION_ENV] = 'env-location';
      expect(() => resolveVertexConfig('claude-x')).toThrow(
        /GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set/,
      );
    } finally {
      delete (globalThis as {window?: unknown}).window;
    }
  });
});

describe('Claude (Vertex)', () => {
  let originalProject: string | undefined;
  let originalLocation: string | undefined;

  beforeEach(() => {
    originalProject = process.env[PROJECT_ENV];
    originalLocation = process.env[LOCATION_ENV];
    delete process.env[PROJECT_ENV];
    delete process.env[LOCATION_ENV];
    mockRequestHeaders = new Headers({Authorization: 'Bearer test-token'});
    authShouldThrow = false;
  });

  afterEach(() => {
    restoreEnv(PROJECT_ENV, originalProject);
    restoreEnv(LOCATION_ENV, originalLocation);
    vi.restoreAllMocks();
  });

  it('is exported from the public @google/adk entry point', () => {
    expect(Claude).toBeDefined();
  });

  it('defaults the model to claude-3-5-sonnet-v2@20241022', () => {
    expect(new Claude().model).toBe(CLAUDE_DEFAULT_MODEL);
  });

  it('accepts a custom model without applying the default', () => {
    expect(new Claude({model: 'claude-sonnet-4-20250514'}).model).toBe(
      'claude-sonnet-4-20250514',
    );
  });

  it('inherits the two supported model regexes from AnthropicLlm', () => {
    expect(Claude.supportedModels).toHaveLength(2);
    expect(Claude.supportedModels[0]).toEqual(/claude-3-.*/);
    expect(Claude.supportedModels[1]).toEqual(/claude-.*-4.*/);
  });

  it('does not require an Anthropic API key', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(() => new Claude()).not.toThrow();
    } finally {
      restoreEnv('ANTHROPIC_API_KEY', original);
    }
  });

  it('targets the Vertex endpoint derived from env project/location', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'env-location';
    mockFetchJson(textMessage('ok'));
    await collect(new Claude().generateContentAsync(makeRequest(), false));
    expect(fetchedUrl()).toBe(
      'https://env-location-aiplatform.googleapis.com/v1/projects/env-project/locations/env-location/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict',
    );
  });

  it('parses project/location from a full resource name, overriding env vars', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'env-location';
    mockFetchJson(textMessage('ok'));
    await collect(
      new Claude({model: RESOURCE_NAME}).generateContentAsync(
        makeRequest(),
        false,
      ),
    );
    expect(fetchedUrl()).toBe(
      'https://test-location-aiplatform.googleapis.com/v1/projects/test-project/locations/test-location/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict',
    );
  });

  it('uses explicit project and location options', async () => {
    mockFetchJson(textMessage('ok'));
    await collect(
      new Claude({
        project: 'arg-project',
        location: 'us-central1',
      }).generateContentAsync(makeRequest(), false),
    );
    expect(fetchedUrl()).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/arg-project/locations/us-central1/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict',
    );
  });

  it('sends bearer auth and ADK tracking headers, not x-api-key', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'global';
    mockFetchJson(textMessage('ok'));
    await collect(new Claude().generateContentAsync(makeRequest(), false));
    const headers = fetchedHeaders();
    expect(headers['Authorization']).toBe('Bearer test-token');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-goog-api-client']).toBeDefined();
    expect(headers['user-agent']).toBe(
      `google-adk/${version} gl-typescript/${process.version}`,
    );
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-version']).toBeUndefined();
  });

  it('emits the Vertex body contract (anthropic_version, no model)', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'global';
    mockFetchJson(textMessage('ok'));
    await collect(new Claude().generateContentAsync(makeRequest(), false));
    const body = requestBody();
    expect(body['anthropic_version']).toBe('vertex-2023-10-16');
    expect(body).not.toHaveProperty('model');
    expect(body['max_tokens']).toBe(8192);
  });

  it('maps the Anthropic message into an LlmResponse over the Vertex transport', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'global';
    mockFetchJson(textMessage('Hi from Vertex'));
    const responses = await collect(
      new Claude().generateContentAsync(makeRequest(), false),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0]?.text).toBe('Hi from Vertex');
    expect(responses[0].usageMetadata?.promptTokenCount).toBe(5);
    expect(responses[0].finishReason).toBe('STOP');
  });

  it('uses the streamRawPredict endpoint and aggregates a streamed response', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'global';
    mockFetchStream([
      {
        type: 'message_start',
        message: {usage: {input_tokens: 1, output_tokens: 0}},
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {type: 'text', text: ''},
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {type: 'text_delta', text: 'streamed'},
      },
      {
        type: 'message_delta',
        delta: {stop_reason: 'end_turn'},
        usage: {output_tokens: 1},
      },
      {type: 'message_stop'},
    ]);
    const responses = await collect(
      new Claude().generateContentAsync(makeRequest(), true),
    );
    expect(fetchedUrl()).toBe(
      'https://aiplatform.googleapis.com/v1/projects/env-project/locations/global/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:streamRawPredict',
    );
    expect(requestBody()['stream']).toBe(true);
    const final = responses[responses.length - 1];
    expect(final.partial).toBe(false);
    expect(final.content?.parts?.[0]?.text).toBe('streamed');
  });

  it('honors the inherited baseUrl as a Vertex host override', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'us-east5';
    mockFetchJson(textMessage('ok'));
    await collect(
      new Claude({baseUrl: 'http://127.0.0.1:8123'}).generateContentAsync(
        makeRequest(),
        false,
      ),
    );
    expect(fetchedUrl()).toBe(
      'http://127.0.0.1:8123/v1/projects/env-project/locations/us-east5/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict',
    );
  });

  it('resolves the Vertex config and auth client once across calls', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'global';
    const llm = new Claude();
    mockFetchJson(textMessage('one'));
    await collect(llm.generateContentAsync(makeRequest(), false));
    mockFetchJson(textMessage('two'));
    await collect(llm.generateContentAsync(makeRequest(), false));
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(fetchedUrl()).toContain('env-project');
  });

  it('throws when project/location cannot be resolved', async () => {
    mockFetchJson(textMessage('ok'));
    await expect(
      collect(new Claude().generateContentAsync(makeRequest(), false)),
    ).rejects.toThrow(
      /GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set/,
    );
  });

  it('throws when no Google Cloud credentials are available', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'global';
    mockRequestHeaders = new Headers();
    mockFetchJson(textMessage('ok'));
    await expect(
      collect(new Claude().generateContentAsync(makeRequest(), false)),
    ).rejects.toThrow(
      'Failed to obtain Google Cloud credentials for Vertex AI.',
    );
  });

  it('propagates auth failures from google-auth-library', async () => {
    process.env[PROJECT_ENV] = 'env-project';
    process.env[LOCATION_ENV] = 'global';
    authShouldThrow = true;
    mockFetchJson(textMessage('ok'));
    await expect(
      collect(new Claude().generateContentAsync(makeRequest(), false)),
    ).rejects.toThrow('ADC failure');
  });

  it('is not the registry default for claude-* (opt-in via direct construction)', () => {
    // Documented divergence from adk-python: the base AnthropicLlm owns the
    // claude-* registration, so the registry resolves to it, not the Vertex
    // variant. The Vertex transport is opt-in via `new Claude(...)`.
    expect(LLMRegistry.resolve(CLAUDE_DEFAULT_MODEL)).toBe(AnthropicLlm);
    expect(LLMRegistry.resolve(CLAUDE_DEFAULT_MODEL)).not.toBe(Claude);
  });
});
