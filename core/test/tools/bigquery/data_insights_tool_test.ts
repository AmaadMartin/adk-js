/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import * as dataInsightsTool from '../../../src/tools/bigquery/data_insights_tool.js';

vi.mock('google-auth-library', () => {
  return {
    GoogleAuth: vi.fn().mockImplementation(() => {
      return {
        getClient: vi.fn().mockResolvedValue({
          getAccessToken: vi.fn().mockResolvedValue({token: 'auto-token'}),
        }),
      };
    }),
  };
});

describe('Data Insights Tool', () => {
  let context: Context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = new Context({
      invocationContext: {
        session: {id: 'session-1', state: new Map()},
      } as unknown as InvocationContext,
      functionCallId: 'test-call-id',
    });
  });

  const createMockResponse = (chunks: string[]) => {
    let chunkIndex = 0;
    const mockReader = {
      read: vi.fn().mockImplementation(async () => {
        if (chunkIndex < chunks.length) {
          return {
            done: false,
            value: new TextEncoder().encode(chunks[chunkIndex++]),
          };
        }
        return {done: true};
      }),
    };
    return {
      ok: true,
      body: {
        getReader: () => mockReader,
      },
    };
  };

  it('askDataInsights should handle text response successfully', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {text: {parts: ['Answer to your question']}},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'question',
        tableReferences: [{projectId: 'p', datasetId: 'd', tableId: 't'}],
      },
      {credentials: {token: 'mock-token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {Answer: 'Answer to your question'},
    ]);
  });

  it('should handle schema response (query)', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {schema: {query: {question: 'What is the schema?'}}},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {Question: 'What is the schema?'},
    ]);
  });

  it('should handle schema response (result)', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {
          schema: {
            result: {
              datasources: [
                {
                  bigqueryTableReference: {
                    projectId: 'p',
                    datasetId: 'd',
                    tableId: 't',
                  },
                  schema: {
                    fields: [
                      {
                        name: 'c1',
                        type: 'STRING',
                        description: 'desc',
                        mode: 'NULLABLE',
                      },
                      {},
                    ],
                  },
                },
                {
                  bigqueryTableReference: {
                    projectId: 'p2',
                    datasetId: 'd2',
                    tableId: 't2',
                  },
                },
                {
                  schema: {fields: []},
                },
              ],
            },
          },
        },
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {
        'Schema Resolved': [
          {
            source_name: 'p.d.t',
            schema: {
              headers: ['Column', 'Type', 'Description', 'Mode'],
              rows: [
                ['c1', 'STRING', 'desc', 'NULLABLE'],
                ['', '', '', ''],
              ],
            },
          },
          {
            source_name: 'p2.d2.t2',
            schema: {
              headers: ['Column', 'Type', 'Description', 'Mode'],
              rows: [],
            },
          },
          {
            source_name: 'undefined.undefined.undefined',
            schema: {
              headers: ['Column', 'Type', 'Description', 'Mode'],
              rows: [],
            },
          },
        ],
      },
    ]);
  });

  it('should handle data response (query and sql)', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {
          data: {
            query: {name: 'q1', question: 'quest'},
          },
        },
      }) + '\n',
      JSON.stringify({
        systemMessage: {
          data: {
            query: {},
          },
        },
      }) + '\n',
      JSON.stringify({
        systemMessage: {
          data: {
            generatedSql: 'SELECT * FROM t',
          },
        },
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {
        'Retrieval Query': {
          'Query Name': 'q1',
          'Question': 'quest',
        },
      },
      {
        'Retrieval Query': {
          'Query Name': 'N/A',
          'Question': 'N/A',
        },
      },
      {'SQL Generated': 'SELECT * FROM t'},
    ]);
  });

  it('should handle data response (result with compacting)', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {
          data: {
            result: {
              schema: {fields: [{name: 'id'}, {name: 'val'}]},
              data: [
                {id: 1, val: 'a'},
                {id: 2, val: 'b'},
                {id: 3, val: 'c'},
              ],
            },
          },
        },
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      {maxQueryResultRows: 2} as any,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {
        'Data Retrieved': {
          headers: ['id', 'val'],
          rows: [
            [1, 'a'],
            [2, 'b'],
          ],
          summary: 'Showing the first 2 of 3 total rows.',
        },
      },
    ]);
  });

  it('should handle error in stream response', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        error: {code: 400, message: 'Bad Request'},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {
        Error: {
          Code: 400,
          Message: 'Bad Request',
        },
      },
    ]);
  });

  it('should fail if fetch returns not ok', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result: any = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toContain(
      'API call failed with status 500: Internal Server Error',
    );
  });

  it('should fail if token is missing', async () => {
    const result: any = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      undefined, // no credentials
      undefined,
      undefined, // no context
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toBe(
      'askDataInsights requires a valid access token.',
    );
  });

  it('should retrieve token from externalAccessTokenKey', async () => {
    context.state.set('my-key', 'external-token');
    const mockResponse = createMockResponse([JSON.stringify({}) + '\n']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {externalAccessTokenKey: 'my-key'},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
  });

  it('should handle schema response with missing query and result fields', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {schema: {unexpectedField: 'value'}},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([]);
  });

  it('should handle data response with missing query, generatedSql and result fields', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {data: {unexpectedField: 'value'}},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([]);
  });

  it('should handle non-Error exceptions in askDataInsights', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('String Error'));

    const result: any = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toBe('String Error');
  });

  it('should handle invalid JSON chunks in stream', async () => {
    const mockResponse = createMockResponse(['invalid-json\n']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([]);
  });

  it('should replace intermediate Data Retrieved message with subsequent message', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {
          data: {
            result: {
              schema: {fields: [{name: 'id'}]},
              data: [{id: 1}],
            },
          },
        },
      }) + '\n',
      JSON.stringify({
        systemMessage: {text: {parts: ['Final Answer']}},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([{Answer: 'Final Answer'}]);
  });

  it('should handle chunked JSON array format successfully', async () => {
    const mockResponse = createMockResponse([
      '[{\n',
      '"systemMessage": { "text": { "parts": ["First Answer"] } }\n',
      '}]\n',
      ',\n',
      '[{\n',
      '"systemMessage": { "text": { "parts": ["Second Answer"] } }\n',
      '}]\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {Answer: 'First Answer'},
      {Answer: 'Second Answer'},
    ]);
  });

  it('should fail if response body is not readable', async () => {
    const mockResponse = {
      ok: true,
      body: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result: any = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toContain('Response body is not readable.');
  });

  it('should retrieve token from GoogleAuth if credentials are not provided', async () => {
    const mockResponse = createMockResponse([JSON.stringify({}) + '\n']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
  });

  it('should handle data response with empty result (fallbacks)', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {
          data: {
            result: {},
          },
        },
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {
        'Data Retrieved': {
          headers: [],
          rows: [],
          summary: 'Showing all 0 rows.',
        },
      },
    ]);
  });

  it('should handle text response with missing parts', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {text: {}},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );
    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([{Answer: ''}]);
  });

  it('should handle schema response (query with missing question)', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {schema: {query: {}}},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );
    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([{Question: ''}]);
  });

  it('should handle schema response (result with missing datasources)', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {schema: {result: {}}},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );
    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([{'Schema Resolved': []}]);
  });

  it('should handle data response with missing maxQueryResultRows in config (fallback to 50)', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        systemMessage: {
          data: {
            result: {
              schema: {fields: [{name: 'id'}]},
              data: Array.from({length: 55}, (_, i) => ({id: i})),
            },
          },
        },
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      {} as any,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    const dataRetrieved = (result as any).response[0]['Data Retrieved'];
    expect(dataRetrieved.rows.length).toBe(50);
    expect(dataRetrieved.summary).toBe(
      'Showing the first 50 of 55 total rows.',
    );
  });

  it('should handle error in stream response with missing code and message', async () => {
    const mockResponse = createMockResponse([
      JSON.stringify({
        error: {},
      }) + '\n',
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      {credentials: {token: 'token'}},
      undefined,
      context,
    );

    expect(result.status).toBe('SUCCESS');
    expect((result as any).response).toEqual([
      {
        Error: {
          Code: 'N/A',
          Message: 'No message provided.',
        },
      },
    ]);
  });

  it('should fail if GoogleAuth returns falsy token', async () => {
    const {GoogleAuth} = await import('google-auth-library');
    vi.mocked(GoogleAuth).mockImplementationOnce(() => {
      return {
        getClient: vi.fn().mockResolvedValue({
          getAccessToken: vi.fn().mockResolvedValue({token: ''}),
        }),
      } as any;
    });

    const result: any = await dataInsightsTool.askDataInsights(
      {
        projectId: 'project',
        userQueryWithContext: 'q',
        tableReferences: [],
      },
      undefined,
      undefined,
      context,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toBe(
      'askDataInsights requires a valid access token.',
    );
  });
});
