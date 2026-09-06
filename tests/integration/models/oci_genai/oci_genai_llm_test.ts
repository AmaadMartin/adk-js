/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives OCIGenAILlm end to end with nothing stubbed inside adk-js.
 *
 * A local HTTP server stands in for the OCI Generative AI inference endpoint,
 * and a generated key pair plus a temporary OCI config file let the real
 * `oci-common` signer and the real `oci-generativeaiinference` client run. So
 * the request each test inspects is the one the SDK actually put on the wire,
 * and the response each agent sees came back over HTTP.
 */

import {FunctionTool, LlmAgent} from '@google/adk';
import {OCIGenAILlm} from '@google/adk/models/oci_genai_llm.js';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {models} from 'oci-generativeaiinference';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

import {
  isFunctionDefinition,
  isGenericChatRequest,
} from '../../../../core/test/models/oci_genai_test_utils.js';
import {createRunner} from '../../test_case_utils.js';

const COMPARTMENT_ID = 'ocid1.compartment.oc1..integration';
const MODEL = 'google.gemini-2.0-flash-001';

/**
 * One request the stub server received.
 *
 * The body is typed as the SDK's own `ChatDetails`, so every assertion below
 * reads a declared field rather than re-casting an untyped record.
 */
interface RecordedRequest {
  path: string;
  body: models.ChatDetails;
}

/** What the stub server answers with next. */
interface StubReply {
  contentType: string;
  body: string;
}

/** Builds the non-streaming chat result the OCI API returns. */
function chatResult(
  text: string,
  toolCalls: Array<Record<string, unknown>> = [],
): StubReply {
  return {
    contentType: 'application/json',
    body: JSON.stringify({
      modelId: MODEL,
      modelVersion: '1.0',
      chatResponse: {
        apiFormat: 'GENERIC',
        timeCreated: new Date(0).toISOString(),
        choices: [
          {
            index: 0,
            finishReason: 'stop',
            message: {
              role: 'ASSISTANT',
              content: text ? [{type: 'TEXT', text}] : [],
              toolCalls,
            },
          },
        ],
        usage: {promptTokens: 11, completionTokens: 7},
      },
    }),
  };
}

/** Builds a server-sent event body of chat chunks, ending with the sentinel. */
function chatStream(chunks: Array<Record<string, unknown>>): StubReply {
  return {
    contentType: 'text/event-stream',
    body:
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n',
  };
}

/** A temporary OCI config file and key pair the real signer can load. */
function writeOciConfig(directory: string): string {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const keyPath = join(directory, 'key.pem');
  writeFileSync(
    keyPath,
    privateKey.export({type: 'pkcs8', format: 'pem'}).toString(),
  );
  const configPath = join(directory, 'config');
  writeFileSync(
    configPath,
    [
      '[DEFAULT]',
      'user=ocid1.user.oc1..integration',
      'fingerprint=20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34',
      `key_file=${keyPath}`,
      'tenancy=ocid1.tenancy.oc1..integration',
      'region=us-chicago-1',
      '',
    ].join('\n'),
  );
  return configPath;
}

describe('OCIGenAILlm against a local inference endpoint', () => {
  let server: Server;
  let endpoint: string;
  let configDirectory: string;
  let configPath: string;
  const received: RecordedRequest[] = [];
  let nextReply: StubReply = chatResult('unset');

  beforeAll(async () => {
    configDirectory = mkdtempSync(join(tmpdir(), 'adk-oci-'));
    configPath = writeOciConfig(configDirectory);

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          path: request.url ?? '',
          // The one place untyped JSON becomes a typed value. The provider
          // serialised it from a ChatDetails, so this is what came back.
          body: JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as models.ChatDetails,
        });
        response.writeHead(200, {'content-type': nextReply.contentType});
        response.end(nextReply.body);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(configDirectory, {recursive: true, force: true});
  });

  /** A provider wired to the stub server and the temporary credentials. */
  function provider(): OCIGenAILlm {
    return new OCIGenAILlm({
      model: MODEL,
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint: endpoint,
      authFileLocation: configPath,
    });
  }

  /** The chat details of the most recent request the stub server received. */
  function lastRequest(): models.ChatDetails {
    const request = received[received.length - 1];
    expect(request).toBeDefined();
    return request.body;
  }

  /** The GenericChat request of the most recent call. */
  function lastChatRequest(): models.GenericChatRequest {
    const chatRequest = lastRequest().chatRequest;
    if (!isGenericChatRequest(chatRequest)) {
      expect.fail(
        `Expected a GenericChatRequest, got ${chatRequest.apiFormat}.`,
      );
    }
    return chatRequest;
  }

  it('runs an agent turn over HTTP', async () => {
    nextReply = chatResult('Chicago is sunny.');
    const runner = await createRunner(
      new LlmAgent({
        name: 'oci_weather_agent',
        model: provider(),
        instruction: 'Answer in one sentence.',
      }),
    );

    let text = '';
    for await (const event of runner.run('What is the weather in Chicago?')) {
      text += event.content?.parts?.[0]?.text ?? '';
    }

    expect(text).toBe('Chicago is sunny.');
    expect(received[received.length - 1].path).toBe('/20231130/actions/chat');
    expect(lastRequest().compartmentId).toBe(COMPARTMENT_ID);
    expect(lastRequest().servingMode).toEqual({
      servingType: 'ON_DEMAND',
      modelId: MODEL,
    });
    const chatRequest = lastChatRequest();
    expect(chatRequest.apiFormat).toBe('GENERIC');
    expect(chatRequest.isStream).toBeUndefined();
    const messages = chatRequest.messages ?? [];
    expect(messages[0].role).toBe('SYSTEM');
    expect(messages[messages.length - 1].role).toBe('USER');
  });

  it('streams an agent turn over server-sent events', async () => {
    nextReply = chatStream([
      {
        message: {
          role: 'ASSISTANT',
          content: [{type: 'TEXT', text: 'Chicago '}],
        },
      },
      {
        message: {
          role: 'ASSISTANT',
          content: [{type: 'TEXT', text: 'is sunny.'}],
        },
      },
      {usage: {promptTokens: 4, completionTokens: 3}},
    ]);
    const llm = provider();

    const partials: string[] = [];
    let final = '';
    for await (const response of llm.generateContentAsync(
      {
        model: MODEL,
        contents: [{role: 'user', parts: [{text: 'Weather?'}]}],
        liveConnectConfig: {},
        toolsDict: {},
      },
      true,
    )) {
      const text = response.content?.parts?.[0]?.text ?? '';
      if (response.partial) {
        partials.push(text);
      } else {
        final = text;
      }
    }

    expect(partials).toEqual(['Chicago ', 'is sunny.']);
    expect(final).toBe('Chicago is sunny.');
    const chatRequest = lastChatRequest();
    expect(chatRequest.isStream).toBe(true);
    expect(chatRequest.streamOptions).toEqual({isIncludeUsage: true});
  });

  it('calls a tool and sends its result back to the model', async () => {
    nextReply = chatResult('', [
      {
        id: 'call_1',
        type: 'FUNCTION',
        name: 'get_temperature',
        arguments: JSON.stringify({city: 'Chicago'}),
      },
    ]);

    const agent = new LlmAgent({
      name: 'oci_tool_agent',
      model: provider(),
      tools: [
        new FunctionTool({
          name: 'get_temperature',
          description: 'Reads the temperature of a city.',
          parameters: z.object({city: z.string()}),
          execute: async ({city}) => ({city, celsius: 22}),
        }),
      ],
    });
    const runner = await createRunner(agent);

    const calls: string[] = [];
    const results: Array<Record<string, unknown>> = [];
    for await (const event of runner.run('Temperature in Chicago?')) {
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall?.name) {
          calls.push(part.functionCall.name);
          // Answer the second turn with prose so the run terminates.
          nextReply = chatResult('It is 22 degrees.');
        }
        if (part.functionResponse?.response) {
          results.push(part.functionResponse.response);
        }
      }
    }

    expect(calls).toContain('get_temperature');
    expect(results[0]).toMatchObject({city: 'Chicago', celsius: 22});
    const chatRequest = lastChatRequest();
    const tool = chatRequest.tools?.[0];
    if (!isFunctionDefinition(tool)) {
      expect.fail('Expected a function tool definition.');
    }
    expect(tool.name).toBe('get_temperature');
    const messages = chatRequest.messages ?? [];
    expect(messages.some((m) => m.role === 'TOOL')).toBe(true);
  });

  it('reports a service error rather than swallowing it', async () => {
    // 400 rather than 429: the SDK retries a 429 with its own backoff, which
    // is the retry behaviour this provider deliberately does not duplicate.
    const failing = createServer((request, response) => {
      request.resume();
      response.writeHead(400, {'content-type': 'application/json'});
      response.end(
        JSON.stringify({code: 'InvalidParameter', message: 'bad compartment'}),
      );
    });
    await new Promise<void>((resolve) =>
      failing.listen(0, '127.0.0.1', resolve),
    );
    const port = (failing.address() as AddressInfo).port;
    const llm = new OCIGenAILlm({
      model: MODEL,
      compartmentId: COMPARTMENT_ID,
      serviceEndpoint: `http://127.0.0.1:${port}`,
      authFileLocation: configPath,
    });

    try {
      const responses = llm.generateContentAsync({
        model: MODEL,
        contents: [{role: 'user', parts: [{text: 'Hi'}]}],
        liveConnectConfig: {},
        toolsDict: {},
      });
      await expect(responses.next()).rejects.toThrow(/bad compartment/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        failing.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
