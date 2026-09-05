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
  SpannerAdminToolset,
  SpannerCredentialsConfig,
} from '@google/adk/tools/spanner';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createRunner} from '../test_case_utils.js';

/** One identity for every end user, the simplest valid configuration. */
function credentialsConfig(): SpannerCredentialsConfig {
  return {authClient: new OAuth2Client()};
}

/**
 * A double for `@google-cloud/spanner` holding only what the admin tools
 * touch.
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

    getInstanceAdminClient() {
      const state = this.state;
      return {
        projectPath: (project: string) => `projects/${project}`,
        listInstancesAsync: async function* () {
          if (state.closed) {
            throw new Error('The client has already been closed.');
          }
          yield {name: 'projects/test-project/instances/orders'};
          yield {name: 'projects/test-project/instances/staging'};
        },
      };
    }

    async close(): Promise<void> {
      this.state.closed = true;
    }
  }

  return {clients, Spanner: FakeSpanner};
});

vi.mock('@google-cloud/spanner', () => ({Spanner: spanner.Spanner}));

/** Calls `spanner_list_instances` once per turn, then answers with text. */
class ListInstancesLlm extends BaseLlm {
  lastRequest?: LlmRequest;

  constructor() {
    super({model: 'list-instances-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.lastRequest = request;
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
              name: 'spanner_list_instances',
              args: {project_id: 'test-project'},
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

/** Runs one turn and returns what `spanner_list_instances` answered. */
async function listInstancesOverOneTurn(
  run: (prompt: string) => AsyncGenerator<Event, void, undefined>,
  prompt: string,
): Promise<unknown> {
  let answer: unknown;
  for await (const event of run(prompt)) {
    for (const part of event.content?.parts ?? []) {
      if (part.functionResponse?.name === 'spanner_list_instances') {
        answer = part.functionResponse.response;
      }
    }
  }
  return answer;
}

function adminAgent(toolset: SpannerAdminToolset, model: BaseLlm): LlmAgent {
  return new LlmAgent({
    model,
    name: 'spanner_admin_agent',
    description: 'Agent with the Spanner admin toolset',
    instruction: 'Help the user inspect Spanner instances.',
    tools: [toolset],
  });
}

describe('SpannerAdminToolset in an LlmAgent', () => {
  beforeEach(() => {
    spanner.clients.length = 0;
  });

  it('answers a list_instances call and closes its client', async () => {
    const {run} = await createRunner(
      adminAgent(
        new SpannerAdminToolset({credentialsConfig: credentialsConfig()}),
        new ListInstancesLlm(),
      ),
    );

    const answer = await listInstancesOverOneTurn(
      run,
      'Which Spanner instances do I have?',
    );

    expect(answer).toEqual({
      status: 'SUCCESS',
      results: ['orders', 'staging'],
    });
    expect(spanner.clients).toHaveLength(1);
    expect(spanner.clients[0].closed).toBe(true);
  });

  it('answers a second turn after the first one closed its client', async () => {
    const {run} = await createRunner(
      adminAgent(
        new SpannerAdminToolset({credentialsConfig: credentialsConfig()}),
        new ListInstancesLlm(),
      ),
    );

    const first = await listInstancesOverOneTurn(run, 'List them');
    const second = await listInstancesOverOneTurn(run, 'Ask again');

    const expected = {status: 'SUCCESS', results: ['orders', 'staging']};
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(spanner.clients).toHaveLength(2);
    for (const client of spanner.clients) {
      expect(client.closed).toBe(true);
    }
  });

  it('offers only the read-only tools when the filter names them', async () => {
    const model = new ListInstancesLlm();
    const {run} = await createRunner(
      adminAgent(
        new SpannerAdminToolset({
          credentialsConfig: credentialsConfig(),
          toolFilter: [
            'spanner_list_instances',
            'spanner_get_instance',
            'spanner_list_databases',
            'spanner_list_instance_configs',
            'spanner_get_instance_config',
          ],
        }),
        model,
      ),
    );

    await listInstancesOverOneTurn(run, 'List them');
    const declared =
      model.lastRequest?.config?.tools
        ?.flatMap((tool) => ('functionDeclarations' in tool ? tool : []))
        .flatMap((tool) => tool.functionDeclarations ?? []) ?? [];

    expect(declared.map((tool) => tool.name)).toEqual([
      'spanner_list_instances',
      'spanner_get_instance',
      'spanner_list_databases',
      'spanner_list_instance_configs',
      'spanner_get_instance_config',
    ]);
  });
});
