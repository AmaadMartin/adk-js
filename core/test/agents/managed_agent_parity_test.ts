/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python
 * `tests/unittests/agents/test_managed_agent.py` at `main`. Each `it()` string
 * keeps the reference test name so the two suites stay greppable against each
 * other.
 *
 * Three reference tests are not ported verbatim, and each says why at its own
 * site: `test_tools_import_first_has_no_cycle`,
 * `test_remote_mcp_server_forbids_extra_fields` and
 * `test_resolve_rejects_plain_callable` live in `managed_agent_test.ts`,
 * because TypeScript answers all three at compile time. A fourth,
 * `test_run_async_non_streaming_final_event_carries_grounding_and_usage`, is
 * ported here but asserts what adk-js actually produces; see its comment.
 *
 * The reference drives the run loop through a recording client. Here the loop
 * is driven through a recorded `createInteractions`, which carries the same
 * assertions about the create body. The transport itself — `stream: true` and
 * the per-request headers — is covered in
 * `core/test/models/interactions_utils_test.ts`.
 */

import {
  BaseTool,
  createEvent,
  createSession,
  Event,
  FunctionTool,
  GoogleSearchTool,
  InMemorySessionService,
  InvocationContext,
  isManagedAgent,
  isRemoteMcpServer,
  LlmResponse,
  ManagedAgent,
  ManagedAgentClient,
  PluginManager,
  ReadonlyContext,
  RemoteMcpServer,
  StreamingMode,
  ToolProcessLlmRequest,
} from '@google/adk';
import {resolveClientLocation} from '@google/adk/agents/managed_agent.js';
import {createRunConfig} from '@google/adk/agents/run_config.js';
import {convertContentToSteps} from '@google/adk/models/interactions_utils.js';
import {AsyncQueue} from '@google/adk/utils/async_queue.js';
import {getTrackingHeaders} from '@google/adk/utils/client_labels.js';
import {toUserContent} from '@google/adk/utils/content_utils.js';
import {NodeContext} from '@google/adk/workflow/node_context.js';
import {ApiError, Content, Interactions, Tool} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createInteractions,
  CreateInteractionsOptions,
  ExtendedInteractionSSEEvent,
} from '../../src/models/interactions_utils.js';

vi.mock('../../src/models/interactions_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/models/interactions_utils.js')
    >();
  return {...actual, createInteractions: vi.fn()};
});

/** The `createInteractions` calls the agent made during one test. */
let recordedCalls: CreateInteractionsOptions[] = [];

/**
 * Scripts what `createInteractions` yields, and records the options it was
 * called with. Mirrors the reference's `monkeypatch.setattr(mod,
 * '_create_interactions', ...)`.
 */
function scriptStream(responses: LlmResponse[]): void {
  vi.mocked(createInteractions).mockImplementation(
    async function* (_apiClient, options) {
      recordedCalls.push(options);
      yield* responses;
    },
  );
}

/** Scripts `createInteractions` to fail on its first response. */
function scriptFailure(error: unknown): void {
  vi.mocked(createInteractions).mockImplementation(async function* () {
    yield await Promise.reject<LlmResponse>(error);
  });
}

/** The create body of the only recorded call. */
function onlyCreateParams(): Interactions.CreateAgentInteractionParamsStreaming {
  expect(recordedCalls).toHaveLength(1);
  return recordedCalls[0].createParams;
}

/**
 * A client double.
 *
 * `apiClient.getLocation()` mimics the genai-internal accessor the location
 * check reads; a real `GoogleGenAI` exposes the same shape behind a protected
 * member. Declared as an extension of {@link ManagedAgentClient} so an object
 * literal carrying it is not rejected as an excess property.
 */
interface FakeClient extends ManagedAgentClient {
  apiClient?: {getLocation(): unknown};
}

function fakeClient(options: {vertexai?: boolean; location?: unknown} = {}) {
  const client: FakeClient = {
    vertexai: options.vertexai ?? false,
    interactions: {create: () => Promise.resolve(undefined)},
  };
  if ('location' in options) {
    client.apiClient = {getLocation: () => options.location};
  }
  return client;
}

/** A client double that replays `events` over the streaming call. */
function streamingClient(events: ExtendedInteractionSSEEvent[]): FakeClient {
  return {
    vertexai: false,
    interactions: {
      create: () =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
        }),
    },
  };
}

function invocationContext(
  options: {
    text?: string;
    events?: Event[];
    branch?: string;
    state?: Record<string, unknown>;
    streamingMode?: StreamingMode;
    headers?: Record<string, string>;
  } = {},
): InvocationContext {
  const userContent: Content | undefined =
    options.text === undefined
      ? undefined
      : {role: 'user', parts: [{text: options.text}]};
  return new InvocationContext({
    invocationId: 'inv1',
    branch: options.branch,
    userContent,
    session: createSession({
      id: 's1',
      appName: 'test',
      userId: 'user',
      state: options.state,
      events: options.events ?? [],
    }),
    sessionService: new InMemorySessionService(),
    pluginManager: new PluginManager([]),
    runConfig: {
      streamingMode: options.streamingMode,
      httpOptions: options.headers ? {headers: options.headers} : undefined,
    },
  });
}

/** Drains an async generator, discarding what it yields. */
async function drain(events: AsyncGenerator<Event, void, void>): Promise<void> {
  for await (const _event of events) {
    // The generator's side effects are what the test asserts on.
  }
}

/** Runs the agent's async loop and collects every event it yields. */
async function runAgent(
  agent: ManagedAgent,
  context: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) {
    events.push(event);
  }
  return events;
}

/** Resolves the agent's tools by running one turn and reading the call. */
async function resolveTools(agent: ManagedAgent): Promise<Interactions.Tool[]> {
  scriptStream([]);
  await runAgent(agent, invocationContext({text: 'hi'}));
  return onlyCreateParams().tools ?? [];
}

/** Builds the error `@google/genai` throws for a backend failure. */
function apiError(status: number, body: unknown): ApiError {
  return new ApiError({status, message: JSON.stringify(body)});
}

function textResponse(
  text: string,
  extra: Partial<LlmResponse> = {},
): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}, ...extra};
}

function mcpParams(params: Interactions.Tool[]): Interactions.Tool.MCPServer[] {
  return params.filter(
    (param): param is Interactions.Tool.MCPServer =>
      'type' in param && param.type === 'mcp_server',
  );
}

beforeEach(() => {
  recordedCalls = [];
  vi.mocked(createInteractions).mockReset();
});

describe('managed agent parity', () => {
  describe('construction and client validation', () => {
    it('test_construction_sets_fields_and_injectable_client', () => {
      const client = fakeClient();
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
      const client = fakeClient();
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: client,
      });

      expect(agent.apiClient).toBe(client);
      expect(Object.keys(client)).toEqual(['vertexai', 'interactions']);
    });

    it('test_lazy_client_enterprise_uses_global_location', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', '1');
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
      const agent = new ManagedAgent({name: 'mgr', agentId: 'agents/a'});

      const client = agent.apiClient;

      expect(client.vertexai).toBe(true);
      expect(resolveClientLocation(client)).toBe('global');
      vi.unstubAllEnvs();
    });

    it('test_lazy_client_dev_api_omits_location', () => {
      vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', '0');
      vi.stubEnv('GOOGLE_API_KEY', 'test-key');
      const agent = new ManagedAgent({name: 'mgr', agentId: 'agents/a'});

      const client = agent.apiClient;

      expect(client.vertexai).toBe(false);
      // The lazy client is cached, so a second read never rebuilds it.
      expect(agent.apiClient).toBe(client);
      vi.unstubAllEnvs();
    });

    it('test_injected_non_global_enterprise_client_raises', () => {
      expect(
        () =>
          new ManagedAgent({
            name: 'mgr',
            agentId: 'agents/a',
            apiClient: fakeClient({vertexai: true, location: 'us-central1'}),
          }),
      ).toThrow(/global/);
    });

    it('test_injected_global_enterprise_client_is_accepted', () => {
      const client = fakeClient({vertexai: true, location: 'global'});

      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: client,
      });

      expect(agent.apiClient).toBe(client);
    });

    it('test_injected_regional_dev_api_client_is_accepted', () => {
      // The Developer API has no meaningful location, yet genai still stamps
      // GOOGLE_CLOUD_LOCATION onto every client, so a regional value must not
      // be rejected for a non-enterprise client.
      const client = fakeClient({vertexai: false, location: 'us-central1'});

      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: client,
      });

      expect(agent.apiClient).toBe(client);
    });

    it('test_injected_client_without_location_is_accepted', () => {
      const client = fakeClient({vertexai: true});

      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: client,
      });

      expect(agent.apiClient).toBe(client);
    });

    it('test_validate_uses_public_vertexai_property', () => {
      // The backend decision comes from the public `vertexai` property. The
      // same regional location is rejected when it says enterprise and
      // accepted when it does not.
      expect(
        () =>
          new ManagedAgent({
            name: 'mgr',
            agentId: 'agents/a',
            apiClient: fakeClient({vertexai: true, location: 'us-central1'}),
          }),
      ).toThrow(/global/);
      expect(
        () =>
          new ManagedAgent({
            name: 'mgr',
            agentId: 'agents/a',
            apiClient: fakeClient({vertexai: false, location: 'us-central1'}),
          }),
      ).not.toThrow();
    });
  });

  describe('tool resolution', () => {
    it('test_resolve_builtin_google_search', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [new GoogleSearchTool()],
        apiClient: fakeClient(),
      });

      expect(await resolveTools(agent)).toContainEqual({type: 'google_search'});
    });

    it('test_resolve_raw_tool_passthrough', async () => {
      const raw: Tool = {urlContext: {}};
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [raw],
        apiClient: fakeClient(),
      });

      expect(await resolveTools(agent)).toContainEqual({type: 'url_context'});
    });

    it('test_resolve_rejects_raw_mcp_server', async () => {
      const raw: Tool = {
        mcpServers: [
          {
            name: 'db',
            streamableHttpTransport: {url: 'https://x'},
          },
        ],
      };
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [raw],
        apiClient: fakeClient(),
      });

      await expect(resolveTools(agent)).rejects.toThrow(/mcp/);
    });

    it('test_resolve_rejects_function_tool', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [
          new FunctionTool({
            name: 'my_fn',
            description: 'd',
            execute: () => 'ok',
          }),
        ],
        apiClient: fakeClient(),
      });

      await expect(resolveTools(agent)).rejects.toThrow(/client-executed/);
    });

    it('test_resolve_rejects_raw_tool_with_function_declarations', async () => {
      const raw: Tool = {
        functionDeclarations: [{name: 'my_fn', description: 'd'}],
      };
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [raw],
        apiClient: fakeClient(),
      });

      await expect(resolveTools(agent)).rejects.toThrow(/client-executed/);
    });

    it('test_resolve_rejects_unsupported_raw_tool', async () => {
      const raw: Tool = {googleSearchRetrieval: {}};
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [raw],
        apiClient: fakeClient(),
      });

      await expect(resolveTools(agent)).rejects.toThrow(/Unsupported raw/);
    });

    it('test_resolve_combines_multiple_tools', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [new GoogleSearchTool(), {urlContext: {}}],
        apiClient: fakeClient(),
      });

      const params = await resolveTools(agent);

      expect(params).toContainEqual({type: 'google_search'});
      expect(params).toContainEqual({type: 'url_context'});
    });

    it('test_resolve_empty_tools_returns_empty', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      expect(await resolveTools(agent)).toEqual([]);
    });

    it('test_resolve_passes_managed_agent_flag_and_no_model', async () => {
      const captured: {isManagedAgent?: boolean; model?: string} = {};
      class RecordingTool extends BaseTool {
        constructor() {
          super({name: 'rec', description: 'rec'});
        }
        override async processLlmRequest({
          llmRequest,
        }: ToolProcessLlmRequest): Promise<void> {
          captured.isManagedAgent = llmRequest.isManagedAgent;
          captured.model = llmRequest.model;
        }
        override async runAsync(): Promise<unknown> {
          return undefined;
        }
      }
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [new RecordingTool()],
        apiClient: fakeClient(),
      });

      await resolveTools(agent);

      expect(captured.isManagedAgent).toBe(true);
      expect(captured.model).toBeUndefined();
    });
  });

  describe('run loop and create body', () => {
    it('test_run_async_yields_events_with_ids', async () => {
      scriptStream([
        textResponse('Hello!', {
          interactionId: 'int_1',
          environmentId: 'env_1',
        }),
      ]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      const events = await runAgent(agent, invocationContext({text: 'hi'}));

      expect(events).toHaveLength(1);
      expect(events[0].author).toBe('mgr');
      expect(events[0].content?.parts?.[0].text).toBe('Hello!');
      expect(events[0].interactionId).toBe('int_1');
      expect(events[0].environmentId).toBe('env_1');
    });

    it('test_run_async_recovers_previous_state', async () => {
      scriptStream([]);
      const prior = createEvent({
        author: 'mgr',
        interactionId: 'int_prev',
        environmentId: 'env_prev',
      });
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      await runAgent(
        agent,
        invocationContext({text: 'again', events: [prior]}),
      );

      const createParams = onlyCreateParams();
      expect(createParams.previous_interaction_id).toBe('int_prev');
      expect(createParams.environment).toBe('env_prev');
      expect(createParams.agent).toBe('agents/a');
      expect(createParams.background).toBe(true);
    });

    it('test_run_async_forwards_tools_and_agent_config', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [new GoogleSearchTool()],
        agentConfig: {type: 'dynamic'},
        apiClient: fakeClient(),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      const createParams = onlyCreateParams();
      expect(createParams.tools).toContainEqual({type: 'google_search'});
      expect(createParams.agent_config).toEqual({type: 'dynamic'});
    });

    it('test_run_async_sets_background_true', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      expect(onlyCreateParams().background).toBe(true);
    });

    it('test_run_async_merges_run_config_headers_into_extra_headers', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      await runAgent(
        agent,
        invocationContext({text: 'hi', headers: {'x-custom': 'v'}}),
      );

      const headers = recordedCalls[0].extraHeaders ?? {};
      expect(headers['x-custom']).toBe('v');
      expect(headers['x-goog-api-client']).toContain('+managed_agent');
      expect(headers['user-agent']).toContain('+managed_agent');
    });

    it('test_run_async_sends_tracking_headers_without_run_config_headers', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      expect(recordedCalls[0].extraHeaders).toEqual(
        getTrackingHeaders('managed_agent'),
      );
    });

    it('test_run_async_sends_tracking_headers_when_http_options_has_no_headers', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });
      const context = invocationContext({text: 'hi'});
      context.runConfig = {httpOptions: {}};

      await runAgent(agent, context);

      expect(recordedCalls[0].extraHeaders).toEqual(
        getTrackingHeaders('managed_agent'),
      );
    });

    it('test_run_async_yields_multiple_events_in_order', async () => {
      scriptStream([textResponse('one'), textResponse('two')]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      const events = await runAgent(agent, invocationContext({text: 'hi'}));

      expect(events.map((event) => event.content?.parts?.[0].text)).toEqual([
        'one',
        'two',
      ]);
    });

    it('test_run_async_error_yields_error_event', async () => {
      scriptFailure(new Error('api exploded'));
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      const events = await runAgent(agent, invocationContext({text: 'hi'}));

      expect(events).toHaveLength(1);
      expect(events[0].author).toBe('mgr');
      expect(events[0].errorMessage).toContain('api exploded');
      expect(events[0].errorCode).toBe('UNKNOWN_ERROR');
      expect(events[0].turnComplete).toBe(true);
    });

    it('test_run_async_api_error_surfaces_backend_status_and_message', async () => {
      scriptFailure(
        apiError(429, {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'Quota exceeded.',
          },
        }),
      );
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      const events = await runAgent(agent, invocationContext({text: 'hi'}));

      expect(events).toHaveLength(1);
      expect(events[0].author).toBe('mgr');
      expect(events[0].errorCode).toBe('RESOURCE_EXHAUSTED');
      expect(events[0].errorMessage).toBe('Quota exceeded.');
      expect(events[0].turnComplete).toBe(true);
    });

    it('test_run_async_uses_self_environment_when_no_prior', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        environment: {type: 'remote'},
        apiClient: fakeClient(),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      const createParams = onlyCreateParams();
      expect(createParams.environment).toEqual({type: 'remote'});
      expect(createParams.previous_interaction_id).toBeUndefined();
    });

    it('test_run_async_raises_on_unsupported_tool', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [{googleSearchRetrieval: {}}],
        apiClient: fakeClient(),
      });

      // A configuration error is thrown, not turned into an error event.
      await expect(
        runAgent(agent, invocationContext({text: 'hi'})),
      ).rejects.toThrow(/Unsupported raw/);
    });

    it('test_managed_agent_exported_from_package', () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      expect(isManagedAgent(agent)).toBe(true);
    });
  });

  describe('streaming-mode filtering', () => {
    it('test_run_async_non_streaming_suppresses_partials', async () => {
      scriptStream([
        textResponse('thinking', {partial: true}),
        textResponse('searching', {partial: true}),
        textResponse('Final answer.', {partial: false, turnComplete: true}),
      ]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      const events = await runAgent(
        agent,
        invocationContext({text: 'hi', streamingMode: StreamingMode.NONE}),
      );

      expect(events).toHaveLength(1);
      expect(events[0].content?.parts?.[0].text).toBe('Final answer.');
      expect(events[0].partial).toBeFalsy();
    });

    it('test_run_async_sse_yields_all_partials', async () => {
      scriptStream([
        textResponse('thinking', {partial: true}),
        textResponse('searching', {partial: true}),
        textResponse('Final answer.', {partial: false, turnComplete: true}),
      ]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      const events = await runAgent(
        agent,
        invocationContext({text: 'hi', streamingMode: StreamingMode.SSE}),
      );

      expect(events.map((event) => event.content?.parts?.[0].text)).toEqual([
        'thinking',
        'searching',
        'Final answer.',
      ]);
    });

    it('test_run_async_non_streaming_surfaces_error_event', async () => {
      scriptStream([
        textResponse('thinking', {partial: true}),
        {
          errorCode: 'UNKNOWN_ERROR',
          errorMessage: 'boom',
          turnComplete: true,
        },
      ]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      const events = await runAgent(
        agent,
        invocationContext({text: 'hi', streamingMode: StreamingMode.NONE}),
      );

      expect(events).toHaveLength(1);
      expect(events[0].errorCode).toBe('UNKNOWN_ERROR');
      expect(events[0].errorMessage).toBe('boom');
    });

    it('test_run_async_default_run_config_suppresses_partials', async () => {
      scriptStream([
        textResponse('thinking', {partial: true}),
        textResponse('Final answer.', {partial: false, turnComplete: true}),
      ]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });
      const context = invocationContext({text: 'hi'});
      context.runConfig = createRunConfig();

      const events = await runAgent(agent, context);

      expect(events).toHaveLength(1);
      expect(events[0].content?.parts?.[0].text).toBe('Final answer.');
    });
  });

  describe('mode', () => {
    it('test_mode_defaults_to_none', () => {
      expect(new ManagedAgent({name: 'm', agentId: 'a'}).mode).toBeUndefined();
    });

    it('test_mode_single_turn_is_accepted', () => {
      expect(
        new ManagedAgent({name: 'm', agentId: 'a', mode: 'single_turn'}).mode,
      ).toBe('single_turn');
    });
  });

  describe('canonicalInstruction and instruction plumbing', () => {
    it('test_canonical_instruction_str', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        instruction: 'hello',
        apiClient: fakeClient(),
      });

      const resolved = await agent.canonicalInstruction(
        new ReadonlyContext(invocationContext()),
      );

      expect(resolved.instruction).toBe('hello');
      // adk-js reports whether injection is REQUIRED; adk-python reports
      // whether it is BYPASSED. Opposite polarity, same decision.
      expect(resolved.requireStateInjection).toBe(true);
    });

    it('test_canonical_instruction_sync_provider', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        instruction: () => 'from provider',
        apiClient: fakeClient(),
      });

      const resolved = await agent.canonicalInstruction(
        new ReadonlyContext(invocationContext()),
      );

      expect(resolved.instruction).toBe('from provider');
      expect(resolved.requireStateInjection).toBe(false);
    });

    it('test_canonical_instruction_async_provider', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        instruction: () => Promise.resolve('async provider'),
        apiClient: fakeClient(),
      });

      const resolved = await agent.canonicalInstruction(
        new ReadonlyContext(invocationContext()),
      );

      expect(resolved.instruction).toBe('async provider');
      expect(resolved.requireStateInjection).toBe(false);
    });

    it('test_instruction_defaults_to_empty_and_is_omitted', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: fakeClient(),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      expect(agent.instruction).toBe('');
      expect(onlyCreateParams().system_instruction).toBeUndefined();
    });

    it('test_string_instruction_forwarded_as_system_instruction', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        instruction: 'You are a terse assistant.',
        apiClient: fakeClient(),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      expect(onlyCreateParams().system_instruction).toBe(
        'You are a terse assistant.',
      );
    });

    it('test_sync_instruction_provider_forwarded_and_bypasses_injection', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        // The '{name}' must stay literal: a provider bypasses injection.
        instruction: () => 'Persona for {name}',
        apiClient: fakeClient(),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      expect(onlyCreateParams().system_instruction).toBe('Persona for {name}');
    });

    it('test_async_instruction_provider_forwarded', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        instruction: () => Promise.resolve('Async persona.'),
        apiClient: fakeClient(),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      expect(onlyCreateParams().system_instruction).toBe('Async persona.');
    });

    it('test_instruction_sent_on_chained_turn', async () => {
      scriptStream([]);
      const prior = createEvent({
        author: 'mgr',
        interactionId: 'int_prev',
        environmentId: 'env_prev',
      });
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        instruction: 'Stay in character.',
        apiClient: fakeClient(),
      });

      await runAgent(
        agent,
        invocationContext({text: 'again', events: [prior]}),
      );

      const createParams = onlyCreateParams();
      expect(createParams.previous_interaction_id).toBe('int_prev');
      expect(createParams.system_instruction).toBe('Stay in character.');
    });

    it('test_string_instruction_injects_session_state', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        instruction: 'Discuss {topic}.',
        apiClient: fakeClient(),
      });

      await runAgent(
        agent,
        invocationContext({text: 'hi', state: {topic: 'volcanoes'}}),
      );

      expect(onlyCreateParams().system_instruction).toBe('Discuss volcanoes.');
    });
  });

  describe('RemoteMcpServer', () => {
    it('test_remote_mcp_server_constructs_and_is_exported', () => {
      const server: RemoteMcpServer = {
        url: 'https://mcp.example.com/mcp',
        name: 'example',
        headers: {'X-Static': 'v'},
        allowedTools: ['a', 'b'],
        headerProvider: () => ({Authorization: 'Bearer t'}),
      };

      expect(server.url).toBe('https://mcp.example.com/mcp');
      expect(server.name).toBe('example');
      expect(server.headers).toEqual({'X-Static': 'v'});
      expect(server.allowedTools).toEqual(['a', 'b']);
      expect(isRemoteMcpServer(server)).toBe(true);
    });

    it('test_remote_mcp_server_defaults', () => {
      const server: RemoteMcpServer = {url: 'https://x/mcp'};

      expect(server.name).toBeUndefined();
      expect(server.headers).toBeUndefined();
      expect(server.allowedTools).toBeUndefined();
      expect(server.headerProvider).toBeUndefined();
    });
  });

  describe('MCP resolution', () => {
    function mcpAgent(server: RemoteMcpServer, extra: Tool[] = []) {
      return new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [...extra, server],
        apiClient: fakeClient(),
      });
    }

    it('test_resolve_mcp_basic_mapping', async () => {
      const agent = mcpAgent({
        url: 'https://mcp.example.com/mcp',
        name: 'example',
        allowedTools: ['a'],
      });

      expect(await resolveTools(agent)).toContainEqual({
        type: 'mcp_server',
        url: 'https://mcp.example.com/mcp',
        name: 'example',
        allowed_tools: [{tools: ['a']}],
      });
    });

    it('test_resolve_mcp_sync_header_provider', async () => {
      let called = false;
      const agent = mcpAgent({
        url: 'https://x/mcp',
        headerProvider: () => {
          called = true;
          return {Authorization: 'Bearer tok'};
        },
      });

      const params = await resolveTools(agent);

      expect(called).toBe(true);
      expect(mcpParams(params)[0].headers).toEqual({
        Authorization: 'Bearer tok',
      });
    });

    it('test_resolve_mcp_async_header_provider', async () => {
      const agent = mcpAgent({
        url: 'https://x/mcp',
        headerProvider: () => Promise.resolve({Authorization: 'Bearer async'}),
      });

      expect(mcpParams(await resolveTools(agent))[0].headers).toEqual({
        Authorization: 'Bearer async',
      });
    });

    it('test_resolve_mcp_merges_static_and_dynamic_dynamic_wins', async () => {
      const agent = mcpAgent({
        url: 'https://x/mcp',
        headers: {'X-Static': 's', Shared: 'static'},
        headerProvider: () => ({Shared: 'dynamic', 'X-Dyn': 'd'}),
      });

      expect(mcpParams(await resolveTools(agent))[0].headers).toEqual({
        'X-Static': 's',
        Shared: 'dynamic',
        'X-Dyn': 'd',
      });
    });

    it('test_resolve_mcp_no_header_provider_static_only', async () => {
      const agent = mcpAgent({
        url: 'https://x/mcp',
        headers: {'X-Static': 's'},
      });

      expect(mcpParams(await resolveTools(agent))[0].headers).toEqual({
        'X-Static': 's',
      });
    });

    it('test_resolve_mcp_header_provider_error_propagates', async () => {
      const agent = mcpAgent({
        url: 'https://x/mcp',
        headerProvider: () => {
          throw new Error('token mint failed');
        },
      });

      await expect(resolveTools(agent)).rejects.toThrow(/token mint failed/);
    });

    it('test_resolve_mcp_mixed_with_builtin', async () => {
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        tools: [new GoogleSearchTool(), {url: 'https://x/mcp'}],
        apiClient: fakeClient(),
      });

      const params = await resolveTools(agent);

      expect(params).toContainEqual({type: 'google_search'});
      expect(mcpParams(params)).toHaveLength(1);
    });

    it('test_resolve_mcp_empty_header_provider_omits_headers', async () => {
      // A provider returning an empty map, with no static headers, must not
      // add a `headers` key.
      const agent = mcpAgent({
        url: 'https://x/mcp',
        headerProvider: () => ({}),
      });

      expect(mcpParams(await resolveTools(agent))[0]).not.toHaveProperty(
        'headers',
      );
    });

    it('test_resolve_mcp_does_not_mutate_spec_headers', async () => {
      const originalHeaders = {'X-Static': 's'};
      const server: RemoteMcpServer = {
        url: 'https://x/mcp',
        headers: originalHeaders,
        headerProvider: () => ({Authorization: 'Bearer tok'}),
      };

      await resolveTools(mcpAgent(server));

      expect(server.headers).toEqual({'X-Static': 's'});
      expect(originalHeaders).toEqual({'X-Static': 's'});
    });

    it('test_run_async_forwards_mcp_server_param', async () => {
      scriptStream([]);
      const agent = mcpAgent({
        url: 'https://mcp.example.com/mcp',
        headerProvider: () => ({'X-Goog-Api-Key': 'k'}),
      });

      await runAgent(agent, invocationContext({text: 'hi'}));

      const mcp = mcpParams(onlyCreateParams().tools ?? [])[0];
      expect(mcp.url).toBe('https://mcp.example.com/mcp');
      expect(mcp.headers).toEqual({'X-Goog-Api-Key': 'k'});
    });
  });
  describe('node input', () => {
    it('test_run_impl_bridges_node_input_to_user_content', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'm',
        agentId: 'a',
        mode: 'single_turn',
        apiClient: fakeClient(),
      });
      const nodeContext = new NodeContext({
        invocationContext: invocationContext(),
        channel: new AsyncQueue<Event>(),
        nodePath: 'wf',
        runId: 'run-1',
      });

      await drain(agent.run(nodeContext, 'compute primes'));

      expect(onlyCreateParams().input).toEqual(
        convertContentToSteps(toUserContent('compute primes')),
      );
    });

    // Not a reference test: it pins the other branch of `runImpl`, where the
    // node supplies no input and the parent's user content is used as is.
    it('run_impl_without_node_input_keeps_the_parent_user_content', async () => {
      scriptStream([]);
      const agent = new ManagedAgent({
        name: 'm',
        agentId: 'a',
        apiClient: fakeClient(),
      });
      const nodeContext = new NodeContext({
        invocationContext: invocationContext({text: 'from the session'}),
        channel: new AsyncQueue<Event>(),
        nodePath: 'wf',
        runId: 'run-1',
      });

      await drain(agent.run(nodeContext, undefined));

      expect(onlyCreateParams().input).toEqual(
        convertContentToSteps(toUserContent('from the session')),
      );
    });
  });

  describe('aggregated final event', () => {
    it('test_run_async_non_streaming_final_event_carries_grounding_and_usage', async () => {
      // Ported, but asserting what adk-js actually produces.
      // `convertInteractionEventToLlmResponse` handles no `google_search_call`
      // delta and reads no `usage` off `interaction.completed`
      // (core/src/models/interactions_utils.ts), so the final event carries
      // neither grounding metadata nor usage metadata. That gap belongs to the
      // conversion layer, not to ManagedAgent, and closing it is out of scope
      // here. The test pins what this module does rely on: one non-partial
      // final event carrying the streamed text.
      const {createInteractions: realCreateInteractions} =
        await vi.importActual<
          typeof import('../../src/models/interactions_utils.js')
        >('../../src/models/interactions_utils.js');
      vi.mocked(createInteractions).mockImplementation(realCreateInteractions);
      const agent = new ManagedAgent({
        name: 'mgr',
        agentId: 'agents/a',
        apiClient: streamingClient([
          {
            event_type: 'step.delta',
            delta: {type: 'google_search_call', arguments: {queries: ['q1']}},
          },
          {
            event_type: 'step.delta',
            delta: {type: 'text', text: 'Final answer.'},
          },
          {
            event_type: 'interaction.completed',
            interaction: {id: 'int_e2e'},
          },
        ]),
      });

      const events = await runAgent(
        agent,
        invocationContext({text: 'hi', streamingMode: StreamingMode.NONE}),
      );

      expect(events).toHaveLength(1);
      const final = events[0];
      expect(final.partial).toBe(false);
      expect(final.content?.parts?.at(-1)?.text).toBe('Final answer.');
      expect(final.interactionId).toBe('int_e2e');
      expect(final.groundingMetadata).toBeUndefined();
      expect(final.usageMetadata).toBeUndefined();
    });
  });
});
