/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  DataAgentCredentialsConfig,
  DataAgentToolset,
  InMemorySessionService,
  InvocationContext,
  isFunctionTool,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  ToolPredicate,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const ALL_TOOL_NAMES = [
  'list_accessible_data_agents',
  'get_data_agent_info',
  'ask_data_agent',
];

/** Returns the names of the given tools, in order. */
function namesOf(tools: BaseTool[]): string[] {
  return tools.map((tool) => tool.name);
}

/** Builds an invocation context whose session state holds the given entries. */
function invocationContext(state: Record<string, unknown> = {}) {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'analyst'}),
    session: createSession({
      id: 'session-1',
      appName: 'analyst',
      userId: 'user-1',
      state,
    }),
    pluginManager: new PluginManager([]),
    sessionService: new InMemorySessionService(),
  });
}

/** Builds a readonly context over a real, empty invocation. */
function readonlyContext(): ReadonlyContext {
  return new ReadonlyContext(invocationContext());
}

/** Looks a tool up by name, failing the test when the toolset omits it. */
function toolNamed(tools: BaseTool[], name: string): BaseTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(`the toolset does not expose ${name}`);
  }
  return tool;
}

describe('DataAgentToolset', () => {
  it('exposes the three data agent tools by default', async () => {
    const tools = await new DataAgentToolset().getTools();

    expect(namesOf(tools)).toEqual(ALL_TOOL_NAMES);
    expect(tools.every(isFunctionTool)).toBe(true);
  });

  it('keeps only the named tools', async () => {
    const toolset = new DataAgentToolset({
      toolFilter: ['list_accessible_data_agents', 'get_data_agent_info'],
    });

    expect(namesOf(await toolset.getTools())).toEqual([
      'list_accessible_data_agents',
      'get_data_agent_info',
    ]);
  });

  it('keeps a single named tool', async () => {
    const toolset = new DataAgentToolset({toolFilter: ['ask_data_agent']});

    expect(namesOf(await toolset.getTools())).toEqual(['ask_data_agent']);
  });

  it('keeps nothing when no filtered name matches', async () => {
    const toolset = new DataAgentToolset({toolFilter: ['unknown']});

    expect(await toolset.getTools()).toEqual([]);
  });

  it('ignores unknown names alongside a known one', async () => {
    const toolset = new DataAgentToolset({
      toolFilter: ['unknown', 'ask_data_agent'],
    });

    expect(namesOf(await toolset.getTools())).toEqual(['ask_data_agent']);
  });

  it('treats an empty filter array as no filter', async () => {
    // Deliberate divergence from adk-python, where `tool_filter=[]` selects
    // nothing: adk-js `BaseToolset` and `MCPToolset` both read `[]` as unset.
    const toolset = new DataAgentToolset({toolFilter: []});

    expect(namesOf(await toolset.getTools())).toEqual(ALL_TOOL_NAMES);
  });

  it('applies a predicate filter when a context is supplied', async () => {
    const predicate: ToolPredicate = (tool) => tool.name === 'ask_data_agent';
    const toolset = new DataAgentToolset({toolFilter: predicate});

    expect(namesOf(await toolset.getTools(readonlyContext()))).toEqual([
      'ask_data_agent',
    ]);
  });

  it('skips a predicate filter when no context is supplied', async () => {
    // A predicate needs a ReadonlyContext to evaluate, so without one the
    // toolset returns everything, as OpenAPIToolset does.
    const predicate: ToolPredicate = (tool) => tool.name === 'ask_data_agent';

    const tools = await new DataAgentToolset({
      toolFilter: predicate,
    }).getTools();

    expect(namesOf(tools)).toEqual(ALL_TOOL_NAMES);
  });

  it('declares only the model-facing snake_case parameters', async () => {
    const tools = await new DataAgentToolset().getTools();

    const declared = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        Object.keys(tool._getDeclaration()?.parameters?.properties ?? {}),
      ]),
    );
    expect(declared).toEqual({
      list_accessible_data_agents: ['project_id'],
      get_data_agent_info: ['data_agent_name'],
      ask_data_agent: ['data_agent_name', 'query'],
    });
  });

  it('closes without error', async () => {
    await expect(new DataAgentToolset().close()).resolves.toBeUndefined();
  });
});

describe('DataAgentToolset tool invocation', () => {
  const EU_ENDPOINT = 'https://geminidataanalytics.eu.rep.googleapis.com';
  const AGENT_NAME = 'projects/p/locations/eu/dataAgents/a';

  /** A toolset whose token comes from the session state and that pins `eu`. */
  function toolsetWithSettings(): DataAgentToolset {
    return new DataAgentToolset({
      credentialsConfig: new DataAgentCredentialsConfig({
        externalAccessTokenKey: 'gda_token',
      }),
      dataAgentToolConfig: {location: 'eu', maxQueryResultRows: 1},
    });
  }

  /** A tool context carrying the access token the toolset expects. */
  function toolContext(): Context {
    return new Context({
      invocationContext: invocationContext({gda_token: 'state-token'}),
    });
  }

  /** Stubs `fetch` with the given responses, in order, and records the calls. */
  function stubFetch(...responses: Response[]) {
    const fetchMock = vi.fn<typeof fetch>();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** Builds a JSON response. */
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: {'Content-Type': 'application/json'},
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs list_accessible_data_agents with the configured location', async () => {
    const fetchMock = stubFetch(jsonResponse({dataAgents: ['agent_eu']}));
    const tools = await toolsetWithSettings().getTools();

    const result = await toolNamed(
      tools,
      'list_accessible_data_agents',
    ).runAsync({args: {project_id: 'my-project'}, toolContext: toolContext()});

    expect(result).toEqual({status: 'SUCCESS', response: ['agent_eu']});
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `${EU_ENDPOINT}/v1/projects/my-project/locations/eu/dataAgents:listAccessible`,
    );
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer state-token',
    );
  });

  it('runs get_data_agent_info with the resource name argument', async () => {
    const fetchMock = stubFetch(jsonResponse({name: AGENT_NAME}));
    const tools = await toolsetWithSettings().getTools();

    const result = await toolNamed(tools, 'get_data_agent_info').runAsync({
      args: {data_agent_name: AGENT_NAME},
      toolContext: toolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', response: {name: AGENT_NAME}});
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${EU_ENDPOINT}/v1/${AGENT_NAME}`,
    );
  });

  it('runs ask_data_agent and truncates to the configured row budget', async () => {
    const chatBody = [
      '[{',
      '"systemMessage": {"data": {"result": {"data": [{"a":1},{"a":2}], "schema": {"fields":[{"name":"a"}]}}}}',
      '}]',
    ].join('\n');
    const fetchMock = stubFetch(
      jsonResponse({name: AGENT_NAME}),
      new Response(chatBody),
    );
    const tools = await toolsetWithSettings().getTools();

    const result = await toolNamed(tools, 'ask_data_agent').runAsync({
      args: {data_agent_name: AGENT_NAME, query: 'how many?'},
      toolContext: toolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      response: [
        {
          'Data Retrieved': {
            headers: ['a'],
            rows: [[1]],
            summary: 'Showing the first 1 of 2 total rows.',
          },
        },
      ],
    });
    const [chatUrl, chatInit] = fetchMock.mock.calls[1];
    expect(String(chatUrl)).toBe(
      `${EU_ENDPOINT}/v1/projects/p/locations/eu:chat`,
    );
    expect(JSON.parse(String(chatInit?.body))).toEqual({
      messages: [{userMessage: {text: 'how many?'}}],
      dataAgentContext: {dataAgent: AGENT_NAME},
      clientIdEnum: 'GOOGLE_ADK',
    });
  });

  it('rejects an argument that does not match the declared schema', async () => {
    const tools = await toolsetWithSettings().getTools();

    await expect(
      toolNamed(tools, 'ask_data_agent').runAsync({
        args: {data_agent_name: AGENT_NAME},
        toolContext: toolContext(),
      }),
    ).rejects.toThrow(/ask_data_agent/);
  });
});
