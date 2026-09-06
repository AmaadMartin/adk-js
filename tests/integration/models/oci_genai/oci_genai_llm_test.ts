/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `OciGenAiLlm` against a real HTTP server that answers the OCI
 * Generative AI chat contract. Nothing is mocked: the real OCI SDK builds and
 * signs the request with a real RSA key from a real config file, sends it over
 * a socket, and the provider parses what comes back. It is the counterpart of
 * the unit tests, which fake the client and so cannot catch a wrong URL, an
 * unsigned request or a body the SDK refuses to serialize.
 */

import {LlmAgent, LlmRequest, LlmResponse, OciGenAiLlm} from '@google/adk';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {createRunner} from '../../test_case_utils.js';

const MODEL = 'google.gemini-2.5-flash';
const COMPARTMENT_ID = 'ocid1.compartment.oc1..example';
const CHAT_PATH = '/20231130/actions/chat';

/** One request the local OCI service received. */
interface ReceivedRequest {
  url?: string;
  authorization?: string;
  body: {
    compartmentId?: string;
    servingMode?: {servingType?: string; modelId?: string};
    chatRequest?: {
      apiFormat?: string;
      isStream?: boolean;
      messages?: Array<{role?: string; content?: Array<{text?: string}>}>;
    };
  };
}

/** An OCI config file and the RSA key it names, in a private directory. */
function writeOciConfig(directory: string): string {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const keyPath = join(directory, 'key.pem');
  writeFileSync(keyPath, privateKey.export({type: 'pkcs1', format: 'pem'}));
  const configPath = join(directory, 'config');
  writeFileSync(
    configPath,
    [
      '[DEFAULT]',
      'user=ocid1.user.oc1..example',
      'fingerprint=aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
      'tenancy=ocid1.tenancy.oc1..example',
      'region=us-chicago-1',
      `key_file=${keyPath}`,
      '',
    ].join('\n'),
  );
  return configPath;
}

function chatResultBody(text: string): string {
  return JSON.stringify({
    modelId: MODEL,
    modelVersion: '1.0',
    chatResponse: {
      apiFormat: 'GENERIC',
      timeCreated: new Date(0).toISOString(),
      choices: [
        {
          index: 0,
          finishReason: 'stop',
          message: {role: 'ASSISTANT', content: [{type: 'TEXT', text}]},
        },
      ],
      usage: {promptTokens: 3, completionTokens: 1},
    },
  });
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collect(
  responseStream: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const received: LlmResponse[] = [];
  for await (const response of responseStream) {
    received.push(response);
  }
  return received;
}

function newRequest(text: string): LlmRequest {
  return {
    model: MODEL,
    contents: [{role: 'user', parts: [{text}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

describe('OciGenAiLlm against a local OCI service', () => {
  const received: ReceivedRequest[] = [];
  let directory: string;
  let configPath: string;
  let server: Server;
  let serviceEndpoint: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'adk-oci-'));
    configPath = writeOciConfig(directory);

    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const parsed = JSON.parse(body || '{}') as ReceivedRequest['body'];
        received.push({
          url: request.url,
          authorization: request.headers.authorization,
          body: parsed,
        });
        if (!parsed.chatRequest?.isStream) {
          response.writeHead(200, {'content-type': 'application/json'});
          response.end(chatResultBody('Hello from OCI.'));
          return;
        }
        response.writeHead(200, {'content-type': 'text/event-stream'});
        response.write(
          sseEvent({
            index: 0,
            message: {
              role: 'ASSISTANT',
              content: [{type: 'TEXT', text: 'Hel'}],
            },
          }),
        );
        response.write(
          sseEvent({
            index: 0,
            message: {role: 'ASSISTANT', content: [{type: 'TEXT', text: 'lo'}]},
          }),
        );
        response.write(
          sseEvent({usage: {promptTokens: 3, completionTokens: 2}}),
        );
        response.end('data: [DONE]\n\n');
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    serviceEndpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, {recursive: true, force: true});
  });

  function newLlm(): OciGenAiLlm {
    return new OciGenAiLlm({
      model: MODEL,
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint,
      authFileLocation: configPath,
    });
  }

  function lastRequest(): ReceivedRequest {
    const request = received[received.length - 1];
    if (!request) {
      expect.fail('the local OCI service received no request');
    }
    return request;
  }

  it('answers a non-streaming request', async () => {
    const responses = await collect(
      newLlm().generateContentAsync(newRequest('Say hello')),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts).toEqual([{text: 'Hello from OCI.'}]);
    expect(responses[0].usageMetadata?.totalTokenCount).toBe(4);
  });

  it('signs the chat request and posts it to the chat action', () => {
    const request = lastRequest();

    expect(request.url).toBe(CHAT_PATH);
    expect(request.authorization).toMatch(/^Signature version="1"/);
    expect(request.body.compartmentId).toBe(COMPARTMENT_ID);
    expect(request.body.servingMode).toEqual({
      servingType: 'ON_DEMAND',
      modelId: MODEL,
    });
    expect(request.body.chatRequest?.apiFormat).toBe('GENERIC');
    expect(request.body.chatRequest?.messages).toEqual([
      {role: 'USER', content: [{type: 'TEXT', text: 'Say hello'}]},
    ]);
  });

  it('reads a streamed answer off the wire', async () => {
    const responses = await collect(
      newLlm().generateContentAsync(newRequest('Say hello'), true),
    );

    expect(responses.map((response) => response.partial)).toEqual([
      true,
      true,
      false,
    ]);
    expect(responses[0].content?.parts).toEqual([{text: 'Hel'}]);
    expect(responses[2].content?.parts).toEqual([{text: 'Hello'}]);
    expect(responses[2].usageMetadata?.totalTokenCount).toBe(5);
    expect(lastRequest().body.chatRequest?.isStream).toBe(true);
  });

  it('answers through an LlmAgent', async () => {
    const runner = await createRunner(
      new LlmAgent({name: 'oci_agent', model: newLlm()}),
    );

    let text = '';
    for await (const event of runner.run('Say hello')) {
      for (const part of event.content?.parts ?? []) {
        text += part.text ?? '';
      }
    }

    expect(text).toContain('Hello from OCI.');
  });

  it('reports an unreadable config file', async () => {
    const llm = new OciGenAiLlm({
      model: MODEL,
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint,
      authFileLocation: join(directory, 'absent-config'),
    });

    await expect(
      collect(llm.generateContentAsync(newRequest('Say hello'))),
    ).rejects.toThrow();
  });
});
