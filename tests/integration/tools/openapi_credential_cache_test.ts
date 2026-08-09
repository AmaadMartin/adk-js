/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  InvocationContext,
  OpenAPIToolset,
  RestApiTool,
} from '@google/adk';
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {OpenAPIV3} from 'openapi-types';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * An API that reports the headers it received, so a test can see exactly which
 * credential a tool put on the wire.
 */
class EchoHeaderServer {
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({headers: req.headers}));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  get url(): string {
    const {port} = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }
}

interface EchoResponse {
  headers: Record<string, string>;
}

function echoSpec(baseUrl: string, operationId: string): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    info: {title: 'Echo API', version: '1.0.0'},
    servers: [{url: baseUrl}],
    paths: {
      '/echo': {
        get: {
          operationId,
          responses: {'200': {description: 'The headers that were received.'}},
        },
      },
    },
  };
}

async function buildTool(options: {
  baseUrl: string;
  operationId: string;
  authScheme: OpenAPIV3.SecuritySchemeObject;
  credentialKey: string;
}): Promise<RestApiTool> {
  const toolset = new OpenAPIToolset({
    specDict: echoSpec(options.baseUrl, options.operationId),
    authScheme: options.authScheme,
    credentialKey: options.credentialKey,
  });
  const [tool] = await toolset.getTools();
  return tool as RestApiTool;
}

/**
 * A tool call sees the session state through a fresh Context, exactly as the
 * runner builds one per call. `sessionState` is the object the session holds,
 * so a credential cached by one call is visible to the next.
 */
function createContext(sessionState: Record<string, unknown>): Context {
  return new Context({
    invocationContext: {
      session: {state: sessionState},
      agent: {name: 'openapi-credential-cache-agent'},
    } as unknown as InvocationContext,
  });
}

async function callTool(
  tool: RestApiTool,
  sessionState: Record<string, unknown>,
): Promise<EchoResponse> {
  return (await tool.runAsync({
    args: {},
    toolContext: createContext(sessionState),
  })) as EchoResponse;
}

describe('OpenAPI tool credential cache over real HTTP', () => {
  const serverA = new EchoHeaderServer();
  const serverB = new EchoHeaderServer();

  beforeAll(async () => {
    await Promise.all([serverA.start(), serverB.start()]);
  });

  afterAll(async () => {
    await Promise.all([serverA.stop(), serverB.stop()]);
  });

  it('sends each apiKey tool its own key', async () => {
    const toolA = await buildTool({
      baseUrl: serverA.url,
      operationId: 'echo_a',
      authScheme: {type: 'apiKey', name: 'X-A-Key', in: 'header'},
      credentialKey: 'tool_a_key',
    });
    const toolB = await buildTool({
      baseUrl: serverB.url,
      operationId: 'echo_b',
      authScheme: {type: 'apiKey', name: 'X-B-Key', in: 'header'},
      credentialKey: 'tool_b_key',
    });

    // The client answered both credential requests. ADK reads an auth response
    // once, under `temp:<credentialKey>`, and caches what it read.
    const sessionState: Record<string, unknown> = {
      'temp:tool_a_key': {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key-a',
      } satisfies AuthCredential,
      'temp:tool_b_key': {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'key-b',
      } satisfies AuthCredential,
    };

    const responseA = await callTool(toolA, sessionState);
    const responseB = await callTool(toolB, sessionState);

    expect(responseA.headers['x-a-key']).toBe('key-a');
    expect(responseB.headers['x-b-key']).toBe('key-b');
  });

  it('sends each oauth2 tool its own bearer token', async () => {
    const toolA = await buildTool({
      baseUrl: serverA.url,
      operationId: 'echo_oauth_a',
      authScheme: {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://a.example.com/token',
            scopes: {},
          },
        },
      },
      credentialKey: 'oauth_a_key',
    });
    const toolB = await buildTool({
      baseUrl: serverB.url,
      operationId: 'echo_oauth_b',
      authScheme: {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: 'https://b.example.com/token',
            scopes: {},
          },
        },
      },
      credentialKey: 'oauth_b_key',
    });

    // What a completed OAuth2 flow leaves behind: a bearer token per tool.
    const sessionState: Record<string, unknown> = {
      'temp:oauth_a_key': {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'token-a'}},
      } satisfies AuthCredential,
      'temp:oauth_b_key': {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'token-b'}},
      } satisfies AuthCredential,
    };

    const responseA = await callTool(toolA, sessionState);
    const responseB = await callTool(toolB, sessionState);

    expect(responseA.headers['authorization']).toBe('Bearer token-a');
    expect(responseB.headers['authorization']).toBe('Bearer token-b');
  });
});
