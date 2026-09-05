/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  SpannerCredentialsConfig,
  SpannerToolset,
  SpannerVectorStoreSettings,
} from '@google/adk/tools/spanner';
import {OAuth2Client} from 'google-auth-library';
import {Readable} from 'node:stream';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createRunner} from '../test_case_utils.js';

/** One identity for every end user, the simplest valid configuration. */
function credentialsConfig(): SpannerCredentialsConfig {
  return {authClient: new OAuth2Client()};
}

const VECTOR_STORE: SpannerVectorStoreSettings = {
  projectId: 'test-project',
  instanceId: 'orders',
  databaseId: 'catalog',
  tableName: 'documents',
  contentColumn: 'content',
  embeddingColumn: 'embedding',
  vectorLength: 768,
  vertexAiEmbeddingModelName: 'text-embedding-005',
};

/**
 * A double for `@google-cloud/spanner` holding only what
 * `spanner_execute_sql` touches.
 *
 * A closed client rejects every later call, as the real one does. Without
 * that, a tool reusing a client it already closed would look healthy here.
 */
const spanner = vi.hoisted(() => {
  const clients: Array<{closed: boolean}> = [];

  class FakeSpanner {
    private readonly state = {closed: false};

    constructor() {
      clients.push(this.state);
    }

    instance() {
      const state = this.state;
      return {
        database: () => ({
          getDatabaseDialect: async () => 'GOOGLE_STANDARD_SQL',
          getSnapshot: async () => [
            {
              runStream: () =>
                Readable.from(
                  (async function* () {
                    if (state.closed) {
                      throw new Error('The client has already been closed.');
                    }
                    yield [
                      {name: 'name', value: 'The Hotel'},
                      {name: 'rating', value: 4.1},
                    ];
                  })(),
                ),
              end: () => {},
            },
          ],
          close: async () => {},
        }),
      };
    }

    async close(): Promise<void> {
      this.state.closed = true;
    }
  }

  return {clients, Spanner: FakeSpanner};
});

vi.mock('@google-cloud/spanner', () => ({Spanner: spanner.Spanner}));

/** Records the request the agent builds, so the tool wiring can be asserted. */
class CapturingLlm extends BaseLlm {
  lastRequest?: LlmRequest;

  constructor() {
    super({model: 'capturing-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.lastRequest = request;
    yield {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

async function captureRequest(toolset: SpannerToolset): Promise<LlmRequest> {
  const model = new CapturingLlm();
  const agent = new LlmAgent({
    model,
    name: 'spanner_agent',
    description: 'Agent with the Spanner toolset',
    instruction: 'Answer questions about the Spanner database.',
    tools: [toolset],
  });

  const {run} = await createRunner(agent);
  for await (const _event of run('What tables are there?')) {
    // Drain the run so the request is fully built.
  }

  const request = model.lastRequest;
  if (!request) {
    return expect.fail('the agent never called the model');
  }
  return request;
}

function declaredTools(request: LlmRequest) {
  return (
    request.config?.tools
      ?.flatMap((tool) => ('functionDeclarations' in tool ? tool : []))
      .flatMap((tool) => tool.functionDeclarations ?? []) ?? []
  );
}

describe('SpannerToolset in an LlmAgent', () => {
  it('offers the seven prefixed tools to the model', async () => {
    // No Spanner client is needed to advertise the tools: the peer dependency
    // is loaded on the first tool call.
    const request = await captureRequest(
      new SpannerToolset({credentialsConfig: credentialsConfig()}),
    );

    expect(declaredTools(request).map((tool) => tool.name)).toEqual([
      'spanner_list_table_names',
      'spanner_list_table_indexes',
      'spanner_list_table_index_columns',
      'spanner_list_named_schemas',
      'spanner_get_table_schema',
      'spanner_execute_sql',
      'spanner_similarity_search',
    ]);
  });

  it('offers the vector store search when one is configured', async () => {
    const request = await captureRequest(
      new SpannerToolset({
        credentialsConfig: credentialsConfig(),
        spannerToolSettings: {vectorStoreSettings: VECTOR_STORE},
      }),
    );

    expect(declaredTools(request).map((tool) => tool.name)).toContain(
      'spanner_vector_store_similarity_search',
    );
  });

  it('offers only the filtered tools to the model', async () => {
    const request = await captureRequest(
      new SpannerToolset({
        credentialsConfig: credentialsConfig(),
        toolFilter: ['spanner_execute_sql', 'spanner_list_table_names'],
      }),
    );

    expect(
      declaredTools(request)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['spanner_execute_sql', 'spanner_list_table_names']);
  });

  it('declares the arguments spanner_execute_sql takes', async () => {
    const request = await captureRequest(
      new SpannerToolset({credentialsConfig: credentialsConfig()}),
    );
    const executeSql = declaredTools(request).find(
      (tool) => tool.name === 'spanner_execute_sql',
    );

    expect(Object.keys(executeSql?.parameters?.properties ?? {})).toEqual([
      'project_id',
      'instance_id',
      'database_id',
      'query',
    ]);
    expect(executeSql?.parameters?.required?.sort()).toEqual([
      'database_id',
      'instance_id',
      'project_id',
      'query',
    ]);
  });
});

/** Calls `spanner_execute_sql` once per turn, then answers with text. */
class ExecuteSqlLlm extends BaseLlm {
  constructor() {
    super({model: 'execute-sql-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    // Only the newest message matters: by the second turn the history already
    // holds the first turn's response, which must not suppress a fresh call.
    const latest = request.contents?.at(-1);
    if (latest?.parts?.some((part) => part.functionResponse)) {
      yield {content: {role: 'model', parts: [{text: 'done'}]}};
      return;
    }
    yield {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'spanner_execute_sql',
              args: {
                project_id: 'test-project',
                instance_id: 'orders',
                database_id: 'catalog',
                query: 'SELECT name, rating FROM hotels',
              },
            },
          },
        ],
      },
    };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

/** Runs one turn and returns what `spanner_execute_sql` answered. */
async function executeSqlOverOneTurn(
  run: (prompt: string) => AsyncGenerator<Event, void, undefined>,
  prompt: string,
): Promise<unknown> {
  let answer: unknown;
  for await (const event of run(prompt)) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse?.name === 'spanner_execute_sql') {
        answer = part.functionResponse.response;
      }
    }
  }
  return answer;
}

describe('SpannerToolset across turns', () => {
  beforeEach(() => {
    spanner.clients.length = 0;
  });

  it('answers a second turn after the first one closed its client', async () => {
    const agent = new LlmAgent({
      model: new ExecuteSqlLlm(),
      name: 'spanner_agent',
      description: 'Agent with the Spanner toolset',
      instruction: 'Answer questions about the Spanner database.',
      tools: [new SpannerToolset({credentialsConfig: credentialsConfig()})],
    });
    const {run} = await createRunner(agent);

    const first = await executeSqlOverOneTurn(run, 'How are the hotels rated?');
    const second = await executeSqlOverOneTurn(run, 'Ask again');

    const expected = {status: 'SUCCESS', rows: [['The Hotel', 4.1]]};
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    // Each call builds its own client and closes it, so the second turn never
    // meets the first turn's closed client.
    expect(spanner.clients).toHaveLength(2);
    for (const client of spanner.clients) {
      expect(client.closed).toBe(true);
    }
  });
});
