/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end tests for {@link Claude} (Anthropic on Vertex AI).
 *
 * These tests exercise the provider over the real `globalThis.fetch` and the
 * real `google-auth-library` (no mocking of either) against a single local HTTP
 * server that emulates both the GCE metadata server and the Vertex
 * `rawPredict` / `streamRawPredict` endpoints.
 *
 * Application Default Credentials are driven through the metadata server by
 * pointing `GCE_METADATA_HOST` at the local server, so the whole path -- real
 * ADC bearer minting, endpoint derivation, the Vertex request-body contract and
 * SSE parsing over a real socket -- is proven end to end with no mocks and no
 * external network or real Google credentials.
 */

import {Claude, LlmRequest, LlmResponse} from '@google/adk';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const PROJECT = 'e2e-project';
const LOCATION = 'us-east5';
const MODEL = 'claude-3-5-sonnet-v2@20241022';

interface RecordedRequest {
  url: string;
  authorization: string | undefined;
  hasApiKey: boolean;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

interface FakeServer {
  host: string;
  url: string;
  lastPredict: () => RecordedRequest | undefined;
  close: () => Promise<void>;
}

/** Emulates the GCE metadata token server and the Vertex predict endpoints. */
function startFakeServer(): Promise<FakeServer> {
  let lastPredict: RecordedRequest | undefined;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    // GCE metadata server: every response must carry the flavor header.
    if (url.startsWith('/computeMetadata/')) {
      res.setHeader('Metadata-Flavor', 'Google');
      if (url.includes('/token')) {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(
          JSON.stringify({
            access_token: 'fake-e2e-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
      } else if (url.includes('universe-domain')) {
        res.writeHead(200, {'content-type': 'text/plain'});
        res.end('googleapis.com');
      } else if (url.includes('project-id')) {
        res.writeHead(200, {'content-type': 'text/plain'});
        res.end(PROJECT);
      } else {
        res.writeHead(200, {'content-type': 'text/plain'});
        res.end('');
      }
      return;
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const authorization = req.headers['authorization'] as string | undefined;
      // A valid bearer token proves ADC auth wiring succeeded.
      if (!authorization || !authorization.startsWith('Bearer ')) {
        res.writeHead(401, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: 'missing bearer token'}));
        return;
      }

      lastPredict = {
        url,
        authorization,
        hasApiKey: req.headers['x-api-key'] !== undefined,
        contentType: req.headers['content-type'] as string | undefined,
        body: JSON.parse(raw) as Record<string, unknown>,
      };

      if (url.endsWith(':streamRawPredict')) {
        respondStreaming(res);
      } else {
        respondJson(res);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as AddressInfo;
      resolve({
        host: `127.0.0.1:${port}`,
        url: `http://127.0.0.1:${port}`,
        lastPredict: () => lastPredict,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function respondJson(res: http.ServerResponse): void {
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(
    JSON.stringify({
      id: 'msg_e2e',
      model: MODEL,
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      content: [{type: 'text', text: 'Hello from Vertex Claude.'}],
      usage: {input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 0},
    }),
  );
}

function respondStreaming(res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const send = (type: string, payload: object) => {
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({type, ...payload})}\n\n`,
    );
  };
  send('message_start', {
    message: {usage: {input_tokens: 7, output_tokens: 0}},
  });
  send('content_block_start', {
    index: 0,
    content_block: {type: 'text', text: ''},
  });
  send('content_block_delta', {
    index: 0,
    delta: {type: 'text_delta', text: 'Streamed '},
  });
  send('content_block_delta', {
    index: 0,
    delta: {type: 'text_delta', text: 'Vertex hello!'},
  });
  send('content_block_stop', {index: 0});
  send('message_delta', {
    delta: {stop_reason: 'end_turn'},
    usage: {output_tokens: 4},
  });
  send('message_stop', {});
  res.end();
}

function baseRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: MODEL,
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    config: {systemInstruction: 'You are helpful', temperature: 0.1},
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

async function collect<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

describe('Claude Vertex E2E (local server, real fetch + real ADC)', () => {
  let server: FakeServer;
  let cloudSdkConfig: string;
  let llm: Claude;
  const managedEnv = [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GCE_METADATA_HOST',
    'GCE_METADATA_IP',
    'METADATA_SERVER_DETECTION',
    'CLOUDSDK_CONFIG',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = await startFakeServer();
    // Isolate ADC resolution so it falls through to the (local) metadata server:
    // no key file, and an empty gcloud config dir so no user ADC is found.
    cloudSdkConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-claude-e2e-'));
    for (const key of managedEnv) {
      savedEnv[key] = process.env[key];
    }
    delete process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    process.env['CLOUDSDK_CONFIG'] = cloudSdkConfig;
    process.env['GCE_METADATA_HOST'] = server.host;
    process.env['GCE_METADATA_IP'] = server.host;
    process.env['METADATA_SERVER_DETECTION'] = 'assume-present';
    process.env['GOOGLE_CLOUD_PROJECT'] = PROJECT;
    process.env['GOOGLE_CLOUD_LOCATION'] = LOCATION;
    // `baseUrl` redirects the derived Vertex host at the local emulator.
    llm = new Claude({baseUrl: server.url});
  });

  afterAll(async () => {
    for (const key of managedEnv) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(cloudSdkConfig, {recursive: true, force: true});
    await server.close();
  });

  it('generates a non-streaming response and honors the Vertex contract', async () => {
    const responses = await collect(
      llm.generateContentAsync(baseRequest(), false),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0]?.text).toBe(
      'Hello from Vertex Claude.',
    );
    expect(responses[0].usageMetadata?.promptTokenCount).toBe(11);
    expect(responses[0].finishReason).toBe('STOP');

    const recorded = server.lastPredict()!;
    expect(recorded.url).toBe(
      `/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/anthropic/models/${MODEL}:rawPredict`,
    );
    // The bearer is minted by the real google-auth-library through the local
    // metadata emulator, proving the ADC auth path end to end.
    expect(recorded.authorization?.startsWith('Bearer ')).toBe(true);
    expect(recorded.authorization!.length).toBeGreaterThan('Bearer '.length);
    expect(recorded.hasApiKey).toBe(false);
    expect(recorded.contentType).toContain('application/json');
    expect(recorded.body['anthropic_version']).toBe('vertex-2023-10-16');
    expect(recorded.body).not.toHaveProperty('model');
  });

  it('streams partials then a final aggregate over the wire', async () => {
    const responses = await collect(
      llm.generateContentAsync(baseRequest(), true),
    );
    const partials = responses.filter((r) => r.partial);
    const final = responses[responses.length - 1];
    expect(partials.map((r) => r.content?.parts?.[0]?.text)).toEqual([
      'Streamed ',
      'Vertex hello!',
    ]);
    expect(final.partial).toBe(false);
    expect(final.content?.parts?.[0]?.text).toBe('Streamed Vertex hello!');
    expect(final.usageMetadata?.candidatesTokenCount).toBe(4);

    const recorded = server.lastPredict()!;
    expect(recorded.url).toBe(
      `/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/anthropic/models/${MODEL}:streamRawPredict`,
    );
    expect(recorded.body['stream']).toBe(true);
    expect(recorded.body['anthropic_version']).toBe('vertex-2023-10-16');
  });
});

// Opt-in live test against real Vertex AI. Requires valid ADC
// (`gcloud auth application-default login`), `GOOGLE_CLOUD_PROJECT` /
// `GOOGLE_CLOUD_LOCATION`, and `RUN_CLAUDE_VERTEX_LIVE_TEST=1`. Skipped by
// default so CI without cloud credentials still passes.
const runLive = process.env['RUN_CLAUDE_VERTEX_LIVE_TEST'] === '1';
describe.skipIf(!runLive)('Claude Vertex live (real credentials)', () => {
  it('completes a real generateContentAsync round trip', async () => {
    const llm = new Claude({});
    const responses = await collect(
      llm.generateContentAsync(
        baseRequest({
          contents: [
            {role: 'user', parts: [{text: 'Reply with the single word pong.'}]},
          ],
          config: {},
        }),
        false,
      ),
    );
    const final = responses[responses.length - 1] as LlmResponse;
    expect(final.content?.parts?.length).toBeGreaterThan(0);
  });
});
