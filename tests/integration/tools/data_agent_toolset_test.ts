/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the data agent tools through a real agent turn: the runner, the
 * agent, the session service and the toolset are the real ones. Only the
 * model and the HTTP layer are doubles, so no project and no network are
 * needed.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  DataAgentToolset,
  Event,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRunner} from '../test_case_utils.js';

const AGENT_NAME = 'projects/test-project/locations/global/dataAgents/sales';
const GDA_HOST = 'https://geminidataanalytics.googleapis.com';

/** The chat reply a data agent streams for the question below. */
const CHAT_STREAM = [
  '[{',
  '"systemMessage": {"text": {"parts": ["Reading the table"],' +
    ' "textType": "THOUGHT"}}',
  '}',
  ',',
  '{',
  '"systemMessage": {"data": {"result": {"data": [{"orders": 42}],' +
    ' "schema": {"fields": [{"name": "orders"}]}}}}',
  '}]',
].join('\n');

/** Answers each request by URL, and records the order they arrived in. */
function stubHttp(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith(':chat')) {
        return new Response(CHAT_STREAM, {status: 200});
      }
      if (url.includes('?dataAgentId=')) {
        return new Response(
          JSON.stringify({name: AGENT_NAME, done: true, response: {}}),
          {status: 200},
        );
      }
      return new Response(JSON.stringify({name: AGENT_NAME}), {status: 200});
    }),
  );
  return urls;
}

/** A model that calls one tool, then answers with the text it was given. */
class OneToolLlm extends BaseLlm {
  constructor(
    private readonly tool: string,
    private readonly args: Record<string, unknown>,
  ) {
    super({model: 'one-tool-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const answered = (request.contents ?? []).flatMap((content) =>
      (content.parts ?? []).flatMap((part) =>
        part.functionResponse?.name ? [part.functionResponse.name] : [],
      ),
    );
    if (!answered.includes(this.tool)) {
      yield {
        content: {
          role: 'model',
          parts: [{functionCall: {name: this.tool, args: this.args}}],
        },
      };
      return;
    }
    yield {content: {role: 'model', parts: [{text: 'done'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Method not implemented.');
  }
}

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

/** Builds an agent holding one data agent toolset. */
function makeAgent(model: BaseLlm, toolset: DataAgentToolset): LlmAgent {
  return new LlmAgent({
    model,
    name: 'data_agent',
    description: 'Agent with the data agent toolset',
    instruction: "Answer questions about the user's data using data agents.",
    tools: [toolset],
  });
}

/** Every tool response one run produced, keyed by tool name. */
async function toolResponses(
  run: (prompt: string) => AsyncGenerator<Event, void, undefined>,
  prompt: string,
): Promise<Record<string, unknown>> {
  const responses: Record<string, unknown> = {};
  for await (const event of run(prompt)) {
    for (const part of event.content?.parts ?? []) {
      const response = part.functionResponse;
      if (response?.name) {
        responses[response.name] = response.response;
      }
    }
  }
  return responses;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DataAgentToolset in an LlmAgent', () => {
  it('offers only the read tools to the model by default', async () => {
    const model = new CapturingLlm();
    const {run} = await createRunner(makeAgent(model, new DataAgentToolset()));

    for await (const _event of run('What can you do?')) {
      // Drain the run so the request is fully built.
    }

    const declared =
      model.lastRequest?.config?.tools
        ?.flatMap((tool) => ('functionDeclarations' in tool ? tool : []))
        .flatMap((tool) => tool.functionDeclarations ?? []) ?? [];
    expect(declared.map((tool) => tool.name)).toEqual([
      'list_accessible_data_agents',
      'get_data_agent_info',
      'ask_data_agent',
    ]);
  });

  it('answers a question with the rows the data agent read', async () => {
    const urls = stubHttp();
    const toolset = new DataAgentToolset();
    const {run} = await createRunner(
      makeAgent(
        new OneToolLlm('ask_data_agent', {
          data_agent_name: AGENT_NAME,
          query: 'how many orders?',
        }),
        toolset,
      ),
    );

    const responses = await toolResponses(run, 'How many orders are there?');

    expect(responses['ask_data_agent']).toEqual({
      status: 'SUCCESS',
      response: [
        {text: {parts: ['Reading the table'], textType: 'THOUGHT'}},
        {
          'Data Retrieved': {
            headers: ['orders'],
            rows: [[42]],
            summary: 'Showing all 1 rows.',
          },
        },
      ],
    });
    expect(urls).toEqual([
      `${GDA_HOST}/v1/${AGENT_NAME}`,
      `${GDA_HOST}/v1/projects/test-project/locations/global:chat`,
    ]);
    await toolset.close();
  });

  it('creates a data agent once modification is enabled', async () => {
    const urls = stubHttp();
    const toolset = new DataAgentToolset({
      dataAgentToolConfig: {enableDataAgentModification: true},
    });
    const {run} = await createRunner(
      makeAgent(
        new OneToolLlm('create_data_agent', {
          project_id: 'test-project',
          data_agent_id: 'sales',
          agent_config: '{"displayName": "Sales"}',
        }),
        toolset,
      ),
    );

    const responses = await toolResponses(run, 'Create a sales data agent');

    expect(responses['create_data_agent']).toEqual({
      status: 'SUCCESS',
      response: {},
    });
    expect(urls).toEqual([
      `${GDA_HOST}/v1/projects/test-project/locations/global/dataAgents?dataAgentId=sales`,
    ]);
    await toolset.close();
  });

  it('reports a rejected data agent to the model instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no such agent', {status: 404})),
    );
    const toolset = new DataAgentToolset();
    const {run} = await createRunner(
      makeAgent(
        new OneToolLlm('ask_data_agent', {
          data_agent_name: AGENT_NAME,
          query: 'how many orders?',
        }),
        toolset,
      ),
    );

    const responses = await toolResponses(run, 'How many orders are there?');

    expect(responses['ask_data_agent']).toEqual({
      status: 'ERROR',
      error_details: 'API returned error status: 404 no such agent',
    });
    await toolset.close();
  });
});
