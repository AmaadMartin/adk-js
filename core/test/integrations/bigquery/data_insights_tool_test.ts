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
 * is `createGdaStream`, so the real accumulator in `streamChat` still runs
 * over the lines the fake transport emits.
 */

import {GoogleToolStatus} from '@google/adk';
import {createBigQueryToolSettings} from '@google/adk/integrations/bigquery/config.js';
import {askDataInsights} from '@google/adk/integrations/bigquery/data_insights_tool.js';
import {
  GdaStream,
  createGdaStream,
} from '@google/adk/integrations/bigquery/gda_stream.js';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock(
  '@google/adk/integrations/bigquery/gda_stream.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@google/adk/integrations/bigquery/gda_stream.js')
      >();
    return {...original, createGdaStream: vi.fn()};
  },
);

/** What one recorded post carried. */
interface RecordedPost {
  url: string;
  payload: unknown;
  headers: unknown;
}

/** A transport that replays `lines` and records what it was asked to post. */
function fakeStream(lines: string[], posts: RecordedPost[]): GdaStream {
  return async function* stream(url, payload, headers) {
    posts.push({url, payload, headers});
    for (const line of lines) {
      yield line;
    }
  };
}

/** Installs a transport replaying `lines`, and returns what it was posted. */
function withStream(lines: string[] = []): RecordedPost[] {
  const posts: RecordedPost[] = [];
  vi.mocked(createGdaStream).mockReturnValue(fakeStream(lines, posts));
  return posts;
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
    vi.mocked(createGdaStream).mockReset();
  });

  it('returns the steps the answering agent took', async () => {
    withStream([
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
    const posts = withStream();

    await askDataInsights(
      {
        projectId: 'some-project-id',
        userQueryWithContext: 'How many orders?',
        tableReferences: TABLE_REFERENCES,
      },
      createBigQueryToolSettings(),
    );

    const [post] = posts;
    expect(post.url).toBe(
      'https://geminidataanalytics.googleapis.com/v1/projects/some-project-id/locations/global:chat',
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
    const posts = withStream();

    await askDataInsights(
      {
        projectId: 'p',
        userQueryWithContext: 'q',
        tableReferences: TABLE_REFERENCES,
      },
      createBigQueryToolSettings(),
    );

    const payload = posts[0].payload as {
      inlineContext: {systemInstruction: string};
    };
    expect(payload.inlineContext.systemInstruction).toContain('NO CHARTS');
    expect(payload.inlineContext.systemInstruction).toContain('plain text');
  });

  it('caps the rows a data message carries at the configured limit', async () => {
    withStream([
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
    vi.mocked(createGdaStream).mockReturnValue(() => {
      throw new Error('API returned 503');
    });

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

  it('authorizes the stream with the credential the tool resolved', async () => {
    withStream();
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

    expect(vi.mocked(createGdaStream)).toHaveBeenCalledWith(credentials);
  });

  it('asks the global Conversational Analytics host', async () => {
    const posts = withStream();

    await askDataInsights(
      {
        projectId: 'p',
        userQueryWithContext: 'q',
        tableReferences: TABLE_REFERENCES,
      },
      createBigQueryToolSettings(),
    );

    expect(posts[0].url).toBe(
      'https://geminidataanalytics.googleapis.com/v1/projects/p/locations/global:chat',
    );
  });
});
