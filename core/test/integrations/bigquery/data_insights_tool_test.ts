/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_data_insights_tool.py`.
 *
 * Python patches `_gda_stream_util.get_gda_session`; here the equivalent seam
 * is `createGdaSession`, so the real accumulator in `streamChat` still runs
 * over the lines the fake session emits.
 */

import {GoogleToolStatus} from '@google/adk';
import {createBigQueryToolSettings} from '@google/adk/integrations/bigquery/config.js';
import {askDataInsights} from '@google/adk/integrations/bigquery/data_insights_tool.js';
import {
  GdaRequest,
  GdaResponse,
  GdaSession,
  createGdaSession,
  resolveGdaEndpoint,
} from '@google/adk/tools/data_agent/gda_client.js';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock(
  '@google/adk/tools/data_agent/gda_client.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@google/adk/tools/data_agent/gda_client.js')
      >();
    return {...original, createGdaSession: vi.fn()};
  },
);

/** A session that replays `lines` and records what it was asked to post. */
class FakeGdaSession implements GdaSession {
  readonly posts: Array<{url: string; payload: unknown; headers: unknown}> = [];

  constructor(private readonly lines: string[]) {}

  async request(_request: GdaRequest): Promise<GdaResponse> {
    return {ok: true, status: 200, text: ''};
  }

  async *streamLines(
    url: string,
    payload: unknown,
    headers: Record<string, string>,
  ): AsyncGenerator<string> {
    this.posts.push({url, payload, headers});
    for (const line of this.lines) {
      yield line;
    }
  }
}

/** Installs `session` as the session `askDataInsights` will open. */
function withSession(
  session: GdaSession,
  endpoint = 'https://gda.example',
): void {
  vi.mocked(createGdaSession).mockResolvedValue({session, endpoint});
}

/** The wire form of one streamed system message. */
function line(message: unknown): string {
  return JSON.stringify(message);
}

const TABLE_REFERENCES = [
  {projectId: 'my-gcp-project', datasetId: 'sales_data', tableId: 'customers'},
];

describe('askDataInsights', () => {
  beforeEach(() => {
    vi.mocked(createGdaSession).mockReset();
  });

  it('returns the steps the answering agent took', async () => {
    const session = new FakeGdaSession([
      line({systemMessage: {text: {parts: ['SELECT 1']}}}),
      line({
        systemMessage: {
          data: {
            result: {
              schema: {fields: [{name: 'customer_name'}]},
              data: [{customer_name: 'Jane Doe'}],
            },
          },
        },
      }),
    ]);
    withSession(session);

    const result = await askDataInsights(
      {
        projectId: 'some-project-id',
        userQueryWithContext: 'Which customer spent the most last month?',
        tableReferences: TABLE_REFERENCES,
      },
      createBigQueryToolSettings(),
    );

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      response: [
        {text: {parts: ['SELECT 1']}},
        {
          'Data Retrieved': {
            headers: ['customer_name'],
            rows: [['Jane Doe']],
            summary: 'Showing all 1 rows.',
          },
        },
      ],
    });
  });

  it('posts the question and the tables to the chat endpoint', async () => {
    const session = new FakeGdaSession([]);
    withSession(session);

    await askDataInsights(
      {
        projectId: 'some-project-id',
        userQueryWithContext: 'How many orders?',
        tableReferences: TABLE_REFERENCES,
      },
      createBigQueryToolSettings(),
    );

    const [post] = session.posts;
    expect(post.url).toBe(
      'https://gda.example/v1/projects/some-project-id/locations/global:chat',
    );
    expect(post.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Goog-API-Client': 'GOOGLE_ADK',
    });
    expect(post.payload).toMatchObject({
      messages: [{userMessage: {text: 'How many orders?'}}],
      inlineContext: {
        datasourceReferences: {bq: {tableReferences: TABLE_REFERENCES}},
      },
      clientIdEnum: 'GOOGLE_ADK',
    });
  });

  it('forbids the answering agent from drawing charts', async () => {
    const session = new FakeGdaSession([]);
    withSession(session);

    await askDataInsights(
      {
        projectId: 'p',
        userQueryWithContext: 'q',
        tableReferences: TABLE_REFERENCES,
      },
      createBigQueryToolSettings(),
    );

    const payload = session.posts[0].payload as {
      inlineContext: {systemInstruction: string};
    };
    expect(payload.inlineContext.systemInstruction).toContain('NO CHARTS');
    expect(payload.inlineContext.systemInstruction).toContain('plain text');
  });

  it('caps the rows a data message carries at the configured limit', async () => {
    const session = new FakeGdaSession([
      line({
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
    withSession(session);

    const result = await askDataInsights(
      {
        projectId: 'p',
        userQueryWithContext: 'q',
        tableReferences: TABLE_REFERENCES,
      },
      createBigQueryToolSettings({maxQueryResultRows: 2}),
    );

    expect(result.response).toEqual([
      {
        'Data Retrieved': {
          headers: ['n'],
          rows: [[1], [2]],
          summary: 'Showing the first 2 of 3 total rows.',
        },
      },
    ]);
  });

  it('lets a transport failure out, for GoogleTool to shape', async () => {
    vi.mocked(createGdaSession).mockRejectedValue(
      new Error('API returned 503'),
    );

    await expect(
      askDataInsights(
        {
          projectId: 'p',
          userQueryWithContext: 'q',
          tableReferences: TABLE_REFERENCES,
        },
        createBigQueryToolSettings(),
      ),
    ).rejects.toThrow('API returned 503');
  });

  it('authorizes the session with the credential the tool resolved', async () => {
    const session = new FakeGdaSession([]);
    withSession(session);
    const credentials = new OAuth2Client();

    await askDataInsights(
      {
        projectId: 'p',
        userQueryWithContext: 'q',
        tableReferences: TABLE_REFERENCES,
      },
      createBigQueryToolSettings(),
      credentials,
    );

    expect(vi.mocked(createGdaSession)).toHaveBeenCalledWith(credentials, {
      location: 'global',
    });
  });

  it('asks the global Conversational Analytics host', () => {
    // The tool always passes `global`, so this is the host it reaches.
    expect(resolveGdaEndpoint({location: 'global'})).toBe(
      'https://geminidataanalytics.googleapis.com',
    );
  });
});
