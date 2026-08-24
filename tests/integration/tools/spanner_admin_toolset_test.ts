/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  SpannerAdminToolset,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createRunner} from '../test_case_utils.js';

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
    // No credentials and no `@google-cloud/spanner` client are needed to
    // advertise the tools: both are resolved on the first tool call.
    const request = await captureRequest(new SpannerAdminToolset());

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
