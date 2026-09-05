/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_data_insights_tool.py`
 * (branch `main`).
 */

import {
  askDataInsights,
  BigQueryClientCache,
  createBigQueryToolConfig,
  type BigQueryToolDeps,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/** The options argument of the global `fetch`. */
type FetchOptions = Parameters<typeof fetch>[1];

const {getAccessToken} = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => ({token: 'test-token'})),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return {getAccessToken};
    }
  },
}));

/** Builds the deps the tool runs with. */
function deps(maxQueryResultRows = 50): BigQueryToolDeps {
  return {
    clients: new BigQueryClientCache(),
    settings: createBigQueryToolConfig({maxQueryResultRows}),
  };
}

/** The arguments every test calls the tool with. */
const INPUT = {
  project_id: 'some-project-id',
  user_query_with_context: 'Which customer spent the most last month?',
  table_references: [
    {projectId: 'my-gcp-project', datasetId: 'sales_data', tableId: 'orders'},
  ],
};

/** A response whose body streams `lines`. */
function streamResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    }),
    {status: 200},
  );
}

const originalFetch = globalThis.fetch;
let requests: Array<[string, FetchOptions]> = [];

beforeEach(() => {
  requests = [];
  getAccessToken.mockResolvedValue({token: 'test-token'});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Installs a fetch that answers with `lines`. */
function answerWith(lines: string[]): void {
  globalThis.fetch = async (
    url: string | URL | Request,
    init?: FetchOptions,
  ): Promise<Response> => {
    requests.push([String(url), init]);
    return streamResponse(lines);
  };
}

describe('askDataInsights', () => {
  it('test_ask_data_insights_success', async () => {
    answerWith(['{"systemMessage": {"Answer": "Jane Doe spent the most."}}']);

    const result = await askDataInsights(INPUT, deps());

    expect(result).toEqual({
      status: 'SUCCESS',
      response: [{Answer: 'Jane Doe spent the most.'}],
    });
  });

  it('test_ask_data_insights_pipeline_from_file', async () => {
    answerWith([
      '{"systemMessage": {"SQL Generated": "SELECT 1"}}',
      JSON.stringify({
        systemMessage: {
          data: {
            result: {
              schema: {fields: [{name: 'customer_name'}]},
              data: [{customer_name: 'Jane Doe'}],
            },
          },
        },
      }),
      '{"systemMessage": {"Answer": "Jane Doe."}}',
    ]);

    const result = await askDataInsights(INPUT, deps());

    expect(result).toEqual({
      status: 'SUCCESS',
      response: [
        {'SQL Generated': 'SELECT 1'},
        {
          'Data Retrieved': {
            headers: ['customer_name'],
            rows: [['Jane Doe']],
            summary: 'Showing all 1 rows.',
          },
        },
        {Answer: 'Jane Doe.'},
      ],
    });
  });

  it('sends the chat request the API expects', async () => {
    answerWith(['{"systemMessage": {"Answer": "ok"}}']);

    await askDataInsights(INPUT, deps());

    const [url, init] = requests[0];
    expect(url).toBe(
      'https://geminidataanalytics.googleapis.com/v1/projects/' +
        'some-project-id/locations/global:chat',
    );
    expect(init?.headers).toMatchObject({
      'Authorization': 'Bearer test-token',
      'X-Goog-API-Client': 'GOOGLE_ADK',
    });
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      messages: [
        {userMessage: {text: 'Which customer spent the most last month?'}},
      ],
      clientIdEnum: 'GOOGLE_ADK',
    });
  });

  it('caps a retrieved result at the configured row count', async () => {
    answerWith([
      JSON.stringify({
        systemMessage: {
          data: {
            result: {
              schema: {fields: [{name: 'n'}]},
              data: [{n: 1}, {n: 2}, {n: 3}],
            },
          },
        },
      }),
    ]);

    const result = await askDataInsights(INPUT, deps(2));

    expect(result).toMatchObject({
      response: [
        {
          'Data Retrieved': {
            rows: [[1], [2]],
            summary: 'Showing the first 2 of 3 total rows.',
          },
        },
      ],
    });
  });

  it('test_ask_data_insights_handles_exception', async () => {
    globalThis.fetch = async (): Promise<Response> => {
      throw new Error('network unreachable');
    };

    await expect(askDataInsights(INPUT, deps())).resolves.toEqual({
      status: 'ERROR',
      error_details: 'network unreachable',
    });
  });

  it('reports an unusable credential as a failure, not a throw', async () => {
    getAccessToken.mockResolvedValue({token: ''});

    await expect(askDataInsights(INPUT, deps())).resolves.toEqual({
      status: 'ERROR',
      error_details:
        'Could not obtain an access token for the Conversational Analytics' +
        ' API.',
    });
  });
});
