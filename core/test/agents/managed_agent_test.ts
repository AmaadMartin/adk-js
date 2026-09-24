/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/agents/test_managed_agent.py` from
 * google/adk-python, read at commit a3bd1115 of `main`. Every `it()` keeps the
 * Python test's name, so a reader can find the original by grepping for it.
 *
 * Nothing in the genai SDK is stubbed. The tests answer its HTTP calls with
 * canned bytes instead, so request serialization and server-sent-event parsing
 * both run for real and every assertion is about the actual wire request.
 */

import {
  BuiltInTool,
  createEvent,
  createSession,
  Event,
  FunctionTool,
  GOOGLE_SEARCH,
  InvocationContext,
  isRemoteMcpServer,
  ManagedAgent,
  ManagedAgentConfig,
  PluginManager,
  ReadonlyContext,
  RemoteMcpServer,
  RunConfig,
  Session,
  StreamingMode,
  ToolProcessLlmRequest,
} from '@google/adk';
import {GoogleGenAI, Interactions} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {toUserContent} from '../../src/utils/content_utils.js';
import {
  getTrackingHeaders,
  getTrackingHttpOptions,
} from '../../src/utils/tracking_headers_utils.js';
import {driveNode} from '../workflow/test_helpers.js';

const {constructedOptions} = vi.hoisted(() => ({
  constructedOptions: [] as Array<Record<string, unknown>>,
}));

// A real subclass, so every client behaves exactly as genai's does. It only
// records the options it was built with, which is the one thing genai keeps
// private and the lazy-client tests have to assert.
vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class RecordingGoogleGenAI extends actual.GoogleGenAI {
    constructor(options: ConstructorParameters<typeof actual.GoogleGenAI>[0]) {
      super(options);
      constructedOptions.push({...options});
    }
  }
  return {...actual, GoogleGenAI: RecordingGoogleGenAI};
});

/** The parameters the agent puts on the wire. */
type CreateParams = Interactions.CreateAgentInteractionParamsStreaming;

/**
 * A lifecycle event carrying the environment id. `@google/genai` 2.9.0 omits
 * that field from its streaming interaction payload; the API sends it.
 */
interface LifecycleEvent {
  event_type: 'interaction.created';
  interaction: {id: string; status: 'in_progress'; environment_id?: string};
}

/** One canned server-sent event. */
type SseEvent = Interactions.InteractionSSEEvent | LifecycleEvent;

function textDelta(text: string): SseEvent {
  return {event_type: 'step.delta', index: 0, delta: {type: 'text', text}};
}

/**
 * The lifecycle event that opens a stream. The converter yields nothing for
 * it, so it is how a test supplies the interaction and environment ids.
 */
function created(id: string, environmentId?: string): SseEvent {
  return {
    event_type: 'interaction.created',
    interaction: {id, status: 'in_progress', environment_id: environmentId},
  };
}

function errorEvent(code: string, message: string): SseEvent {
  return {event_type: 'error', error: {code, message}};
}

/** Every interactions request the agent sent, in order. */
interface FakeBackend {
  readonly requests: Request[];
}

/** Answers every genai HTTP call with `respond()`, and records the request. */
function fakeBackend(respond: () => Response): FakeBackend {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    requests.push(new Request(...args));
    return respond();
  });
  return {requests};
}

/** A backend that streams `events` back as server-sent events. */
function streamingBackend(events: SseEvent[] = []): FakeBackend {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return fakeBackend(
    () =>
      new Response(body, {
        status: 200,
        headers: {'content-type': 'text/event-stream'},
      }),
  );
}

/** A backend that answers with an HTTP error, as a rate-limited one does. */
function failingBackend(status: number, message: string): FakeBackend {
  return fakeBackend(
    () =>
      new Response(JSON.stringify({error: {code: status, message}}), {
        status,
        headers: {'content-type': 'application/json'},
      }),
  );
}

/** A backend whose transport fails outright, carrying no HTTP status. */
function unreachableBackend(message: string): void {
  vi.stubGlobal('fetch', async () => {
    throw new Error(message);
  });
}

/** Narrows a decoded request body to the agent-interaction parameters. */
function isAgentParams(body: unknown): body is CreateParams {
  return typeof body === 'object' && body !== null && 'agent' in body;
}

/** Decodes the interactions request the agent sent. */
async function requestBody(request: Request): Promise<CreateParams> {
  const body: unknown = await request.json();
  if (!isAgentParams(body)) {
    expect.fail(`expected an agent interaction request, got ${String(body)}`);
  }
  return body;
}

/** A Developer-API client: genai resolves no location for one. */
function devApiClient(): GoogleGenAI {
  return new GoogleGenAI({apiKey: 'test-api-key'});
}

/** A server-side tool that records the request the agent hands it. */
class RecordingBuiltInTool extends BuiltInTool {
  constructor(
    private readonly seen: Array<{isManagedAgent?: boolean; model?: string}>,
  ) {
    super({name: 'rec', description: 'rec'});
  }

  protected override async applyBuiltInConfig({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    this.seen.push({
      isManagedAgent: llmRequest.isManagedAgent,
      model: llmRequest.model,
    });
  }
}

function userCtx(
  text: string,
  options: {
    sessionEvents?: Event[];
    invocationId?: string;
    branch?: string;
    runConfig?: RunConfig;
    state?: Record<string, unknown>;
  } = {},
): InvocationContext {
  const session: Session = createSession({
    id: 's1',
    appName: 'test',
    userId: 'user',
    state: options.state ?? {},
    events: options.sessionEvents ?? [],
  });
  return new InvocationContext({
    invocationId: options.invocationId ?? 'inv1',
    branch: options.branch,
    session,
    userContent: {role: 'user', parts: [{text}]},
    runConfig: options.runConfig,
    pluginManager: new PluginManager(),
  });
}

async function collect(
  agent: ManagedAgent,
  ctx: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(ctx)) {
    events.push(event);
  }
  return events;
}

/** The mcp_server entries of a resolved tool list. */
function mcpParams(
  tools: Interactions.Tool[] | undefined,
): Interactions.Tool[] {
  return (tools ?? []).filter((tool) => tool.type === 'mcp_server');
}

/** Runs one turn against a canned backend and returns the create params. */
async function createParamsOf(
  config: Omit<ManagedAgentConfig, 'apiClient'>,
  ctx: InvocationContext = userCtx('hi'),
): Promise<CreateParams> {
  const backend = streamingBackend();
  const agent = new ManagedAgent({...config, apiClient: devApiClient()});
  await collect(agent, ctx);
  expect(backend.requests).toHaveLength(1);
  return requestBody(backend.requests[0]);
}

beforeEach(() => {
  constructedOptions.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ManagedAgent construction and client', () => {
  it('test_construction_sets_fields_and_injectable_client', () => {
    const client = devApiClient();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'antigravity-preview-05-2026',
      environment: {type: 'remote'},
      apiClient: client,
    });

    expect(agent.name).toBe('mgr');
    expect(agent.agentId).toBe('antigravity-preview-05-2026');
    expect(agent.environment).toEqual({type: 'remote'});
    expect(agent.tools).toEqual([]);
    expect(agent.apiClient).toBe(client);
  });

  it('test_injected_client_is_not_tagged', () => {
    const client = devApiClient();
    const before = constructedOptions.length;
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: client,
    });

    expect(agent.apiClient).toBe(client);
    // The injected client is used as-is; the agent builds no second one. Its
    // tracking headers ride on each request instead, which the
    // `ManagedAgent tracking headers` suite pins.
    expect(constructedOptions).toHaveLength(before);
  });

  it('test_lazy_client_enterprise_uses_global_location', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', '1');
    // genai rejects an enterprise client that resolves no project, so the
    // test supplies one rather than depending on the machine's credentials.
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    const agent = new ManagedAgent({name: 'mgr', agentId: 'agents/a'});

    expect(agent.apiClient.vertexai).toBe(true);
    expect(constructedOptions).toHaveLength(1);
    expect(constructedOptions[0]['enterprise']).toBe(true);
    expect(constructedOptions[0]['location']).toBe('global');
    expect(constructedOptions[0]['httpOptions']).toEqual(
      getTrackingHttpOptions(),
    );
  });

  it('test_lazy_client_dev_api_omits_location', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', '0');
    vi.stubEnv('GOOGLE_API_KEY', 'test-api-key');
    const agent = new ManagedAgent({name: 'mgr', agentId: 'agents/a'});

    expect(agent.apiClient.vertexai).toBe(false);
    expect(constructedOptions).toHaveLength(1);
    expect(constructedOptions[0]['enterprise']).toBe(false);
    expect('location' in constructedOptions[0]).toBe(false);
    expect(constructedOptions[0]['httpOptions']).toEqual(
      getTrackingHttpOptions(),
    );
  });

  it('test_lazy_client_is_built_once', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', '1');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    const agent = new ManagedAgent({name: 'mgr', agentId: 'agents/a'});

    expect(agent.apiClient).toBe(agent.apiClient);
    expect(constructedOptions).toHaveLength(1);
  });

  it('test_injected_non_global_enterprise_client_raises', () => {
    const client = new GoogleGenAI({
      vertexai: true,
      project: 'test-project',
      location: 'us-central1',
    });

    expect(
      () =>
        new ManagedAgent({name: 'mgr', agentId: 'agents/a', apiClient: client}),
    ).toThrow(/global/);
  });

  it('test_injected_global_enterprise_client_is_accepted', () => {
    const client = new GoogleGenAI({
      vertexai: true,
      project: 'test-project',
      location: 'global',
    });

    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: client,
    });

    expect(agent.apiClient).toBe(client);
  });

  it('test_injected_regional_dev_api_client_is_accepted', () => {
    // A Developer-API client has no meaningful location, yet genai still
    // stamps GOOGLE_CLOUD_LOCATION onto it, so a regional value must be kept.
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    const client = devApiClient();
    expect(client.vertexai).toBe(false);

    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: client,
    });

    expect(agent.apiClient).toBe(client);
  });

  it('test_injected_client_without_location_is_accepted', () => {
    const client = devApiClient();

    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: client,
    });

    expect(agent.apiClient).toBe(client);
  });

  it('test_validate_uses_public_vertexai_property', () => {
    // The enterprise decision comes from the public `vertexai` property, which
    // genai derives from `enterprise`. A client built the `enterprise` way and
    // pointed at a region must therefore be rejected too.
    const client = new GoogleGenAI({
      enterprise: true,
      project: 'test-project',
      location: 'us-central1',
    });
    expect(client.vertexai).toBe(true);

    expect(
      () =>
        new ManagedAgent({name: 'mgr', agentId: 'agents/a', apiClient: client}),
    ).toThrow(/global/);
  });

  it('test_agent_id_is_required', () => {
    expect(() => new ManagedAgent({name: 'm', agentId: ''})).toThrow(
      /non-empty agentId/,
    );
  });

  it('test_mode_defaults_to_none', () => {
    const agent = new ManagedAgent({name: 'm', agentId: 'a'});
    expect(agent.mode).toBeUndefined();
  });

  it('test_mode_single_turn_is_accepted', () => {
    const agent = new ManagedAgent({
      name: 'm',
      agentId: 'a',
      mode: 'single_turn',
    });
    expect(agent.mode).toBe('single_turn');
  });

  it('test_mode_chat_is_rejected', () => {
    // adk-python asserts a pydantic ValidationError. adk-js has no runtime
    // schema, so the constructor throws instead. The guard is for a JavaScript
    // caller: TypeScript already rejects the value.
    const config: ManagedAgentConfig = {name: 'm', agentId: 'a'};
    Object.assign(config, {mode: 'chat'});

    expect(() => new ManagedAgent(config)).toThrow(/single_turn/);
  });
});

describe('ManagedAgent tool resolution', () => {
  it('test_resolve_builtin_google_search', async () => {
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [GOOGLE_SEARCH],
    });

    expect(params.tools).toContainEqual({type: 'google_search'});
  });

  it('test_resolve_raw_tool_passthrough', async () => {
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [{urlContext: {}}],
    });

    expect(params.tools).toContainEqual({type: 'url_context'});
  });

  it('test_resolve_rejects_raw_mcp_server', async () => {
    streamingBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [
        {
          mcpServers: [
            {name: 'db', streamableHttpTransport: {url: 'https://x'}},
          ],
        },
      ],
      apiClient: devApiClient(),
    });

    await expect(collect(agent, userCtx('hi'))).rejects.toThrow(/mcp/);
  });

  it('test_resolve_rejects_function_tool', async () => {
    streamingBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [
        new FunctionTool({
          name: 'my_fn',
          description: 'd',
          execute: async () => 'x',
        }),
      ],
      apiClient: devApiClient(),
    });

    await expect(collect(agent, userCtx('hi'))).rejects.toThrow(
      /client-executed/,
    );
  });

  it('test_resolve_rejects_plain_callable', async () => {
    streamingBackend();
    const config: ManagedAgentConfig = {
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    };
    // A JavaScript caller can pass a bare function; TypeScript cannot.
    Object.assign(config, {tools: [() => 'x']});

    await expect(
      collect(new ManagedAgent(config), userCtx('hi')),
    ).rejects.toThrow(/client-executed/);
  });

  it('test_resolve_rejects_raw_tool_with_function_declarations', async () => {
    streamingBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [{functionDeclarations: [{name: 'my_fn', description: 'd'}]}],
      apiClient: devApiClient(),
    });

    await expect(collect(agent, userCtx('hi'))).rejects.toThrow(
      /client-executed/,
    );
  });

  it('test_resolve_rejects_unsupported_raw_tool', async () => {
    streamingBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [{googleSearchRetrieval: {}}],
      apiClient: devApiClient(),
    });

    await expect(collect(agent, userCtx('hi'))).rejects.toThrow(
      /Unsupported raw Tool/,
    );
  });

  it('test_resolve_combines_multiple_tools', async () => {
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [GOOGLE_SEARCH, {urlContext: {}}],
    });

    expect(params.tools).toContainEqual({type: 'google_search'});
    expect(params.tools).toContainEqual({type: 'url_context'});
  });

  it('test_resolve_empty_tools_returns_empty', async () => {
    const params = await createParamsOf({name: 'mgr', agentId: 'agents/a'});

    expect('tools' in params).toBe(false);
  });

  it('test_resolve_passes_managed_agent_flag_and_no_model', async () => {
    const seen: Array<{isManagedAgent?: boolean; model?: string}> = [];
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [new RecordingBuiltInTool(seen)],
    });

    expect(seen).toEqual([{isManagedAgent: true, model: undefined}]);
    expect('tools' in params).toBe(false);
  });
});

describe('ManagedAgent remote MCP', () => {
  it('test_remote_mcp_server_constructs_and_is_exported', () => {
    const server = new RemoteMcpServer({
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      headers: {'X-Static': 'v'},
      allowedTools: ['a', 'b'],
      headerProvider: () => ({Authorization: 'Bearer t'}),
    });

    expect(server.url).toBe('https://mcp.example.com/mcp');
    expect(server.name).toBe('example');
    expect(server.headers).toEqual({'X-Static': 'v'});
    expect(server.allowedTools).toEqual(['a', 'b']);
    expect(server.headerProvider).toBeDefined();
    expect(isRemoteMcpServer(server)).toBe(true);
  });

  it('test_remote_mcp_server_defaults', () => {
    const server = new RemoteMcpServer({url: 'https://x/mcp'});

    expect(server.name).toBeUndefined();
    expect(server.headers).toBeUndefined();
    expect(server.allowedTools).toBeUndefined();
    expect(server.headerProvider).toBeUndefined();
  });

  it('test_remote_mcp_server_requires_a_url', () => {
    expect(() => new RemoteMcpServer({url: ''})).toThrow(/non-empty url/);
  });

  it('test_resolve_mcp_basic_mapping', async () => {
    const server = new RemoteMcpServer({
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      allowedTools: ['a'],
    });
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [server],
    });

    expect(params.tools).toContainEqual({
      type: 'mcp_server',
      url: 'https://mcp.example.com/mcp',
      name: 'example',
      allowed_tools: [{tools: ['a']}],
    });
  });

  it('test_resolve_mcp_sync_header_provider', async () => {
    let called = false;
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: () => {
        called = true;
        return {Authorization: 'Bearer tok'};
      },
    });
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [server],
    });

    expect(called).toBe(true);
    expect(mcpParams(params.tools)[0]).toMatchObject({
      headers: {Authorization: 'Bearer tok'},
    });
  });

  it('test_resolve_mcp_async_header_provider', async () => {
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: async () => ({Authorization: 'Bearer async'}),
    });
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [server],
    });

    expect(mcpParams(params.tools)[0]).toMatchObject({
      headers: {Authorization: 'Bearer async'},
    });
  });

  it('test_resolve_mcp_header_provider_receives_a_readonly_context', async () => {
    const seen: ReadonlyContext[] = [];
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: (context) => {
        seen.push(context);
        return {};
      },
    });
    await createParamsOf({name: 'mgr', agentId: 'agents/a', tools: [server]});

    expect(seen).toHaveLength(1);
    expect(seen[0].invocationId).toBe('inv1');
  });

  it('test_resolve_mcp_merges_static_and_dynamic_dynamic_wins', async () => {
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      headers: {'X-Static': 's', Shared: 'static'},
      headerProvider: () => ({Shared: 'dynamic', 'X-Dyn': 'd'}),
    });
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [server],
    });

    expect(mcpParams(params.tools)[0]).toMatchObject({
      headers: {'X-Static': 's', Shared: 'dynamic', 'X-Dyn': 'd'},
    });
  });

  it('test_resolve_mcp_no_header_provider_static_only', async () => {
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      headers: {'X-Static': 's'},
    });
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [server],
    });

    expect(mcpParams(params.tools)[0]).toMatchObject({
      headers: {'X-Static': 's'},
    });
  });

  it('test_resolve_mcp_header_provider_error_propagates', async () => {
    streamingBackend();
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: () => {
        throw new Error('token mint failed');
      },
    });
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [server],
      apiClient: devApiClient(),
    });

    await expect(collect(agent, userCtx('hi'))).rejects.toThrow(
      /token mint failed/,
    );
  });

  it('test_resolve_mcp_mixed_with_builtin', async () => {
    const server = new RemoteMcpServer({url: 'https://x/mcp'});
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [GOOGLE_SEARCH, server],
    });

    expect(params.tools).toContainEqual({type: 'google_search'});
    expect(mcpParams(params.tools)).toHaveLength(1);
  });

  it('test_resolve_mcp_empty_header_provider_omits_headers', async () => {
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      headerProvider: () => ({}),
    });
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [server],
    });

    expect('headers' in mcpParams(params.tools)[0]).toBe(false);
  });

  it('test_resolve_mcp_does_not_mutate_spec_headers', async () => {
    const originalHeaders = {'X-Static': 's'};
    const server = new RemoteMcpServer({
      url: 'https://x/mcp',
      headers: originalHeaders,
      headerProvider: () => ({Authorization: 'Bearer tok'}),
    });
    await createParamsOf({name: 'mgr', agentId: 'agents/a', tools: [server]});

    expect(server.headers).toEqual({'X-Static': 's'});
    expect(originalHeaders).toEqual({'X-Static': 's'});
  });

  it('test_run_async_forwards_mcp_server_param', async () => {
    const server = new RemoteMcpServer({
      url: 'https://mcp.example.com/mcp',
      headerProvider: () => ({'X-Goog-Api-Key': 'k'}),
    });
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [server],
    });

    expect(mcpParams(params.tools)[0]).toMatchObject({
      url: 'https://mcp.example.com/mcp',
      headers: {'X-Goog-Api-Key': 'k'},
    });
  });
});

describe('ManagedAgent run loop', () => {
  it('test_run_async_yields_events_with_ids', async () => {
    streamingBackend([created('int_1', 'env_1'), textDelta('Hello!')]);
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    const events = await collect(agent, userCtx('hi'));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('mgr');
    expect(events[0].content?.parts?.[0].text).toBe('Hello!');
    expect(events[0].interactionId).toBe('int_1');
    expect(events[0].environmentId).toBe('env_1');
  });

  it('test_run_async_recovers_previous_state', async () => {
    const prior = createEvent({
      author: 'mgr',
      interactionId: 'int_prev',
      environmentId: 'env_prev',
    });
    const params = await createParamsOf(
      {name: 'mgr', agentId: 'agents/a'},
      userCtx('again', {sessionEvents: [prior]}),
    );

    expect(params.previous_interaction_id).toBe('int_prev');
    expect(params.environment).toBe('env_prev');
    expect(params.agent).toBe('agents/a');
    expect(params.stream).toBe(true);
    expect(params.background).toBe(true);
  });

  it('test_run_async_forwards_tools_and_agent_config', async () => {
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      tools: [GOOGLE_SEARCH],
      agentConfig: {type: 'dynamic'},
    });

    expect(params.tools).toContainEqual({type: 'google_search'});
    expect(params.agent_config).toEqual({type: 'dynamic'});
  });

  it('test_run_async_sets_background_true', async () => {
    const params = await createParamsOf({name: 'mgr', agentId: 'agents/a'});

    expect(params.background).toBe(true);
  });

  it('test_run_async_sends_the_user_content_as_input', async () => {
    const params = await createParamsOf({name: 'mgr', agentId: 'agents/a'});

    expect(params.input).toEqual([
      {type: 'user_input', content: [{type: 'text', text: 'hi'}]},
    ]);
  });

  it('test_run_async_yields_multiple_events_in_order', async () => {
    streamingBackend([textDelta('one'), textDelta('two')]);
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    // SSE mode, so both partials reach the caller in the order they arrived.
    const events = await collect(
      agent,
      userCtx('hi', {runConfig: {streamingMode: StreamingMode.SSE}}),
    );

    expect(events.slice(0, 2).map((e) => e.content?.parts?.[0].text)).toEqual([
      'one',
      'two',
    ]);
    // The shared transport closes a stream with the aggregated response.
    expect(events[2].partial).toBe(false);
    expect(events[2].content?.parts?.map((part) => part.text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('test_run_async_error_yields_error_event', async () => {
    unreachableBackend('api exploded');
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    const events = await collect(agent, userCtx('hi'));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('mgr');
    expect(events[0].errorMessage).toContain('api exploded');
    expect(events[0].errorCode).toBe('UNKNOWN_ERROR');
    expect(events[0].turnComplete).toBe(true);
  });

  it('test_run_async_api_error_surfaces_backend_status_and_message', async () => {
    // adk-python reads the canonical status string (RESOURCE_EXHAUSTED); the
    // `@google/genai` error carries the numeric HTTP status instead. The
    // status is 400 rather than 429, because the SDK retries a 429 itself.
    failingBackend(400, 'Quota exceeded.');
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    const events = await collect(agent, userCtx('hi'));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('mgr');
    expect(events[0].errorCode).toBe('400');
    expect(events[0].errorMessage).toContain('Quota exceeded.');
    expect(events[0].turnComplete).toBe(true);
  });

  it('test_run_async_uses_self_environment_when_no_prior', async () => {
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      environment: {type: 'remote'},
    });

    expect(params.environment).toEqual({type: 'remote'});
    expect('previous_interaction_id' in params).toBe(false);
  });

  it('test_run_async_raises_on_unsupported_tool', async () => {
    streamingBackend();
    const config: ManagedAgentConfig = {
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    };
    Object.assign(config, {tools: [() => 'x']});

    await expect(
      collect(new ManagedAgent(config), userCtx('hi')),
    ).rejects.toThrow(/client-executed/);
  });

  it('test_run_async_non_streaming_suppresses_partials', async () => {
    streamingBackend([textDelta('thinking'), textDelta('searching')]);
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    const events = await collect(
      agent,
      userCtx('hi', {runConfig: {streamingMode: StreamingMode.NONE}}),
    );

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.map((part) => part.text)).toEqual([
      'thinking',
      'searching',
    ]);
    expect(events[0].partial).toBe(false);
  });

  it('test_run_async_sse_yields_all_partials', async () => {
    streamingBackend([textDelta('thinking'), textDelta('searching')]);
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    const events = await collect(
      agent,
      userCtx('hi', {runConfig: {streamingMode: StreamingMode.SSE}}),
    );

    expect(events).toHaveLength(3);
    expect(events[0].partial).toBe(true);
    expect(events[1].partial).toBe(true);
    expect(events[2].partial).toBe(false);
  });

  it('test_run_async_non_streaming_surfaces_error_event', async () => {
    streamingBackend([
      textDelta('thinking'),
      errorEvent('UNKNOWN_ERROR', 'boom'),
    ]);
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    const events = await collect(
      agent,
      userCtx('hi', {runConfig: {streamingMode: StreamingMode.NONE}}),
    );

    expect(events[0].errorCode).toBe('UNKNOWN_ERROR');
    expect(events[0].errorMessage).toBe('boom');
    // The shared transport still closes the stream with the aggregated
    // response, so the suppressed partial arrives as a second, final event.
    expect(events).toHaveLength(2);
    expect(events[1].partial).toBe(false);
  });

  it('test_run_async_default_run_config_suppresses_partials', async () => {
    streamingBackend([textDelta('thinking')]);
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    // No run config at all: the default is not SSE, so partials stay hidden.
    const events = await collect(agent, userCtx('hi'));

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].text).toBe('thinking');
  });
});

describe('ManagedAgent tracking headers', () => {
  /**
   * Runs one turn against a canned backend and returns the headers the agent
   * actually put on the wire. The client is injected and carries no tracking
   * options of its own, so every tracking header here came from the request.
   */
  async function requestHeadersOf(runConfig?: RunConfig): Promise<Headers> {
    const backend = streamingBackend();
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      apiClient: devApiClient(),
    });

    await collect(agent, userCtx('hi', {runConfig}));

    expect(backend.requests).toHaveLength(1);
    return backend.requests[0].headers;
  }

  it('test_run_async_merges_run_config_headers_into_extra_headers', async () => {
    const headers = await requestHeadersOf({
      httpOptions: {headers: {'x-custom': 'v'}},
    });

    expect(headers.get('x-custom')).toBe('v');
    expect(headers.get('x-goog-api-client')).toContain('+managed_agent');
  });

  it('test_run_async_sends_tracking_headers_without_run_config_headers', async () => {
    const headers = await requestHeadersOf();
    const expected = getTrackingHeaders('managed_agent');

    expect(headers.get('x-goog-api-client')).toBe(
      expected['x-goog-api-client'],
    );
  });

  it('test_run_async_sends_tracking_headers_when_http_options_has_no_headers', async () => {
    const headers = await requestHeadersOf({httpOptions: {}});
    const expected = getTrackingHeaders('managed_agent');

    expect(headers.get('x-goog-api-client')).toBe(
      expected['x-goog-api-client'],
    );
  });

  it('records that the genai SDK replaces the user-agent header', async () => {
    // `@google/genai` 2.9.0 overwrites `user-agent` with its own SDK string
    // after it merges the caller's headers, on every non-browser request. So
    // `x-goog-api-client` is the only tracking header that reaches the wire
    // from adk-js, and adk-python's `user-agent` assertion cannot hold here.
    // This test fails if a later SDK stops overwriting it.
    const headers = await requestHeadersOf();

    expect(headers.get('user-agent')).toContain('@google/genai');
    expect(headers.get('user-agent')).not.toContain('google-adk');
  });

  it('keeps a caller token the tracking value does not carry', async () => {
    const headers = await requestHeadersOf({
      httpOptions: {headers: {'x-goog-api-client': 'caller/1.0'}},
    });
    const tracking = getTrackingHeaders('managed_agent')['x-goog-api-client'];

    expect(headers.get('x-goog-api-client')).toBe(`${tracking} caller/1.0`);
  });
});

describe('ManagedAgent instruction', () => {
  it('test_canonical_instruction_str', async () => {
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      instruction: 'hello',
      apiClient: devApiClient(),
    });

    const resolved = await agent.canonicalInstruction(
      new ReadonlyContext(userCtx('hi')),
    );

    expect(resolved).toEqual({
      instruction: 'hello',
      requireStateInjection: true,
    });
  });

  it('test_canonical_instruction_sync_provider', async () => {
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      instruction: () => 'from provider',
      apiClient: devApiClient(),
    });

    const resolved = await agent.canonicalInstruction(
      new ReadonlyContext(userCtx('hi')),
    );

    expect(resolved).toEqual({
      instruction: 'from provider',
      requireStateInjection: false,
    });
  });

  it('test_canonical_instruction_async_provider', async () => {
    const agent = new ManagedAgent({
      name: 'mgr',
      agentId: 'agents/a',
      instruction: async () => 'async provider',
      apiClient: devApiClient(),
    });

    const resolved = await agent.canonicalInstruction(
      new ReadonlyContext(userCtx('hi')),
    );

    expect(resolved).toEqual({
      instruction: 'async provider',
      requireStateInjection: false,
    });
  });

  it('test_instruction_defaults_to_empty_and_is_omitted', async () => {
    const agent = new ManagedAgent({name: 'mgr', agentId: 'agents/a'});
    const params = await createParamsOf({name: 'mgr', agentId: 'agents/a'});

    expect(agent.instruction).toBe('');
    expect('system_instruction' in params).toBe(false);
  });

  it('test_string_instruction_forwarded_as_system_instruction', async () => {
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      instruction: 'You are a terse assistant.',
    });

    expect(params.system_instruction).toBe('You are a terse assistant.');
  });

  it('test_sync_instruction_provider_forwarded_and_bypasses_injection', async () => {
    // The '{name}' stays literal: a provider bypasses state injection.
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      instruction: () => 'Persona for {name}',
    });

    expect(params.system_instruction).toBe('Persona for {name}');
  });

  it('test_async_instruction_provider_forwarded', async () => {
    const params = await createParamsOf({
      name: 'mgr',
      agentId: 'agents/a',
      instruction: async () => 'Async persona.',
    });

    expect(params.system_instruction).toBe('Async persona.');
  });

  it('test_instruction_sent_on_chained_turn', async () => {
    const prior = createEvent({
      author: 'mgr',
      interactionId: 'int_prev',
      environmentId: 'env_prev',
    });
    const params = await createParamsOf(
      {name: 'mgr', agentId: 'agents/a', instruction: 'Stay in character.'},
      userCtx('again', {sessionEvents: [prior]}),
    );

    expect(params.previous_interaction_id).toBe('int_prev');
    expect(params.system_instruction).toBe('Stay in character.');
  });

  it('test_string_instruction_injects_session_state', async () => {
    const params = await createParamsOf(
      {name: 'mgr', agentId: 'agents/a', instruction: 'Discuss {topic}.'},
      userCtx('hi', {state: {topic: 'volcanoes'}}),
    );

    expect(params.system_instruction).toBe('Discuss volcanoes.');
  });
});

describe('ManagedAgent as a workflow node', () => {
  it('test_run_impl_bridges_node_input_to_user_content', async () => {
    const seen: Array<ReturnType<typeof toUserContent> | undefined> = [];
    class CapturingManagedAgent extends ManagedAgent {
      protected override async *runAsyncImpl(
        ctx: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        seen.push(ctx.userContent);
        yield* [];
      }
    }
    const agent = new CapturingManagedAgent({
      name: 'm',
      agentId: 'a',
      mode: 'single_turn',
      apiClient: devApiClient(),
    });

    const {events} = await driveNode(agent, 'compute primes');

    expect(events).toEqual([]);
    expect(seen).toEqual([toUserContent('compute primes')]);
  });
});

describe('ManagedAgent package surface', () => {
  it('test_managed_agent_exported_from_package', async () => {
    const adk = await import('@google/adk');

    expect(adk.ManagedAgent).toBe(ManagedAgent);
    expect(adk.RemoteMcpServer).toBe(RemoteMcpServer);
    expect(adk.isRemoteMcpServer).toBe(isRemoteMcpServer);
  });
});
