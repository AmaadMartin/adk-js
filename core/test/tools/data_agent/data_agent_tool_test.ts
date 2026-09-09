/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth, OAuth2Client} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The tools under test are internal, so every collaborator is imported from
// `src` too: mixing `@google/adk` in would give the shared types two
// identities and break the typecheck.
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {LlmAgent} from '../../../src/agents/llm_agent.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {InMemorySessionService} from '../../../src/sessions/in_memory_session_service.js';
import {createSession} from '../../../src/sessions/session.js';
import {DataAgentCredentialsConfig} from '../../../src/tools/data_agent/credentials.js';
import {
  askDataAgent,
  DataAgentToolDeps,
  extractLocationFromResourceName,
  getDataAgentInfo,
  listAccessibleDataAgents,
} from '../../../src/tools/data_agent/data_agent_tool.js';

const GLOBAL_ENDPOINT = 'https://geminidataanalytics.googleapis.com';
const EU_ENDPOINT = 'https://geminidataanalytics.eu.rep.googleapis.com';
const AGENT_NAME = 'projects/p/locations/global/dataAgents/a';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

/** Returns the requests the code under test issued, in order. */
function recordedRequests() {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    headers: new Headers(init?.headers),
    method: init?.method,
    body: init?.body,
  }));
}

/** Queues a JSON response for the next `fetch` call. */
function queueJson(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: {'Content-Type': 'application/json'},
    }),
  );
}

/** Queues a streaming chat response built from newline-delimited fragments. */
function queueStream(lines: string[]): void {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join('\n')));
      controller.close();
    },
  });
  fetchMock.mockResolvedValueOnce(new Response(stream));
}

/** Builds credentials backed by a real OAuth2 client holding a fixed token. */
function tokenCredentials(token = 'test-token'): DataAgentCredentialsConfig {
  const authClient = new OAuth2Client();
  authClient.credentials = {access_token: token};
  return new DataAgentCredentialsConfig({authClient});
}

/** Builds a tool context whose session state holds the given entries. */
function toolContextWithState(state: Record<string, unknown>): Context {
  const agent = new LlmAgent({name: 'analyst'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({
        id: 'session-1',
        appName: 'analyst',
        userId: 'user-1',
        state,
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
  });
}

/** The default dependency set: a fixed bearer token and no settings. */
function deps(overrides: Partial<DataAgentToolDeps> = {}): DataAgentToolDeps {
  return {credentials: tokenCredentials(), ...overrides};
}

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('extractLocationFromResourceName', () => {
  it('returns the location segment', () => {
    expect(
      extractLocationFromResourceName('projects/p/locations/eu/dataAgents/a1'),
    ).toBe('eu');
    expect(
      extractLocationFromResourceName('projects/p/locations/us/dataAgents/a2'),
    ).toBe('us');
    expect(
      extractLocationFromResourceName(
        'projects/p/locations/global/dataAgents/a3',
      ),
    ).toBe('global');
  });

  it('returns undefined when the name has no location', () => {
    expect(extractLocationFromResourceName('invalid_name')).toBeUndefined();
  });

  it('returns undefined when locations is the last segment', () => {
    expect(
      extractLocationFromResourceName('projects/p/locations'),
    ).toBeUndefined();
  });
});

describe('host injection through a model-supplied resource name', () => {
  // A resource name reaches these tools straight from the model, and its
  // location segment is interpolated into the endpoint host. Anything that
  // ends the authority would send the bearer token to another origin.
  const HOSTILE_NAMES = [
    'projects/p/locations/a@evil.example#/dataAgents/x',
    'projects/p/locations/a.evil.example/dataAgents/x',
    'projects/p/locations/evil.example%23/dataAgents/x',
    'projects/p/locations/a:9999/dataAgents/x',
  ];

  it.each(HOSTILE_NAMES)('getDataAgentInfo refuses %s', async (name) => {
    const result = await getDataAgentInfo({dataAgentName: name}, deps());

    expect(result).toMatchObject({
      status: 'ERROR',
      errorDetails: expect.stringContaining('Invalid Data Agent location'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(HOSTILE_NAMES)('askDataAgent refuses %s', async (name) => {
    const result = await askDataAgent(
      {dataAgentName: name, query: 'q'},
      deps(),
    );

    expect(result).toMatchObject({
      status: 'ERROR',
      errorDetails: expect.stringContaining('Invalid Data Agent location'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps every request on googleapis.com when the settings pin a location', async () => {
    // A pinned location is used verbatim, so the hostile segment never reaches
    // the host. It stays in the path, where it cannot move the request.
    queueJson({name: 'ok'});
    queueStream(['[{', '"systemMessage": {"text": "hi"}', '}]']);

    await askDataAgent(
      {dataAgentName: HOSTILE_NAMES[0], query: 'q'},
      deps({settings: {location: 'eu'}}),
    );

    const requests = recordedRequests();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new URL(request.url).hostname).toBe(
        'geminidataanalytics.eu.rep.googleapis.com',
      );
    }
  });

  it('sends the bearer token only to a googleapis.com host', async () => {
    queueJson({name: 'ok'});

    await getDataAgentInfo(
      {dataAgentName: 'projects/p/locations/us-central1/dataAgents/x'},
      deps(),
    );

    const [request] = recordedRequests();
    expect(request.headers.get('Authorization')).toBe('Bearer test-token');
    expect(new URL(request.url).hostname).toBe(
      'geminidataanalytics-us-central1.googleapis.com',
    );
  });
});

describe('listAccessibleDataAgents', () => {
  it('calls the global listAccessible URL and returns the agents', async () => {
    queueJson({dataAgents: ['agent1', 'agent2']});

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project'},
      deps(),
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      response: ['agent1', 'agent2'],
    });
    const [request] = recordedRequests();
    expect(request.url).toBe(
      `${GLOBAL_ENDPOINT}/v1/projects/test-project/locations/global/dataAgents:listAccessible`,
    );
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(request.headers.get('X-Goog-API-Client')).toBe('GOOGLE_ADK');
    expect(request.headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('returns an empty list when the body carries no dataAgents', async () => {
    queueJson({});

    expect(
      await listAccessibleDataAgents({projectId: 'test-project'}, deps()),
    ).toEqual({status: 'SUCCESS', response: []});
  });

  it('routes to the regional endpoint and path for a location', async () => {
    queueJson({dataAgents: ['agent_eu']});

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project'},
      deps({settings: {location: 'eu'}}),
    );

    expect(result).toEqual({status: 'SUCCESS', response: ['agent_eu']});
    expect(recordedRequests()[0].url).toBe(
      `${EU_ENDPOINT}/v1/projects/test-project/locations/eu/dataAgents:listAccessible`,
    );
  });

  it('reports a rejected request as an error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('List failed!'));

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project'},
      deps(),
    );

    expect(result.status).toBe('ERROR');
    expect(result).toMatchObject({
      errorDetails: expect.stringContaining('List failed!'),
    });
  });

  it('reports a non-2xx response as an error', async () => {
    queueJson({error: 'boom'}, 500);

    const result = await listAccessibleDataAgents(
      {projectId: 'test-project'},
      deps(),
    );

    expect(result.status).toBe('ERROR');
    expect(result).toMatchObject({
      errorDetails: expect.stringContaining('500'),
    });
  });
});

describe('getDataAgentInfo', () => {
  it('calls the resource URL and returns the parsed body', async () => {
    queueJson({name: 'agent_name'});

    const result = await getDataAgentInfo(
      {dataAgentName: 'agent_name'},
      deps(),
    );

    expect(result).toEqual({status: 'SUCCESS', response: {name: 'agent_name'}});
    expect(recordedRequests()[0].url).toBe(`${GLOBAL_ENDPOINT}/v1/agent_name`);
  });

  it('derives the endpoint from the resource name', async () => {
    queueJson({name: 'agent_eu'});

    const result = await getDataAgentInfo(
      {dataAgentName: 'projects/my-proj/locations/eu/dataAgents/my-agent'},
      deps({settings: {}}),
    );

    expect(result.status).toBe('SUCCESS');
    expect(recordedRequests()[0].url).toBe(
      `${EU_ENDPOINT}/v1/projects/my-proj/locations/eu/dataAgents/my-agent`,
    );
  });

  it('prefers the configured location over the resource name', async () => {
    queueJson({name: 'agent'});

    await getDataAgentInfo(
      {dataAgentName: 'projects/my-proj/locations/eu/dataAgents/my-agent'},
      deps({settings: {location: 'us-central1'}}),
    );

    expect(recordedRequests()[0].url).toBe(
      'https://geminidataanalytics-us-central1.googleapis.com/v1/projects/my-proj/locations/eu/dataAgents/my-agent',
    );
  });

  it('prefers a custom endpoint over the resource name', async () => {
    queueJson({name: 'agent'});

    await getDataAgentInfo(
      {dataAgentName: 'projects/my-proj/locations/eu/dataAgents/my-agent'},
      deps({settings: {apiEndpoint: 'custom.example.com'}}),
    );

    expect(recordedRequests()[0].url).toBe(
      'https://custom.example.com/v1/projects/my-proj/locations/eu/dataAgents/my-agent',
    );
  });

  it('reports a rejected request as an error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Get failed!'));

    const result = await getDataAgentInfo(
      {dataAgentName: 'agent_name'},
      deps(),
    );

    expect(result).toMatchObject({
      status: 'ERROR',
      errorDetails: expect.stringContaining('Get failed!'),
    });
  });
});

describe('askDataAgent', () => {
  const chatFixture = [
    '[{',
    '"systemMessage": {"text": "thinking"}',
    '}',
    ',',
    '{',
    '"systemMessage": {"data": {"result": {"data": [{"a":1},{"a":2}], "schema": {"fields":[{"name":"a"}]}}}}',
    '}]',
  ];

  it('preflights the agent, posts the chat payload and reads the stream', async () => {
    queueJson({name: AGENT_NAME});
    queueStream(chatFixture);

    const result = await askDataAgent(
      {dataAgentName: AGENT_NAME, query: 'how many?'},
      deps({settings: {maxQueryResultRows: 1}}),
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      response: [
        {text: 'thinking'},
        {
          'Data Retrieved': {
            headers: ['a'],
            rows: [[1]],
            summary: 'Showing the first 1 of 2 total rows.',
          },
        },
      ],
    });

    const [preflight, chat] = recordedRequests();
    expect(preflight.url).toBe(`${GLOBAL_ENDPOINT}/v1/${AGENT_NAME}`);
    expect(chat.url).toBe(
      `${GLOBAL_ENDPOINT}/v1/projects/p/locations/global:chat`,
    );
    expect(chat.method).toBe('POST');
    expect(chat.headers.get('X-Goog-API-Client')).toBe('GOOGLE_ADK');
    expect(JSON.parse(String(chat.body))).toEqual({
      messages: [{userMessage: {text: 'how many?'}}],
      dataAgentContext: {dataAgent: AGENT_NAME},
      clientIdEnum: 'GOOGLE_ADK',
    });
  });

  it('sends the preflight to the configured endpoint, not the derived one', async () => {
    // adk-python drops the settings for the preflight, which sends the bearer
    // token to the public host even when the author pinned a private one.
    queueJson({name: 'projects/p/locations/eu/dataAgents/a'});
    queueStream(['[{', '"systemMessage": {"text": "hi"}', '}]']);

    await askDataAgent(
      {dataAgentName: 'projects/p/locations/eu/dataAgents/a', query: 'q'},
      deps({settings: {apiEndpoint: 'private.example.test'}}),
    );

    const [preflight, chat] = recordedRequests();
    expect(preflight.url).toBe(
      'https://private.example.test/v1/projects/p/locations/eu/dataAgents/a',
    );
    expect(chat.url).toBe(
      'https://private.example.test/v1/projects/p/locations/eu:chat',
    );
  });

  it('defaults to 50 rows when no settings are given', async () => {
    const rows = Array.from({length: 51}, (_, i) => ({a: i}));
    queueJson({name: AGENT_NAME});
    queueStream([
      '[{',
      `"systemMessage": {"data": {"result": {"data": ${JSON.stringify(rows)}, "schema": {"fields":[{"name":"a"}]}}}}`,
      '}]',
    ]);

    const result = await askDataAgent(
      {dataAgentName: AGENT_NAME, query: 'how many?'},
      deps(),
    );

    expect(result).toMatchObject({
      status: 'SUCCESS',
      response: [
        {
          'Data Retrieved': expect.objectContaining({
            summary: 'Showing the first 50 of 51 total rows.',
          }),
        },
      ],
    });
  });

  it('routes the chat call to the location in the resource name', async () => {
    queueJson({name: 'projects/p/locations/eu/dataAgents/a'});
    queueStream(['[{', '"systemMessage": {"text": "hi"}', '}]']);

    await askDataAgent(
      {dataAgentName: 'projects/p/locations/eu/dataAgents/a', query: 'q'},
      deps(),
    );

    expect(recordedRequests()[1].url).toBe(
      `${EU_ENDPOINT}/v1/projects/p/locations/eu:chat`,
    );
  });

  it('short-circuits and never issues the chat call when the preflight fails', async () => {
    queueJson({error: 'not found'}, 404);

    const result = await askDataAgent(
      {dataAgentName: AGENT_NAME, query: 'q'},
      deps(),
    );

    expect(result).toMatchObject({
      status: 'ERROR',
      errorDetails: expect.stringContaining('404'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a stream that fails mid-read as an error', async () => {
    queueJson({name: AGENT_NAME});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{\n'));
        controller.error(new Error('Chat failed!'));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream));

    const result = await askDataAgent(
      {dataAgentName: AGENT_NAME, query: 'q'},
      deps(),
    );

    expect(result).toMatchObject({
      status: 'ERROR',
      errorDetails: expect.stringContaining('Chat failed!'),
    });
  });
});

describe('DataAgentCredentialsConfig', () => {
  it('reads an external access token out of the tool context state', async () => {
    queueJson({dataAgents: []});
    const credentials = new DataAgentCredentialsConfig({
      externalAccessTokenKey: 'gda_token',
    });

    const result = await listAccessibleDataAgents(
      {projectId: 'p'},
      {
        credentials,
        toolContext: toolContextWithState({gda_token: 'user-token'}),
      },
    );

    expect(result.status).toBe('SUCCESS');
    expect(recordedRequests()[0].headers.get('Authorization')).toBe(
      'Bearer user-token',
    );
  });

  it('fails with the key name when the token is absent from the state', async () => {
    const credentials = new DataAgentCredentialsConfig({
      externalAccessTokenKey: 'gda_token',
    });

    const result = await listAccessibleDataAgents(
      {projectId: 'p'},
      {credentials, toolContext: toolContextWithState({})},
    );

    expect(result).toMatchObject({
      status: 'ERROR',
      errorDetails: expect.stringContaining('gda_token'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails when no tool context is supplied at all', async () => {
    const credentials = new DataAgentCredentialsConfig({
      externalAccessTokenKey: 'gda_token',
    });

    const result = await listAccessibleDataAgents(
      {projectId: 'p'},
      {
        credentials,
      },
    );

    expect(result).toMatchObject({
      status: 'ERROR',
      errorDetails: expect.stringContaining('gda_token'),
    });
  });

  it('rejects an authClient combined with an externalAccessTokenKey', () => {
    expect(
      () =>
        new DataAgentCredentialsConfig({
          authClient: new OAuth2Client(),
          externalAccessTokenKey: 'gda_token',
        }),
    ).toThrowError(/externalAccessTokenKey/);
  });

  it('rejects scopes combined with an externalAccessTokenKey', () => {
    expect(
      () =>
        new DataAgentCredentialsConfig({
          scopes: ['https://www.googleapis.com/auth/bigquery'],
          externalAccessTokenKey: 'gda_token',
        }),
    ).toThrowError(/scopes/);
  });

  it('defaults to the BigQuery scope', () => {
    expect(new DataAgentCredentialsConfig().scopes).toEqual([
      'https://www.googleapis.com/auth/bigquery',
    ]);
    expect(
      new DataAgentCredentialsConfig({scopes: ['custom-scope']}).scopes,
    ).toEqual(['custom-scope']);
  });

  it('authenticates every request with Application Default Credentials', async () => {
    const adcClient = new OAuth2Client();
    adcClient.credentials = {access_token: 'adc-token'};
    const getClient = vi
      .spyOn(GoogleAuth.prototype, 'getClient')
      .mockResolvedValue(adcClient);
    const credentials = new DataAgentCredentialsConfig();
    queueJson({dataAgents: []});
    queueJson({dataAgents: []});

    await listAccessibleDataAgents({projectId: 'p'}, {credentials});
    await listAccessibleDataAgents({projectId: 'p'}, {credentials});

    expect(getClient).toHaveBeenCalled();
    for (const request of recordedRequests()) {
      expect(request.headers.get('Authorization')).toBe('Bearer adc-token');
    }
  });

  it('retries the credential lookup after a transient failure', async () => {
    const adcClient = new OAuth2Client();
    adcClient.credentials = {access_token: 'adc-token'};
    const getClient = vi
      .spyOn(GoogleAuth.prototype, 'getClient')
      .mockRejectedValueOnce(new Error('metadata server unreachable'))
      .mockResolvedValue(adcClient);
    const credentials = new DataAgentCredentialsConfig();
    queueJson({dataAgents: []});

    const failed = await listAccessibleDataAgents(
      {projectId: 'p'},
      {
        credentials,
      },
    );
    const retried = await listAccessibleDataAgents(
      {projectId: 'p'},
      {
        credentials,
      },
    );

    expect(failed).toMatchObject({
      status: 'ERROR',
      errorDetails: expect.stringContaining('metadata server unreachable'),
    });
    expect(retried.status).toBe('SUCCESS');
    expect(getClient).toHaveBeenCalledTimes(2);
  });
});
