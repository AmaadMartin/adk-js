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
  SpannerAdminToolset,
  SpannerCredentialsConfig,
} from '@google/adk';
import {googleAuthLibrary} from 'google-gax';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createRunner} from '../test_case_utils.js';

/** One identity for every end user, the simplest valid configuration. */
function credentialsConfig(): SpannerCredentialsConfig {
  return {authClient: new googleAuthLibrary.OAuth2Client()};
}

/**
 * Doubles for the two Admin API clients. Only the surface
 * `spanner_list_instances` touches is needed: the parent path builder, the
 * request, and the `close()` the runner triggers between turns.
 *
 * A closed instance rejects every later call, exactly as the generated client
 * does (`if (this._terminated) return Promise.reject(...)`). Without that, a
 * tool reusing a closed client would look healthy here.
 */
const spanner = vi.hoisted(() => {
  const newInstanceAdmin = () => {
    let terminated = false;
    return {
      projectPath: (project: string) => `projects/${project}`,
      listInstances: vi.fn(async () => {
        if (terminated) {
          throw new Error('The client has already been closed.');
        }
        return [[{name: 'projects/test-project/instances/orders'}]];
      }),
      close: vi.fn(async () => {
        terminated = true;
      }),
    };
  };
  const instances: Array<ReturnType<typeof newInstanceAdmin>> = [];
  return {
    instances,
    InstanceAdminClient: vi.fn(() => {
      const client = newInstanceAdmin();
      instances.push(client);
      return client;
    }),
    DatabaseAdminClient: vi.fn(() => ({close: vi.fn(async () => {})})),
  };
});

vi.mock('@google-cloud/spanner-api', () => ({
  v1: {
    InstanceAdminClient: spanner.InstanceAdminClient,
    DatabaseAdminClient: spanner.DatabaseAdminClient,
  },
}));

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

async function captureRequest(toolset: SpannerAdminToolset) {
  const model = new CapturingLlm();
  const agent = new LlmAgent({
    model,
    name: 'spanner_admin_agent',
    description: 'Agent with the Spanner admin toolset',
    instruction: 'Administer Spanner.',
    tools: [toolset],
  });

  const {run} = await createRunner(agent);
  for await (const _event of run('List my Spanner instances')) {
    // Drain the run so the request is fully built.
  }

  const request = model.lastRequest;
  if (!request) {
    expect.fail('the agent never called the model');
  }
  return request;
}

describe('SpannerAdminToolset in an LlmAgent', () => {
  it('offers the seven prefixed admin tools to the model', async () => {
    // No `@google-cloud/spanner-api` client is needed to advertise the tools:
    // it is loaded on the first tool call.
    const request = await captureRequest(
      new SpannerAdminToolset({credentialsConfig: credentialsConfig()}),
    );

    const declared = request.config?.tools
      ?.flatMap((tool) => ('functionDeclarations' in tool ? tool : []))
      .flatMap((tool) => tool.functionDeclarations ?? [])
      .map((declaration) => declaration.name);

    expect(declared?.sort()).toEqual([
      'spanner_create_database',
      'spanner_create_instance',
      'spanner_get_instance',
      'spanner_get_instance_config',
      'spanner_list_databases',
      'spanner_list_instance_configs',
      'spanner_list_instances',
    ]);
  });

  it('offers only the filtered tools to the model', async () => {
    const request = await captureRequest(
      new SpannerAdminToolset({
        credentialsConfig: credentialsConfig(),
        toolFilter: ['spanner_list_instances', 'spanner_list_databases'],
      }),
    );

    const declared = request.config?.tools
      ?.flatMap((tool) => ('functionDeclarations' in tool ? tool : []))
      .flatMap((tool) => tool.functionDeclarations ?? [])
      .map((declaration) => declaration.name);

    expect(declared?.sort()).toEqual([
      'spanner_list_databases',
      'spanner_list_instances',
    ]);
  });
});

/** Calls `spanner_list_instances` once per turn, then answers with text. */
class ListInstancesLlm extends BaseLlm {
  constructor() {
    super({model: 'list-instances-llm'});
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

describe('SpannerAdminToolset across turns', () => {
  beforeEach(() => {
    spanner.InstanceAdminClient.mockClear();
    spanner.instances.length = 0;
  });

  it('answers a second turn after the runner closed it', async () => {
    const agent = new LlmAgent({
      model: new ListInstancesLlm(),
      name: 'spanner_admin_agent',
      description: 'Agent with the Spanner admin toolset',
      instruction: 'Administer Spanner.',
      tools: [
        new SpannerAdminToolset({credentialsConfig: credentialsConfig()}),
      ],
    });
    const {run} = await createRunner(agent);

    const first = await listInstancesOverOneTurn(run, 'List my instances');
    const second = await listInstancesOverOneTurn(run, 'List them again');

    const expected = {status: 'SUCCESS', results: ['orders']};
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    // Each call builds its own clients and closes them, so the second turn
    // never meets the first turn's closed client.
    expect(spanner.instances).toHaveLength(2);
    for (const client of spanner.instances) {
      expect(client.close).toHaveBeenCalledTimes(1);
    }
  });
});
