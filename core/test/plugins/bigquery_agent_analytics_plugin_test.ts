/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {TableField, TableMetadata} from '@google-cloud/bigquery';
import {
  AgentTool,
  AnalyticsEventType,
  BaseAgent,
  BigQueryAgentAnalyticsPlugin,
  BigQueryLoggerConfig,
  Context,
  createEvent,
  createEventActions,
  createNodeErrorEvent,
  createSession,
  Event,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Logger,
  PluginManager,
  RemoteA2AAgent,
  setLogger,
} from '@google/adk';
import {Content, FinishReason, Language, Outcome} from '@google/genai';
import {trace, TraceFlags} from '@opentelemetry/api';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {AnalyticsRow} from '../../src/plugins/bigquery_analytics_schema.js';
import {
  AnalyticsScopeKind,
  deriveScope,
  EVENTS_TABLE_SCHEMA,
  SCHEMA_VERSION,
} from '../../src/plugins/bigquery_analytics_schema.js';
import {ToolOrigin} from '../../src/plugins/bigquery_analytics_tools.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';

/** Table metadata the fake records when the plugin creates the table. */
interface CreatedTable {
  tableId: string;
  metadata: TableMetadata;
}

const {BigQueryMock, fake} = vi.hoisted(() => {
  interface FakeBigQuery {
    clientOptions: unknown[];
    inserted: AnalyticsRow[];
    insertIds: string[];
    insertCalls: number;
    created: CreatedTable[];
    datasetsCreated: Array<{id: string; options: {location?: string}}>;
    getCalls: number;
    metadataReads: number;
    metadataUpdates: TableMetadata[];
    liveSchema?: TableField[];
    liveLabels: Record<string, string>;
    metadataError?: Error;
    tableExists: boolean;
    datasetExists: boolean;
    clientError?: Error;
    createError?: Error;
    datasetCreateError?: Error;
    insertError?: unknown;
    insertGate?: Promise<void>;
  }

  const fake: FakeBigQuery = {
    clientOptions: [],
    inserted: [],
    insertIds: [],
    insertCalls: 0,
    created: [],
    datasetsCreated: [],
    getCalls: 0,
    metadataReads: 0,
    metadataUpdates: [],
    liveLabels: {adk_schema_version: '2'},
    tableExists: false,
    datasetExists: true,
  };

  class FakeTable {
    constructor(readonly id: string) {}

    async exists(): Promise<[boolean]> {
      return [fake.tableExists];
    }

    async get(): Promise<[FakeTable]> {
      fake.getCalls += 1;
      return [this];
    }

    async getMetadata(): Promise<[TableMetadata]> {
      fake.metadataReads += 1;
      return [
        {
          schema: {fields: fake.liveSchema ?? []},
          labels: fake.liveLabels,
        },
      ];
    }

    async setMetadata(metadata: TableMetadata): Promise<[TableMetadata]> {
      fake.metadataUpdates.push(metadata);
      if (fake.metadataError !== undefined) {
        throw fake.metadataError;
      }
      return [metadata];
    }

    async insert(
      rows: Array<{insertId: string; json: AnalyticsRow}>,
    ): Promise<void> {
      fake.insertCalls += 1;
      if (fake.insertGate !== undefined) {
        await fake.insertGate;
      }
      if (fake.insertError !== undefined) {
        throw fake.insertError;
      }
      for (const row of rows) {
        fake.insertIds.push(row.insertId);
        fake.inserted.push(row.json);
      }
    }
  }

  class FakeDataset {
    constructor(readonly id: string) {}

    table(id: string): FakeTable {
      return new FakeTable(id);
    }

    async exists(): Promise<[boolean]> {
      return [fake.datasetExists];
    }

    async create(options: {location?: string}): Promise<void> {
      fake.datasetsCreated.push({id: this.id, options});
      if (fake.datasetCreateError !== undefined) {
        throw fake.datasetCreateError;
      }
    }

    async createTable(
      id: string,
      metadata: TableMetadata,
    ): Promise<[FakeTable]> {
      fake.created.push({tableId: id, metadata});
      if (fake.createError !== undefined) {
        throw fake.createError;
      }
      return [new FakeTable(id)];
    }
  }

  class BigQueryMock {
    constructor(clientOptions: unknown) {
      fake.clientOptions.push(clientOptions);
      if (fake.clientError !== undefined) {
        throw fake.clientError;
      }
    }

    dataset(id: string): FakeDataset {
      return new FakeDataset(id);
    }
  }

  return {BigQueryMock, fake};
});

vi.mock('@google-cloud/bigquery', () => ({BigQuery: BigQueryMock}));

const PROJECT_ID = 'test-project';
const DATASET_ID = 'agent_analytics';

/** The plugin's delay before it retries a setup that failed once. */
const SETUP_BACKOFF_MS = 1000;

/** An error carrying the HTTP status BigQuery uses for "already exists". */
function conflictError(): Error {
  return Object.assign(new Error('Already Exists: Table'), {code: 409});
}

/** A quota rejection: a real status, and one no retry can clear. */
function quotaError(): Error {
  return Object.assign(new Error('quota exceeded'), {code: 403});
}

/**
 * A non-`LlmAgent` that happens to carry an `instruction` field, which is what
 * separates the branded `isLlmAgent` guard from a structural shape check.
 */
class InstructedPlainAgent extends BaseAgent {
  readonly instruction = 'Be helpful.';

  // eslint-disable-next-line require-yield -- BaseAgent mandates the generator signature; this fixture emits nothing.
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    return;
  }

  // eslint-disable-next-line require-yield -- BaseAgent mandates the generator signature; this fixture emits nothing.
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

function makeAgent(name = 'root_agent', instruction = 'Be helpful.'): LlmAgent {
  return new LlmAgent({name, model: 'gemini-2.0-flash', instruction});
}

function makeInvocationContext(
  options: {invocationId?: string; agent?: LlmAgent; branch?: string} = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: options.invocationId ?? 'inv-1',
    agent: options.agent ?? makeAgent(),
    branch: options.branch,
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'user-1',
    }),
    pluginManager: new PluginManager([]),
  });
}

function makeContext(invocationContext: InvocationContext): Context {
  return new Context({invocationContext});
}

/**
 * Plugins the running test built. Writes leave the callback, so a test that
 * never drains its plugin would otherwise land its rows in the next test.
 */
const openPlugins: BigQueryAgentAnalyticsPlugin[] = [];

function makePlugin(
  config: BigQueryLoggerConfig = {},
  options: {tableId?: string; location?: string} = {},
): BigQueryAgentAnalyticsPlugin {
  const plugin = new BigQueryAgentAnalyticsPlugin({
    projectId: PROJECT_ID,
    datasetId: DATASET_ID,
    tableId: options.tableId,
    location: options.location,
    config,
  });
  openPlugins.push(plugin);
  return plugin;
}

function makeLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'gemini-2.0-flash',
    contents: [{role: 'user', parts: [{text: 'hi'}]}],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

function makeTool(name = 'lookup_weather'): FunctionTool {
  return new FunctionTool({
    name,
    description: 'Looks up the weather.',
    execute: async () => ({temperature: 20}),
  });
}

/** Redirects `logger.warn` into `sink` until the returned function is called. */
function captureWarnings(sink: string[]): () => void {
  const capturing: Logger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      sink.push(args.map((arg) => String(arg)).join(' '));
    },
    error: () => {},
  };
  setLogger(capturing);
  return () => setLogger(null);
}

/** The rows written so far, in order. */
function rows(): AnalyticsRow[] {
  return fake.inserted;
}

/** The rows written so far whose `event_type` is `eventType`, in order. */
function rowsOfType(eventType: string): AnalyticsRow[] {
  return fake.inserted.filter((row) => row.event_type === eventType);
}

/**
 * The `USER_MESSAGE_RECEIVED` row; fails the test when there is not exactly
 * one. A message that answers a paused call writes a completion row too.
 */
function userMessageRow(): AnalyticsRow {
  const matching = rowsOfType(AnalyticsEventType.USER_MESSAGE_RECEIVED);
  expect(matching).toHaveLength(1);
  return matching[0];
}

/** The single row written so far; fails the test when there is not exactly one. */
function onlyRow(): AnalyticsRow {
  expect(rows()).toHaveLength(1);
  return rows()[0];
}

/** Parses a JSON-encoded column back into an object. */
function parseColumn(value: string | null): unknown {
  expect(value).not.toBeNull();
  return JSON.parse(value ?? 'null');
}

/** Records one full agent turn against `plugin`, returning the rows it wrote. */
async function runTurn(
  plugin: BigQueryAgentAnalyticsPlugin,
  invocationContext: InvocationContext,
): Promise<void> {
  const agent = makeAgent();
  const callbackContext = makeContext(invocationContext);
  const tool = makeTool();
  const userMessage: Content = {role: 'user', parts: [{text: 'weather?'}]};

  await plugin.onUserMessageCallback({invocationContext, userMessage});
  await plugin.beforeRunCallback({invocationContext});
  await plugin.beforeAgentCallback({agent, callbackContext});
  await plugin.beforeModelCallback({
    callbackContext,
    llmRequest: makeLlmRequest(),
  });
  await plugin.afterModelCallback({
    callbackContext,
    llmResponse: {content: {role: 'model', parts: [{text: 'sunny'}]}},
  });
  await plugin.beforeToolCallback({
    tool,
    toolArgs: {city: 'Paris'},
    toolContext: callbackContext,
  });
  await plugin.afterToolCallback({
    tool,
    toolArgs: {city: 'Paris'},
    toolContext: callbackContext,
    result: {temperature: 20},
  });
  await plugin.afterAgentCallback({agent, callbackContext});
  await plugin.afterRunCallback({invocationContext});
}

beforeEach(() => {
  openPlugins.length = 0;
  fake.clientOptions = [];
  fake.inserted = [];
  fake.insertIds = [];
  fake.insertCalls = 0;
  fake.created = [];
  fake.datasetsCreated = [];
  fake.getCalls = 0;
  fake.metadataReads = 0;
  fake.metadataUpdates = [];
  // A live table starts current, so the upgrade path is a no-op unless a test
  // makes the table older on purpose.
  fake.liveSchema = EVENTS_TABLE_SCHEMA;
  fake.liveLabels = {adk_schema_version: SCHEMA_VERSION};
  fake.metadataError = undefined;
  fake.tableExists = false;
  fake.datasetExists = true;
  fake.clientError = undefined;
  fake.createError = undefined;
  fake.datasetCreateError = undefined;
  fake.insertError = undefined;
  fake.insertGate = undefined;
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openPlugins.map((plugin) => plugin.shutdown()));
});

describe('BigQueryAgentAnalyticsPlugin lifecycle', () => {
  it('registers itself under a stable plugin name and needs no config', () => {
    const plugin = new BigQueryAgentAnalyticsPlugin({
      projectId: PROJECT_ID,
      datasetId: DATASET_ID,
    });
    expect(plugin.name).toBe('bigquery_agent_analytics');
  });

  it('has no side effects at all when disabled', async () => {
    const plugin = makePlugin({enabled: false});
    await runTurn(plugin, makeInvocationContext());
    await plugin.shutdown();
    expect(fake.clientOptions).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it('creates the table with day partitioning, clustering and the version label', async () => {
    const plugin = makePlugin(
      {clusteringFields: ['event_type', 'agent']},
      {tableId: 'my_events', location: 'EU'},
    );
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].tableId).toBe('my_events');
    expect(fake.created[0].metadata).toMatchObject({
      timePartitioning: {type: 'DAY', field: 'timestamp'},
      clustering: {fields: ['event_type', 'agent']},
      labels: {adk_schema_version: '2'},
      location: 'EU',
    });
    expect(fake.clientOptions[0]).toEqual({
      projectId: PROJECT_ID,
      location: 'EU',
      credentials: undefined,
      // The plugin owns the retry policy, so the client must not add its own.
      retryOptions: {autoRetry: false},
    });
  });

  it('declares the full 17-column schema on the created table', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    const schema = fake.created[0].metadata.schema;
    if (!Array.isArray(schema)) {
      expect.fail('the created table carries no field list');
    }
    const columns = schema.map((field) => field.name);
    expect(columns).toEqual([
      'timestamp',
      'event_id',
      'event_type',
      'agent',
      'session_id',
      'invocation_id',
      'user_id',
      'trace_id',
      'span_id',
      'parent_span_id',
      'content',
      'content_parts',
      'attributes',
      'latency_ms',
      'status',
      'error_message',
      'is_truncated',
    ]);
  });

  it('describes event_id by the de-duplication this transport gives', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    const schema = fake.created[0].metadata.schema;
    if (!Array.isArray(schema)) {
      expect.fail('the created table carries no field list');
    }
    const eventId = schema.find((field) => field.name === 'event_id');
    // A table holds rows from both SDKs, and whichever one creates it writes
    // this description. It must not promise the Storage Write API guarantees
    // that `tabledata.insertAll` does not give.
    expect(eventId?.description).toContain('insert id');
    expect(eventId?.description).not.toContain('Storage Write API');
  });

  it('reuses an existing table without creating one', async () => {
    fake.tableExists = true;
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(fake.created).toHaveLength(0);
    expect(rows()).toHaveLength(1);
  });

  it('creates the dataset at the configured location when it is absent', async () => {
    fake.datasetExists = false;
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(fake.datasetsCreated).toEqual([
      {id: DATASET_ID, options: {location: 'US'}},
    ]);
    expect(rows()).toHaveLength(1);
  });

  it('reuses an existing dataset without creating one', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(fake.datasetsCreated).toHaveLength(0);
  });

  it('proceeds when a concurrent process created the dataset first', async () => {
    fake.datasetExists = false;
    fake.datasetCreateError = conflictError();
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(rows()).toHaveLength(1);
  });

  it('drops the row when the dataset cannot be created', async () => {
    fake.datasetExists = false;
    fake.datasetCreateError = new Error('permission denied');
    const plugin = makePlugin();
    await expect(
      plugin.beforeRunCallback({invocationContext: makeInvocationContext()}),
    ).resolves.toBeUndefined();
    await plugin.flush();
    expect(rows()).toHaveLength(0);
    expect(plugin.getDropStats()['setup_unavailable']).toBe(1);
  });

  it('re-reads the table when a concurrent process created it first', async () => {
    fake.createError = conflictError();
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(fake.getCalls).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('drops the row and stays unstarted when the client cannot be built', async () => {
    fake.clientError = new Error('no credentials');
    const plugin = makePlugin();
    await expect(
      plugin.beforeRunCallback({invocationContext: makeInvocationContext()}),
    ).resolves.toBeUndefined();
    await plugin.flush();
    expect(rows()).toHaveLength(0);
    expect(plugin.getDropStats()['setup_unavailable']).toBe(1);
  });

  it('retries the setup on a later event', async () => {
    vi.useFakeTimers();
    fake.clientError = new Error('no credentials');
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.flush();
    fake.clientError = undefined;
    await vi.advanceTimersByTimeAsync(SETUP_BACKOFF_MS);
    await plugin.afterRunCallback({invocationContext});
    await plugin.flush();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].event_type).toBe(AnalyticsEventType.INVOCATION_COMPLETED);
  });

  it('waits out the backoff before it retries a failed setup', async () => {
    vi.useFakeTimers();
    fake.clientError = new Error('no credentials');
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.flush();
    fake.clientError = undefined;
    await vi.advanceTimersByTimeAsync(SETUP_BACKOFF_MS - 1);
    await plugin.afterRunCallback({invocationContext});
    await plugin.flush();
    expect(rows()).toHaveLength(0);
    expect(fake.clientOptions).toHaveLength(1);
    expect(plugin.getDropStats()['setup_unavailable']).toBe(2);
  });

  it('propagates a non-conflict create failure as a counted drop', async () => {
    fake.createError = new Error('permission denied');
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(fake.getCalls).toBe(0);
    expect(plugin.getDropStats()['setup_unavailable']).toBe(1);
  });

  it('is safe to shut down twice, and later callbacks write nothing', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.shutdown();
    await plugin.shutdown();
    await plugin.afterRunCallback({invocationContext});
    expect(rows()).toHaveLength(1);
  });

  it('makes a concurrent second shutdown wait for the first drain', async () => {
    let releaseInsert = (): void => {};
    fake.insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    const settled: string[] = [];
    const first = plugin.shutdown().then(() => void settled.push('first'));
    const second = plugin.shutdown().then(() => void settled.push('second'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toEqual([]);
    releaseInsert();
    await Promise.all([first, second]);
    expect(settled).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });

  it('shuts down cleanly before any event was recorded', async () => {
    const plugin = makePlugin();
    await plugin.shutdown();
    expect(fake.clientOptions).toHaveLength(0);
    expect(plugin.getDropStats()['shutdown_timeout']).toBe(0);
  });

  it('starts every drop counter at zero', () => {
    expect(makePlugin().getDropStats()).toEqual({
      queue_full: 0,
      retry_exhausted: 0,
      non_retryable: 0,
      unexpected_error: 0,
      shutdown_timeout: 0,
      shutdown_race: 0,
      setup_unavailable: 0,
      formatter_failed: 0,
      content_parse_failed: 0,
    });
  });
});

describe('BigQueryAgentAnalyticsPlugin filtering', () => {
  it('writes only the allowlisted event types', async () => {
    const plugin = makePlugin({
      eventAllowlist: [AnalyticsEventType.INVOCATION_COMPLETED],
    });
    await runTurn(plugin, makeInvocationContext());
    expect(rows().map((row) => row.event_type)).toEqual([
      AnalyticsEventType.INVOCATION_COMPLETED,
    ]);
  });

  it('suppresses the denylisted event types', async () => {
    const plugin = makePlugin({
      eventDenylist: [
        AnalyticsEventType.LLM_REQUEST,
        AnalyticsEventType.LLM_RESPONSE,
      ],
    });
    await runTurn(plugin, makeInvocationContext());
    const written = rows().map((row) => row.event_type);
    expect(written).not.toContain(AnalyticsEventType.LLM_REQUEST);
    expect(written).not.toContain(AnalyticsEventType.LLM_RESPONSE);
    expect(written).toContain(AnalyticsEventType.AGENT_STARTING);
  });

  it('applies the denylist before the allowlist', async () => {
    const plugin = makePlugin({
      eventAllowlist: [AnalyticsEventType.INVOCATION_STARTING],
      eventDenylist: [AnalyticsEventType.INVOCATION_STARTING],
    });
    await runTurn(plugin, makeInvocationContext());
    expect(rows()).toHaveLength(0);
  });
});

describe('BigQueryAgentAnalyticsPlugin row contents', () => {
  it('writes the identity columns on every row', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row).toMatchObject({
      event_type: AnalyticsEventType.INVOCATION_STARTING,
      agent: 'root_agent',
      session_id: 'session-1',
      invocation_id: 'inv-1',
      user_id: 'user-1',
      status: 'OK',
      error_message: null,
      is_truncated: false,
    });
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('uses the row event id as the BigQuery insert id', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(fake.insertIds).toEqual([onlyRow().event_id]);
  });

  it('gives every row a distinct event id', async () => {
    const plugin = makePlugin();
    await runTurn(plugin, makeInvocationContext());
    const ids = rows().map((row) => row.event_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('writes the root agent name into attributes', async () => {
    const child = makeAgent('child_agent');
    const root = new LlmAgent({
      name: 'parent_agent',
      model: 'gemini-2.0-flash',
      subAgents: [child],
    });
    expect(child.parentAgent).toBe(root);
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext({agent: child}),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      root_agent_name: 'parent_agent',
    });
  });

  it('writes session metadata when it is enabled', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext({branch: 'root.child'}),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      session_metadata: {
        session_id: 'session-1',
        app_name: 'test-app',
        user_id: 'user-1',
      },
    });
  });

  it('keeps the branch out of session metadata, which adk-python never writes', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext({branch: 'root.child'}),
    });
    await plugin.flush();
    const attributes = parseColumn(onlyRow().attributes);
    expect(attributes).toBeTypeOf('object');
    const metadata = (attributes as {session_metadata: object})
      .session_metadata;
    expect(metadata).not.toHaveProperty('branch');
  });

  it('carries the session state a caller set', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    invocationContext.session.state['customer_id'] = 'c-42';
    await plugin.beforeRunCallback({invocationContext});
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      session_metadata: {state: {customer_id: 'c-42'}},
    });
  });

  it('redacts a credential the session state carries', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    invocationContext.session.state['api_key'] = 'sk-secret-value';
    await plugin.beforeRunCallback({invocationContext});
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      session_metadata: {state: {api_key: '[REDACTED]'}},
    });
  });

  it('omits the state key for a session that has none', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    const attributes = parseColumn(onlyRow().attributes);
    expect(attributes).toBeTypeOf('object');
    const metadata = (attributes as {session_metadata: object})
      .session_metadata;
    expect(metadata).not.toHaveProperty('state');
  });

  it('omits session metadata when it is disabled', async () => {
    const plugin = makePlugin({logSessionMetadata: false});
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).not.toHaveProperty(
      'session_metadata',
    );
  });

  it('copies the custom tags into attributes', async () => {
    const plugin = makePlugin({customTags: {agentRole: 'sales'}});
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      custom_tags: {agentRole: 'sales'},
    });
  });

  it('writes the model and the generation config on an LLM_REQUEST row', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeModelCallback({
      callbackContext: makeContext(invocationContext),
      llmRequest: makeLlmRequest({
        config: {temperature: 0.5, topP: 0.9, maxOutputTokens: 128},
        toolsDict: {lookup_weather: makeTool()},
      }),
    });
    await plugin.flush();
    const attributes = parseColumn(onlyRow().attributes);
    expect(attributes).toMatchObject({
      model: 'gemini-2.0-flash',
      llm_config: {temperature: 0.5, top_p: 0.9, max_output_tokens: 128},
      tools: ['lookup_weather'],
    });
  });

  it('writes the request labels into attributes', async () => {
    const plugin = makePlugin();
    await plugin.beforeModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmRequest: makeLlmRequest({config: {labels: {team: 'search'}}}),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      labels: {team: 'search'},
    });
  });

  it('summarizes a response whose parts are calls, responses and media', async () => {
    const plugin = makePlugin();
    await plugin.afterModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmResponse: {
        content: {
          role: 'model',
          parts: [
            {functionCall: {name: 'lookup_weather', args: {}}},
            {functionResponse: {name: 'lookup_weather', response: {}}},
            {inlineData: {data: 'AAAA', mimeType: 'image/png'}},
          ],
        },
      },
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      response: 'call: lookup_weather | resp: lookup_weather | other',
    });
  });

  it('summarizes an empty response as None', async () => {
    const plugin = makePlugin();
    await plugin.afterModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmResponse: {content: {role: 'model', parts: []}},
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({response: 'None'});
  });

  it('writes the prompt and the system instruction as the request content', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeModelCallback({
      callbackContext: makeContext(invocationContext),
      llmRequest: makeLlmRequest({
        config: {systemInstruction: 'Be terse.'},
      }),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      prompt: [{role: 'user', content: 'hi'}],
      system_prompt: 'Be terse.',
    });
  });

  it('writes usage, model version and finish reason on an LLM_RESPONSE row', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    const llmResponse: LlmResponse = {
      content: {role: 'model', parts: [{text: 'sunny'}]},
      modelVersion: 'gemini-2.0-flash-001',
      finishReason: FinishReason.STOP,
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 3,
        totalTokenCount: 14,
      },
    };
    await plugin.afterModelCallback({
      callbackContext: makeContext(invocationContext),
      llmResponse,
    });
    await plugin.flush();
    const row = onlyRow();
    expect(parseColumn(row.content)).toEqual({
      response: "text: 'sunny'",
      usage: {prompt: 11, completion: 3, total: 14},
    });
    expect(parseColumn(row.attributes)).toMatchObject({
      model_version: 'gemini-2.0-flash-001',
      finish_reason: 'STOP',
      usage_metadata: {promptTokenCount: 11},
    });
  });

  it('carries an LLM_RESPONSE error message while the status stays OK', async () => {
    const plugin = makePlugin();
    await plugin.afterModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmResponse: {errorCode: 'SAFETY', errorMessage: 'blocked'},
    });
    await plugin.flush();
    expect(onlyRow()).toMatchObject({status: 'OK', error_message: 'blocked'});
  });

  it('falls back to the error code when the response carries no message', async () => {
    const plugin = makePlugin();
    await plugin.afterModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmResponse: {errorCode: 'SAFETY'},
    });
    await plugin.flush();
    expect(onlyRow().error_message).toBe('SAFETY');
  });

  it('writes the agent instruction on an AGENT_STARTING row', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeAgentCallback({
      agent: makeAgent('root_agent', 'Answer weather questions.'),
      callbackContext: makeContext(invocationContext),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toBe('Answer weather questions.');
  });

  it('writes an empty instruction for a non-LlmAgent that has one', async () => {
    const plugin = makePlugin();
    const agent = new InstructedPlainAgent({name: 'plain_agent'});
    const invocationContext = makeInvocationContext();
    await plugin.beforeAgentCallback({
      agent,
      callbackContext: makeContext(invocationContext),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toBe('');
  });

  it('writes an empty instruction when the agent builds one dynamically', async () => {
    const plugin = makePlugin();
    const agent = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.0-flash',
      instruction: () => 'built at run time',
    });
    await plugin.beforeAgentCallback({
      agent,
      callbackContext: makeContext(makeInvocationContext()),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toBe('');
  });

  it.each([
    [{promptTokenCount: 7}, {prompt: 7, completion: 0, total: 0}],
    [{candidatesTokenCount: 3}, {prompt: 0, completion: 3, total: 0}],
  ])('defaults the token counts %j omits to zero', async (usage, expected) => {
    const plugin = makePlugin();
    await plugin.afterModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmResponse: {usageMetadata: usage},
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({usage: expected});
  });

  it('names the emitting event author when the invocation has no agent', async () => {
    const plugin = makePlugin();
    const invocationContext = new InvocationContext({
      invocationId: 'inv-node',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'user-1',
      }),
      pluginManager: new PluginManager([]),
    });
    await plugin.onEventCallback({
      invocationContext,
      event: createEvent({
        author: 'summarize_node',
        actions: {stateDelta: {done: true}},
      }),
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.agent).toBe('summarize_node');
    expect(parseColumn(row.attributes)).toMatchObject({root_agent_name: null});
  });

  it('leaves the agent column null when nothing names one', async () => {
    const plugin = makePlugin();
    const invocationContext = new InvocationContext({
      invocationId: 'inv-node',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        userId: 'user-1',
      }),
      pluginManager: new PluginManager([]),
    });
    await plugin.beforeRunCallback({invocationContext});
    await plugin.flush();
    expect(onlyRow().agent).toBeNull();
  });

  it('writes the tool name and arguments on a TOOL_STARTING row', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeToolCallback({
      tool: makeTool(),
      toolArgs: {city: 'Paris'},
      toolContext: makeContext(invocationContext),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      tool: 'lookup_weather',
      args: {city: 'Paris'},
      tool_origin: ToolOrigin.LOCAL,
    });
  });

  it('parents INVOCATION_COMPLETED on the agent span left open by an abnormal exit', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeAgentCallback({
      agent: makeAgent(),
      callbackContext: makeContext(invocationContext),
    });
    await plugin.afterRunCallback({invocationContext});
    await plugin.flush();
    const [starting, agentStarting, completed] = rows();
    expect(completed.event_type).toBe(AnalyticsEventType.INVOCATION_COMPLETED);
    expect(completed.span_id).toBe(agentStarting.span_id);
    expect(completed.parent_span_id).toBe(starting.span_id);
  });

  it('records the total latency on a completion row', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});
    await plugin.flush();
    const completed = rows()[1];
    expect(completed.event_type).toBe(AnalyticsEventType.INVOCATION_COMPLETED);
    expect(parseColumn(completed.latency_ms)).toHaveProperty('total_ms');
  });

  it('leaves latency null on a row that measures nothing', async () => {
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(onlyRow().latency_ms).toBeNull();
  });
});

describe('BigQueryAgentAnalyticsPlugin content safety', () => {
  it('truncates over-long content and flags the row', async () => {
    const plugin = makePlugin({maxContentLength: 10});
    await plugin.beforeToolCallback({
      tool: makeTool(),
      toolArgs: {note: 'x'.repeat(200)},
      toolContext: makeContext(makeInvocationContext()),
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.is_truncated).toBe(true);
    expect(parseColumn(row.content)).toEqual({
      tool: 'lookup_wea...[TRUNCATED]',
      args: {note: 'xxxxxxxxxx...[TRUNCATED]'},
      tool_origin: ToolOrigin.LOCAL,
    });
  });

  it('leaves is_truncated false for content within the limit', async () => {
    const plugin = makePlugin({maxContentLength: 1000});
    await plugin.beforeToolCallback({
      tool: makeTool(),
      toolArgs: {note: 'short'},
      toolContext: makeContext(makeInvocationContext()),
    });
    await plugin.flush();
    expect(onlyRow().is_truncated).toBe(false);
  });

  it('keeps a secret in a tool argument out of the whole serialized row', async () => {
    const plugin = makePlugin();
    await plugin.beforeToolCallback({
      tool: makeTool(),
      toolArgs: {apiKey: 'AIza-super-secret', city: 'Paris'},
      toolContext: makeContext(makeInvocationContext()),
    });
    await plugin.flush();
    expect(JSON.stringify(onlyRow())).not.toContain('AIza-super-secret');
    expect(parseColumn(onlyRow().content)).toEqual({
      tool: 'lookup_weather',
      args: {apiKey: '[REDACTED]', city: 'Paris'},
      tool_origin: ToolOrigin.LOCAL,
    });
  });

  it('applies a content formatter', async () => {
    const plugin = makePlugin({
      contentFormatter: (content, eventType) => ({
        seen: eventType,
        original: content,
      }),
    });
    await plugin.beforeToolCallback({
      tool: makeTool(),
      toolArgs: {city: 'Paris'},
      toolContext: makeContext(makeInvocationContext()),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      seen: 'TOOL_STARTING',
      original: {
        tool: 'lookup_weather',
        args: {city: 'Paris'},
        tool_origin: ToolOrigin.LOCAL,
      },
    });
  });

  it('writes a sentinel and leaks nothing when the formatter throws', async () => {
    const warnings: string[] = [];
    const plugin = makePlugin({
      contentFormatter: () => {
        throw new Error('boom AIza-super-secret');
      },
    });
    const restore = captureWarnings(warnings);
    await plugin.beforeToolCallback({
      tool: makeTool(),
      toolArgs: {password: 'AIza-super-secret'},
      toolContext: makeContext(makeInvocationContext()),
    });
    restore();
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toBe('[FORMATTER_FAILED]');
    expect(plugin.getDropStats()['formatter_failed']).toBe(1);
    expect(warnings.join(' ')).not.toContain('AIza-super-secret');
    expect(warnings.join(' ')).not.toContain('boom');
  });

  it('writes a sentinel and leaks nothing when the payload cannot be read', async () => {
    const warnings: string[] = [];
    const hostile = {
      get city(): string {
        throw new Error('boom AIza-super-secret');
      },
    };
    const plugin = makePlugin();
    const restore = captureWarnings(warnings);
    await plugin.beforeToolCallback({
      tool: makeTool(),
      toolArgs: hostile,
      toolContext: makeContext(makeInvocationContext()),
    });
    restore();
    await plugin.flush();
    const row = onlyRow();
    expect(parseColumn(row.content)).toBe('[CONTENT_PARSE_FAILED]');
    expect(row.is_truncated).toBe(true);
    expect(plugin.getDropStats()['content_parse_failed']).toBe(1);
    expect(warnings.join(' ')).not.toContain('AIza-super-secret');
  });

  it('sanitizes an error message before writing it', async () => {
    const plugin = makePlugin({maxContentLength: 5});
    await plugin.onToolErrorCallback({
      tool: makeTool(),
      toolArgs: {},
      toolContext: makeContext(makeInvocationContext()),
      error: new Error('a very long failure message'),
    });
    await plugin.flush();
    expect(onlyRow()).toMatchObject({
      status: 'ERROR',
      error_message: 'a ver...[TRUNCATED]',
      is_truncated: true,
    });
  });

  it('records a model error with the formatted cause', async () => {
    const plugin = makePlugin();
    await plugin.onModelErrorCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmRequest: makeLlmRequest(),
      error: new Error('model unavailable'),
    });
    await plugin.flush();
    expect(onlyRow()).toMatchObject({
      event_type: AnalyticsEventType.LLM_ERROR,
      status: 'ERROR',
      error_message: 'model unavailable',
    });
  });
});

describe('BigQueryAgentAnalyticsPlugin content parts', () => {
  const multiPart: Content = {
    role: 'user',
    parts: [
      {text: 'hello'},
      {fileData: {fileUri: 'gs://bucket/a.png', mimeType: 'image/png'}},
      {inlineData: {data: 'AAAA', mimeType: 'image/jpeg'}},
      {functionCall: {name: 'lookup_weather', args: {city: 'Paris'}}},
      {functionResponse: {name: 'lookup_weather', response: {temp: 20}}},
      {executableCode: {code: 'print(1)', language: Language.PYTHON}},
      {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: '1'}},
      {},
    ],
  };

  it('writes one record per part, in order', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: multiPart,
    });
    await plugin.flush();
    const parts = userMessageRow().content_parts;
    expect(parts.map((part) => part.part_index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(parts[0]).toMatchObject({text: 'hello', storage_mode: 'INLINE'});
    expect(parts[1]).toMatchObject({
      uri: 'gs://bucket/a.png',
      mime_type: 'image/png',
      storage_mode: 'EXTERNAL_URI',
    });
    expect(parts[2]).toMatchObject({text: '[BINARY DATA]'});
    expect(parts[3]).toMatchObject({
      text: 'Function: lookup_weather',
      mime_type: 'application/json',
      part_attributes: '{"function_name":"lookup_weather"}',
    });
    expect(parts[4]).toMatchObject({text: 'Function response: lookup_weather'});
    expect(parts[5]).toMatchObject({text: 'print(1)'});
    expect(parts[6]).toMatchObject({text: '1'});
    expect(parts[7]).toMatchObject({text: null, mime_type: 'text/plain'});
  });

  it('summarizes the parts into the content column', async () => {
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: multiPart,
    });
    await plugin.flush();
    expect(parseColumn(userMessageRow().content)).toEqual({
      text_summary:
        'hello | Function response: lookup_weather | ' +
        'Executable code (PYTHON): print(1) | ' +
        'Code execution result (OUTCOME_OK): 1',
    });
  });

  it('leaves content_parts empty when multi-modal logging is off', async () => {
    const plugin = makePlugin({logMultiModalContent: false});
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: multiPart,
    });
    await plugin.flush();
    expect(userMessageRow().content_parts).toEqual([]);
  });

  it('falls back to defaults for parts missing their optional fields', async () => {
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {
        role: 'user',
        parts: [
          {fileData: {}},
          {executableCode: {}},
          {codeExecutionResult: {}},
        ],
      },
    });
    await plugin.flush();
    const parts = onlyRow().content_parts;
    expect(parts[0]).toMatchObject({
      uri: '[REDACTED_SENSITIVE_URI]',
      mime_type: 'text/plain',
    });
    expect(parts[1]).toMatchObject({text: ''});
    expect(parts[2]).toMatchObject({text: ''});
    expect(parseColumn(onlyRow().content)).toEqual({
      text_summary:
        'Executable code (unknown):  | Code execution result (unknown): ',
    });
  });

  it('handles a request message that carries neither role nor parts', async () => {
    const plugin = makePlugin();
    await plugin.beforeModelCallback({
      callbackContext: makeContext(makeInvocationContext()),
      llmRequest: makeLlmRequest({contents: [{}]}),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      prompt: [{role: 'unknown', content: ''}],
    });
  });

  it('redacts a credential carried in a file URI query string', async () => {
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri: 'https://example.com/a.png?access_token=AIza-secret',
              mimeType: 'image/png',
            },
          },
        ],
      },
    });
    await plugin.flush();
    expect(onlyRow().content_parts[0].uri).not.toContain('AIza-secret');
  });
});

describe('BigQueryAgentAnalyticsPlugin spans and traces', () => {
  it('pairs an LLM request and its response on one span id', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    const callbackContext = makeContext(invocationContext);
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: makeLlmRequest(),
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {content: {role: 'model', parts: [{text: 'ok'}]}},
    });
    await plugin.flush();
    expect(rows()[0].span_id).toBe(rows()[1].span_id);
    expect(rows()[0].span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('pairs a tool start and its completion on one span id', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    const callbackContext = makeContext(invocationContext);
    const tool = makeTool();
    await plugin.beforeToolCallback({
      tool,
      toolArgs: {},
      toolContext: callbackContext,
    });
    await plugin.afterToolCallback({
      tool,
      toolArgs: {},
      toolContext: callbackContext,
      result: {},
    });
    await plugin.flush();
    expect(rows()[0].span_id).toBe(rows()[1].span_id);
  });

  it('keeps one span id across streaming chunks and pops on the final one', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    const callbackContext = makeContext(invocationContext);
    await plugin.beforeAgentCallback({
      agent: makeAgent(),
      callbackContext,
    });
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: makeLlmRequest(),
    });
    for (const chunk of ['su', 'nny']) {
      await plugin.afterModelCallback({
        callbackContext,
        llmResponse: {
          partial: true,
          content: {role: 'model', parts: [{text: chunk}]},
        },
      });
    }
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {content: {role: 'model', parts: [{text: 'sunny'}]}},
    });
    await plugin.afterAgentCallback({agent: makeAgent(), callbackContext});

    await plugin.flush();
    const modelRows = rows().slice(1, 5);
    const spanIds = new Set(modelRows.map((row) => row.span_id));
    expect(spanIds.size).toBe(1);
    const agentCompleted = rows()[5];
    expect(agentCompleted.event_type).toBe(AnalyticsEventType.AGENT_COMPLETED);
    expect(agentCompleted.span_id).toBe(rows()[0].span_id);
  });

  it('records the time to first token on a streamed response', async () => {
    const plugin = makePlugin();
    const callbackContext = makeContext(makeInvocationContext());
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: makeLlmRequest(),
    });
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {
        partial: true,
        content: {role: 'model', parts: [{text: 'su'}]},
      },
    });
    await plugin.flush();
    expect(parseColumn(rows()[1].latency_ms)).toHaveProperty(
      'time_to_first_token_ms',
    );
  });

  it('does not stack a span for a model call that never returned', async () => {
    const plugin = makePlugin();
    const callbackContext = makeContext(makeInvocationContext());
    await plugin.beforeAgentCallback({agent: makeAgent(), callbackContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: makeLlmRequest(),
    });
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: makeLlmRequest(),
    });
    await plugin.flush();
    const [agentStarting, first, second] = rows();
    expect(first.parent_span_id).toBe(agentStarting.span_id);
    expect(second.parent_span_id).toBe(agentStarting.span_id);
  });

  it('gives every row of one invocation the same trace id', async () => {
    const plugin = makePlugin();
    await runTurn(plugin, makeInvocationContext());
    const traceIds = new Set(rows().map((row) => row.trace_id));
    expect(traceIds.size).toBe(1);
    expect(rows().at(-1)?.event_type).toBe(
      AnalyticsEventType.INVOCATION_COMPLETED,
    );
  });

  it('adopts the ambient OpenTelemetry trace id', async () => {
    const ambient = trace.wrapSpanContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    });
    const active = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(ambient);
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    active.mockRestore();
    await plugin.flush();
    expect(onlyRow().trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('ignores an ambient span whose context is not valid', async () => {
    const ambient = trace.wrapSpanContext({
      traceId: '00000000000000000000000000000000',
      spanId: '0000000000000000',
      traceFlags: TraceFlags.NONE,
    });
    const active = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(ambient);
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    active.mockRestore();
    await plugin.flush();
    expect(onlyRow().trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(onlyRow().trace_id).not.toBe('00000000000000000000000000000000');
  });

  it('keeps two concurrent invocations on separate span stacks', async () => {
    const plugin = makePlugin();
    const first = makeInvocationContext({invocationId: 'inv-a'});
    const second = makeInvocationContext({invocationId: 'inv-b'});
    await plugin.beforeRunCallback({invocationContext: first});
    await plugin.beforeRunCallback({invocationContext: second});
    await plugin.beforeAgentCallback({
      agent: makeAgent(),
      callbackContext: makeContext(first),
    });
    await plugin.flush();
    const [startedA, startedB, agentA] = rows();
    expect(startedA.trace_id).not.toBe(startedB.trace_id);
    expect(agentA.parent_span_id).toBe(startedA.span_id);
    expect(agentA.trace_id).toBe(startedA.trace_id);
  });

  it('reuses the root span while the invocation is still tracked', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeRunCallback({invocationContext});
    await plugin.flush();
    expect(rows()[1].span_id).toBe(rows()[0].span_id);
  });

  it('evicts the oldest invocation once the span map is full', async () => {
    const plugin = makePlugin({
      eventAllowlist: [AnalyticsEventType.INVOCATION_STARTING],
    });
    const first = makeInvocationContext({invocationId: 'inv-0'});
    await plugin.beforeRunCallback({invocationContext: first});
    for (let i = 1; i <= 1024; i++) {
      await plugin.beforeRunCallback({
        invocationContext: makeInvocationContext({invocationId: `inv-${i}`}),
      });
    }
    await plugin.beforeRunCallback({invocationContext: first});
    // inv-0 was evicted, so it is seeded with a fresh root span instead of
    // reusing the one it had before the cap was reached.
    await plugin.flush();
    expect(rows().at(-1)?.span_id).not.toBe(rows()[0].span_id);
  });
});

describe('BigQueryAgentAnalyticsPlugin onEventCallback', () => {
  it('writes a STATE_DELTA row for a non-empty delta', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.onEventCallback({
      invocationContext,
      event: createEvent({
        author: 'root_agent',
        actions: {stateDelta: {counter: 3}},
      }),
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.event_type).toBe(AnalyticsEventType.STATE_DELTA);
    expect(parseColumn(row.attributes)).toMatchObject({
      state_delta: {counter: 3},
    });
  });

  it('writes nothing for an empty state delta', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({author: 'root_agent'}),
    });
    await plugin.flush();
    expect(rows()).toHaveLength(0);
  });

  it('writes an AGENT_STATE_CHECKPOINT row for a saved agent state', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        actions: {agentState: {cursor: 7}},
      }),
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.event_type).toBe(AnalyticsEventType.AGENT_STATE_CHECKPOINT);
    expect(parseColumn(row.content)).toEqual({
      agent_state: {cursor: 7},
      end_of_agent: false,
    });
  });

  it('writes an AGENT_STATE_CHECKPOINT row for the end of an agent that saved no state', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        actions: {endOfAgent: true},
      }),
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.event_type).toBe(AnalyticsEventType.AGENT_STATE_CHECKPOINT);
    expect(parseColumn(row.content)).toEqual({
      agent_state: null,
      end_of_agent: true,
    });
  });

  it('writes no checkpoint row when the agent neither saved state nor ended', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        actions: {endOfAgent: false, stateDelta: {counter: 1}},
      }),
    });
    await plugin.flush();
    expect(rowsOfType(AnalyticsEventType.AGENT_STATE_CHECKPOINT)).toHaveLength(
      0,
    );
  });

  it('writes an AGENT_RESPONSE row for a final text answer', async () => {
    const plugin = makePlugin();
    const event = createEvent({
      author: 'root_agent',
      branch: 'root',
      content: {role: 'model', parts: [{text: 'sunny'}]},
    });
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event,
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.event_type).toBe(AnalyticsEventType.AGENT_RESPONSE);
    expect(parseColumn(row.content)).toEqual({response: "text: 'sunny'"});
    expect(parseColumn(row.attributes)).toMatchObject({
      adk: {source_event_id: event.id, branch: 'root'},
    });
    expect(row.agent).toBe('root_agent');
  });

  it('writes an AGENT_RESPONSE row for an event rehydrated without tool ids', async () => {
    const plugin = makePlugin();
    const rehydrated: Event = {
      id: 'evt-1',
      invocationId: 'inv-1',
      author: 'root_agent',
      actions: createEventActions(),
      timestamp: Date.now(),
      content: {role: 'model', parts: [{text: 'sunny'}]},
    };
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: rehydrated,
    });
    await plugin.flush();
    expect(onlyRow().event_type).toBe(AnalyticsEventType.AGENT_RESPONSE);
  });

  it.each<[string, Event]>([
    [
      'a partial event',
      createEvent({
        partial: true,
        content: {role: 'model', parts: [{text: 'su'}]},
      }),
    ],
    [
      'an event carrying a function call',
      createEvent({
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'lookup_weather', args: {}}}],
        },
      }),
    ],
    [
      'an event carrying a function response',
      createEvent({
        content: {
          role: 'user',
          parts: [{functionResponse: {name: 'lookup_weather', response: {}}}],
        },
      }),
    ],
    [
      'an event pausing on a long-running tool',
      createEvent({
        longRunningToolIds: ['fc-1'],
        content: {role: 'model', parts: [{text: 'working'}]},
      }),
    ],
    [
      'an event whose parts are all thoughts',
      createEvent({
        content: {role: 'model', parts: [{text: 'reasoning', thought: true}]},
      }),
    ],
    [
      'an event with no parts',
      createEvent({content: {role: 'model', parts: []}}),
    ],
    [
      'an event whose only text is empty',
      createEvent({content: {role: 'model', parts: [{text: ''}]}}),
    ],
    [
      'an event carrying only executable code',
      createEvent({
        content: {
          role: 'model',
          parts: [
            {executableCode: {code: 'print(1)', language: Language.PYTHON}},
          ],
        },
      }),
    ],
    ['an event with no content at all', createEvent({author: 'root_agent'})],
  ])('writes no AGENT_RESPONSE row for %s', async (_label, event) => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event,
    });
    await plugin.flush();
    expect(
      rows().filter(
        (row) => row.event_type === AnalyticsEventType.AGENT_RESPONSE,
      ),
    ).toHaveLength(0);
  });
});

describe('BigQueryAgentAnalyticsPlugin custom metadata capture', () => {
  /** Writes one STATE_DELTA row from an event carrying `customMetadata`. */
  async function logEventWithMetadata(
    config: BigQueryLoggerConfig,
    customMetadata: Record<string, unknown>,
  ): Promise<AnalyticsRow> {
    const plugin = makePlugin(config);
    const event = createEvent({
      author: 'root_agent',
      actions: {stateDelta: {counter: 1}},
    });
    event.customMetadata = customMetadata;
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event,
    });
    await plugin.flush();
    return onlyRow();
  }

  it('captures nothing when no allowlist is configured', async () => {
    const row = await logEventWithMetadata({}, {'a2a:task_id': 'task-1'});
    expect(parseColumn(row.attributes)).not.toHaveProperty('custom_metadata');
  });

  it('captures nothing when the allowlist is empty', async () => {
    const row = await logEventWithMetadata(
      {customMetadataAllowlist: []},
      {'a2a:task_id': 'task-1'},
    );
    expect(parseColumn(row.attributes)).not.toHaveProperty('custom_metadata');
  });

  it('captures a key the allowlist names in full', async () => {
    const row = await logEventWithMetadata(
      {customMetadataAllowlist: ['tenant_id']},
      {tenant_id: 'acme', other: 'dropped'},
    );
    expect(parseColumn(row.attributes)).toMatchObject({
      custom_metadata: {tenant_id: 'acme'},
    });
    const attributes = parseColumn(row.attributes) as {
      custom_metadata: Record<string, unknown>;
    };
    expect(attributes.custom_metadata).not.toHaveProperty('other');
  });

  it('captures every key under an allowlisted prefix', async () => {
    const row = await logEventWithMetadata(
      {customMetadataAllowlist: ['a2a:*']},
      {'a2a:task_id': 'task-1', 'a2a:context_id': 'ctx-1', unrelated: 'no'},
    );
    expect(parseColumn(row.attributes)).toMatchObject({
      custom_metadata: {'a2a:task_id': 'task-1', 'a2a:context_id': 'ctx-1'},
    });
  });

  it('treats a plain key as exact, not as a prefix', async () => {
    const row = await logEventWithMetadata(
      {customMetadataAllowlist: ['tenant']},
      {tenant_id: 'acme'},
    );
    expect(parseColumn(row.attributes)).not.toHaveProperty('custom_metadata');
  });

  it('writes no key at all when nothing in the event matches', async () => {
    const row = await logEventWithMetadata(
      {customMetadataAllowlist: ['tenant_id']},
      {other: 'value'},
    );
    expect(parseColumn(row.attributes)).not.toHaveProperty('custom_metadata');
  });

  it('captures nothing from a row that has no source event', async () => {
    const plugin = makePlugin({customMetadataAllowlist: ['tenant_id']});
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).not.toHaveProperty(
      'custom_metadata',
    );
  });

  it('redacts a captured credential like any other captured value', async () => {
    const row = await logEventWithMetadata(
      {customMetadataAllowlist: ['api_key', 'caller']},
      {api_key: 'a-real-looking-key', caller: 'alice'},
    );
    expect(parseColumn(row.attributes)).toMatchObject({
      custom_metadata: {api_key: '[REDACTED]', caller: 'alice'},
    });
  });

  it('truncates a captured value and marks the row truncated', async () => {
    const row = await logEventWithMetadata(
      {customMetadataAllowlist: ['note'], maxContentLength: 10},
      {note: 'x'.repeat(200)},
    );
    expect(row.is_truncated).toBe(true);
    expect(JSON.stringify(parseColumn(row.attributes))).toContain('TRUNCATED');
  });

  it('replaces a captured cycle instead of failing the row', async () => {
    const cyclic: Record<string, unknown> = {name: 'loop'};
    cyclic['self'] = cyclic;
    const row = await logEventWithMetadata(
      {customMetadataAllowlist: ['ref']},
      {ref: cyclic},
    );
    expect(JSON.stringify(parseColumn(row.attributes))).toContain(
      'CIRCULAR_REFERENCE',
    );
  });
});

describe('BigQueryAgentAnalyticsPlugin shutdown race', () => {
  it('counts a row produced after shutdown began', async () => {
    const plugin = makePlugin();
    await plugin.shutdown();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    expect(plugin.getDropStats()['shutdown_race']).toBe(1);
    expect(rows()).toHaveLength(0);
  });

  it('counts nothing for an event type the denylist already suppresses', async () => {
    const plugin = makePlugin({
      eventDenylist: [AnalyticsEventType.INVOCATION_STARTING],
    });
    await plugin.shutdown();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    expect(plugin.getDropStats()['shutdown_race']).toBe(0);
  });

  it('counts nothing while the plugin is disabled', async () => {
    const plugin = makePlugin({enabled: false});
    await plugin.shutdown();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    expect(plugin.getDropStats()['shutdown_race']).toBe(0);
  });
});

describe('BigQueryAgentAnalyticsPlugin pauses and human in the loop', () => {
  it.each<[string, string, string]>([
    [
      'adk_request_credential',
      AnalyticsEventType.HITL_CREDENTIAL_REQUEST,
      'hitl_credential',
    ],
    [
      'adk_request_confirmation',
      AnalyticsEventType.HITL_CONFIRMATION_REQUEST,
      'hitl_confirmation',
    ],
    ['adk_request_input', AnalyticsEventType.HITL_INPUT_REQUEST, 'hitl_input'],
  ])('writes a %s call as %s', async (callName, eventType, pauseKind) => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'fc-1', name: callName, args: {scope: 'a'}}},
          ],
        },
      }),
    });
    await plugin.flush();
    const request = rowsOfType(eventType);
    expect(request).toHaveLength(1);
    expect(parseColumn(request[0].content)).toEqual({
      tool: callName,
      args: {scope: 'a'},
    });
    expect(parseColumn(request[0].attributes)).toMatchObject({
      adk: {pause_kind: pauseKind, function_call_id: 'fc-1'},
    });
  });

  it('takes the pause kind from the call name, not the call id', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        longRunningToolIds: ['adk_request_input'],
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'adk_request_input',
                name: 'lookup_weather',
                args: {},
              },
            },
          ],
        },
      }),
    });
    await plugin.flush();
    const paused = rowsOfType(AnalyticsEventType.TOOL_PAUSED);
    expect(paused).toHaveLength(1);
    expect(parseColumn(paused[0].attributes)).toMatchObject({
      adk: {pause_kind: 'tool'},
    });
    expect(rowsOfType(AnalyticsEventType.HITL_INPUT_REQUEST)).toHaveLength(0);
  });

  it('writes TOOL_PAUSED for an ordinary long-running call', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        longRunningToolIds: ['fc-1'],
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-1',
                name: 'lookup_weather',
                args: {city: 'Paris'},
              },
            },
          ],
        },
      }),
    });
    await plugin.flush();
    const paused = rowsOfType(AnalyticsEventType.TOOL_PAUSED);
    expect(paused).toHaveLength(1);
    expect(parseColumn(paused[0].content)).toEqual({
      tool: 'lookup_weather',
      args: {city: 'Paris'},
    });
    expect(parseColumn(paused[0].attributes)).toMatchObject({
      adk: {pause_kind: 'tool', function_call_id: 'fc-1'},
    });
  });

  it('writes both the request and the pause for a long-running HITL call', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        longRunningToolIds: ['fc-7'],
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-7',
                name: 'adk_request_confirmation',
                args: {},
              },
            },
          ],
        },
      }),
    });
    await plugin.flush();
    expect(rows().map((row) => row.event_type)).toEqual([
      AnalyticsEventType.HITL_CONFIRMATION_REQUEST,
      AnalyticsEventType.TOOL_PAUSED,
    ]);
    expect(parseColumn(rows()[1].attributes)).toMatchObject({
      adk: {pause_kind: 'hitl_confirmation', function_call_id: 'fc-7'},
    });
  });

  it('still writes a pairable row for a long-running id with no call, and warns', async () => {
    const warnings: string[] = [];
    const restore = captureWarnings(warnings);
    const plugin = makePlugin();
    try {
      await plugin.onEventCallback({
        invocationContext: makeInvocationContext(),
        event: createEvent({
          author: 'root_agent',
          longRunningToolIds: ['orphan-id'],
          content: {role: 'model', parts: [{text: 'working'}]},
        }),
      });
    } finally {
      restore();
    }
    await plugin.flush();
    const paused = rowsOfType(AnalyticsEventType.TOOL_PAUSED);
    expect(paused).toHaveLength(1);
    expect(parseColumn(paused[0].content)).toEqual({tool: null, args: null});
    expect(parseColumn(paused[0].attributes)).toMatchObject({
      adk: {pause_kind: 'tool', function_call_id: 'orphan-id'},
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('long-running tool id');
    expect(warnings[0]).not.toContain('orphan-id');
  });

  it('writes a HITL completion, and no TOOL_COMPLETED, for an answered request event', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc-3',
                name: 'adk_request_credential',
                response: {token: 'granted'},
              },
            },
          ],
        },
      }),
    });
    await plugin.flush();
    const completed = onlyRow();
    expect(completed.event_type).toBe(
      AnalyticsEventType.HITL_CREDENTIAL_REQUEST_COMPLETED,
    );
    expect(parseColumn(completed.content)).toEqual({
      tool: 'adk_request_credential',
      result: {token: '[REDACTED]'},
    });
    expect(parseColumn(completed.attributes)).toMatchObject({
      adk: {pause_kind: 'hitl_credential', function_call_id: 'fc-3'},
    });
  });

  it('leaves an ordinary tool response in an event to afterToolCallback', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc-4',
                name: 'lookup_weather',
                response: {temperature: 20},
              },
            },
          ],
        },
      }),
    });
    await plugin.flush();
    expect(rows()).toHaveLength(0);
  });

  it('completes a HITL request answered in the user message, with no TOOL_COMPLETED', async () => {
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-5',
              name: 'adk_request_confirmation',
              response: {approved: true},
            },
          },
        ],
      },
    });
    await plugin.flush();
    expect(rows().map((row) => row.event_type)).toEqual([
      AnalyticsEventType.USER_MESSAGE_RECEIVED,
      AnalyticsEventType.HITL_CONFIRMATION_REQUEST_COMPLETED,
    ]);
    expect(parseColumn(rows()[1].attributes)).toMatchObject({
      adk: {pause_kind: 'hitl_confirmation', function_call_id: 'fc-5'},
    });
  });

  it('completes a paused tool answered in the user message', async () => {
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {
        role: 'user',
        parts: [
          {text: 'here it is'},
          {
            functionResponse: {
              id: 'fc-6',
              name: 'lookup_weather',
              response: {temperature: 20},
            },
          },
        ],
      },
    });
    await plugin.flush();
    const completed = rowsOfType(AnalyticsEventType.TOOL_COMPLETED);
    expect(completed).toHaveLength(1);
    expect(parseColumn(completed[0].content)).toEqual({
      tool: 'lookup_weather',
      result: {temperature: 20},
    });
    expect(parseColumn(completed[0].attributes)).toMatchObject({
      adk: {pause_kind: 'tool', function_call_id: 'fc-6'},
    });
  });

  it('pairs a pause and its completion on one function call id', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.onEventCallback({
      invocationContext,
      event: createEvent({
        author: 'root_agent',
        longRunningToolIds: ['fc-8'],
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'fc-8', name: 'poll_job', args: {}}}],
        },
      }),
    });
    await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: {
        role: 'user',
        parts: [
          {functionResponse: {id: 'fc-8', name: 'poll_job', response: {}}},
        ],
      },
    });
    await plugin.flush();
    const paused = rowsOfType(AnalyticsEventType.TOOL_PAUSED)[0];
    const completed = rowsOfType(AnalyticsEventType.TOOL_COMPLETED)[0];
    expect(parseColumn(paused.attributes)).toMatchObject({
      adk: {function_call_id: 'fc-8'},
    });
    expect(parseColumn(completed.attributes)).toMatchObject({
      adk: {function_call_id: 'fc-8'},
    });
  });

  it('writes a message with no function response as one row', async () => {
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {role: 'user', parts: [{text: 'weather?'}]},
    });
    await plugin.flush();
    expect(onlyRow().event_type).toBe(AnalyticsEventType.USER_MESSAGE_RECEIVED);
  });

  it('writes null for a framework call that carries no arguments', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'fc-10', name: 'adk_request_input'}}],
        },
      }),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      tool: 'adk_request_input',
      args: null,
    });
  });

  it('writes null for an answered request that carries no payload', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{functionResponse: {id: 'fc-11', name: 'adk_request_input'}}],
        },
      }),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      tool: 'adk_request_input',
      result: null,
    });
  });

  it('writes null for a nameless tool response in the user message', async () => {
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {role: 'user', parts: [{functionResponse: {id: 'fc-12'}}]},
    });
    await plugin.flush();
    const completed = rowsOfType(AnalyticsEventType.TOOL_COMPLETED);
    expect(completed).toHaveLength(1);
    expect(parseColumn(completed[0].content)).toEqual({
      tool: null,
      result: null,
    });
  });

  it('writes one row for a user message that carries no parts', async () => {
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {role: 'user'},
    });
    await plugin.flush();
    expect(onlyRow().event_type).toBe(AnalyticsEventType.USER_MESSAGE_RECEIVED);
  });

  it('declares the two error types adk-js cannot emit, and emits neither', async () => {
    expect(AnalyticsEventType.AGENT_ERROR).toBe('AGENT_ERROR');
    expect(AnalyticsEventType.INVOCATION_ERROR).toBe('INVOCATION_ERROR');
    const plugin = makePlugin();
    await runTurn(plugin, makeInvocationContext());
    await plugin.shutdown();
    expect(rowsOfType(AnalyticsEventType.AGENT_ERROR)).toHaveLength(0);
    expect(rowsOfType(AnalyticsEventType.INVOCATION_ERROR)).toHaveLength(0);
  });

  it('declares the two types adk-js has no source for, and emits neither', async () => {
    expect(AnalyticsEventType.EVENT_COMPACTION).toBe('EVENT_COMPACTION');
    expect(AnalyticsEventType.A2A_INTERACTION).toBe('A2A_INTERACTION');
    const plugin = makePlugin();
    await runTurn(plugin, makeInvocationContext());
    await plugin.shutdown();
    expect(rowsOfType(AnalyticsEventType.EVENT_COMPACTION)).toHaveLength(0);
    expect(rowsOfType(AnalyticsEventType.A2A_INTERACTION)).toHaveLength(0);
  });

  it('writes an AGENT_TRANSFER row naming both agents', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        actions: {transferToAgent: 'billing_agent'},
      }),
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.event_type).toBe(AnalyticsEventType.AGENT_TRANSFER);
    expect(parseColumn(row.content)).toEqual({
      from_agent: 'root_agent',
      to_agent: 'billing_agent',
    });
  });

  it('writes no AGENT_TRANSFER row when the event transfers nothing', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        content: {role: 'model', parts: [{text: 'sunny'}]},
      }),
    });
    await plugin.flush();
    expect(rowsOfType(AnalyticsEventType.AGENT_TRANSFER)).toHaveLength(0);
  });

  it('suppresses a denied pause type and keeps the rest', async () => {
    const plugin = makePlugin({
      eventDenylist: [AnalyticsEventType.TOOL_PAUSED],
    });
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        longRunningToolIds: ['fc-9'],
        content: {
          role: 'model',
          parts: [
            {functionCall: {id: 'fc-9', name: 'adk_request_input', args: {}}},
          ],
        },
      }),
    });
    await plugin.flush();
    expect(rows().map((row) => row.event_type)).toEqual([
      AnalyticsEventType.HITL_INPUT_REQUEST,
    ]);
  });
});

describe('BigQueryAgentAnalyticsPlugin batching and drops', () => {
  it('holds rows until the batch is full, then writes them together', async () => {
    const plugin = makePlugin({batchSize: 5});
    const invocationContext = makeInvocationContext();
    const callbackContext = makeContext(invocationContext);
    await plugin.onUserMessageCallback({
      invocationContext,
      userMessage: {role: 'user', parts: [{text: 'hi'}]},
    });
    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeAgentCallback({agent: makeAgent(), callbackContext});
    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: makeLlmRequest(),
    });
    expect(rows()).toHaveLength(0);
    await plugin.afterModelCallback({
      callbackContext,
      llmResponse: {content: {role: 'model', parts: [{text: 'ok'}]}},
    });
    await plugin.flush();
    expect(rows()).toHaveLength(5);
  });

  it('writes a partial batch once the flush interval elapses', async () => {
    vi.useFakeTimers();
    const plugin = makePlugin({
      batchSize: 10,
      batchFlushIntervalMs: 250,
      flushOnRunEnd: false,
    });
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    expect(rows()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    // Nothing else can write this row: the batch is not full, the run does not
    // flush, and the test never calls flush.
    await vi.waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
  });

  it('leaves rows queued when flushing on run end is off', async () => {
    const plugin = makePlugin({batchSize: 10, flushOnRunEnd: false});
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});
    expect(rows()).toHaveLength(0);
    await plugin.flush();
    expect(rows()).toHaveLength(2);
  });

  it('waits for the in-flight insert before flush resolves', async () => {
    let release = (): void => {};
    fake.insertGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plugin = makePlugin({batchSize: 10, flushOnRunEnd: false});
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    let flushed = false;
    const flushing = plugin.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    release();
    await flushing;
    expect(flushed).toBe(true);
    expect(rows()).toHaveLength(1);
  });

  it('counts and drops rows once the queue is full', async () => {
    const plugin = makePlugin({
      batchSize: 100,
      queueMaxSize: 2,
      flushOnRunEnd: false,
    });
    const invocationContext = makeInvocationContext();
    const callbackContext = makeContext(invocationContext);
    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeAgentCallback({agent: makeAgent(), callbackContext});
    await plugin.beforeToolCallback({
      tool: makeTool(),
      toolArgs: {},
      toolContext: callbackContext,
    });
    await plugin.flush();
    expect(plugin.getDropStats()['queue_full']).toBe(1);
    await plugin.flush();
    expect(rows()).toHaveLength(2);
  });

  it('counts a failed insert without throwing at the callback', async () => {
    fake.insertError = quotaError();
    const plugin = makePlugin();
    await expect(
      plugin.beforeRunCallback({invocationContext: makeInvocationContext()}),
    ).resolves.toBeUndefined();
    await plugin.flush();
    expect(plugin.getDropStats()['non_retryable']).toBe(1);
    expect(rows()).toHaveLength(0);
  });

  it('keeps the drop counters readable after shutdown', async () => {
    fake.insertError = quotaError();
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.shutdown();
    expect(plugin.getDropStats()['non_retryable']).toBe(1);
  });

  it('counts rows still pending when the shutdown timeout expires', async () => {
    vi.useFakeTimers();
    // An insert that never settles: the row leaves the queue but never lands.
    fake.insertGate = new Promise<void>(() => {});
    const plugin = makePlugin({
      batchSize: 1,
      shutdownTimeoutMs: 50,
      flushOnRunEnd: false,
    });
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await vi.waitFor(() => {
      expect(fake.insertCalls).toBe(1);
    });
    const shutting = plugin.shutdown();
    await vi.advanceTimersByTimeAsync(50);
    await shutting;
    expect(plugin.getDropStats()['shutdown_timeout']).toBe(1);
    expect(rows()).toHaveLength(0);
  });

  it('charges an abandoned insert once, even when it later fails', async () => {
    vi.useFakeTimers();
    let release = (): void => {};
    fake.insertGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.insertError = quotaError();
    const plugin = makePlugin({
      batchSize: 1,
      shutdownTimeoutMs: 50,
      flushOnRunEnd: false,
    });
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await vi.waitFor(() => {
      expect(fake.insertCalls).toBe(1);
    });
    const shutting = plugin.shutdown();
    await vi.advanceTimersByTimeAsync(50);
    await shutting;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.getDropStats()['shutdown_timeout']).toBe(1);
    expect(plugin.getDropStats()['non_retryable']).toBe(0);
  });
});

describe('BigQueryAgentAnalyticsPlugin failure containment', () => {
  it('swallows a callback failure and keeps working afterwards', async () => {
    const plugin = makePlugin();
    const broken = new Proxy(makeTool(), {
      get(target, property) {
        if (property === 'name') {
          throw new Error('tool name blew up');
        }
        return Reflect.get(target, property);
      },
    });
    const invocationContext = makeInvocationContext();
    await expect(
      plugin.beforeToolCallback({
        tool: broken,
        toolArgs: {},
        toolContext: makeContext(invocationContext),
      }),
    ).resolves.toBeUndefined();
    await plugin.flush();
    expect(rows()).toHaveLength(0);

    await plugin.beforeRunCallback({invocationContext});
    await plugin.flush();
    expect(rows()).toHaveLength(1);
  });
});

describe('BigQueryAgentAnalyticsPlugin end to end turn', () => {
  it('records an ordered, self-consistent execution tree for one turn', async () => {
    fake.tableExists = true;
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await runTurn(plugin, invocationContext);
    await plugin.shutdown();

    expect(rows().map((row) => row.event_type)).toEqual([
      AnalyticsEventType.USER_MESSAGE_RECEIVED,
      AnalyticsEventType.INVOCATION_STARTING,
      AnalyticsEventType.AGENT_STARTING,
      AnalyticsEventType.LLM_REQUEST,
      AnalyticsEventType.LLM_RESPONSE,
      AnalyticsEventType.TOOL_STARTING,
      AnalyticsEventType.TOOL_COMPLETED,
      AnalyticsEventType.AGENT_COMPLETED,
      AnalyticsEventType.INVOCATION_COMPLETED,
    ]);

    const byType = new Map(rows().map((row) => [row.event_type, row]));
    const invocation = byType.get(AnalyticsEventType.INVOCATION_STARTING);
    const agentStarting = byType.get(AnalyticsEventType.AGENT_STARTING);
    const llmRequest = byType.get(AnalyticsEventType.LLM_REQUEST);
    const toolStarting = byType.get(AnalyticsEventType.TOOL_STARTING);

    expect(new Set(rows().map((row) => row.trace_id)).size).toBe(1);
    expect(invocation?.parent_span_id).toBeNull();
    expect(agentStarting?.parent_span_id).toBe(invocation?.span_id);
    expect(llmRequest?.parent_span_id).toBe(agentStarting?.span_id);
    expect(toolStarting?.parent_span_id).toBe(agentStarting?.span_id);
    expect(byType.get(AnalyticsEventType.LLM_RESPONSE)?.span_id).toBe(
      llmRequest?.span_id,
    );
    expect(byType.get(AnalyticsEventType.TOOL_COMPLETED)?.span_id).toBe(
      toolStarting?.span_id,
    );
    expect(byType.get(AnalyticsEventType.INVOCATION_COMPLETED)?.span_id).toBe(
      invocation?.span_id,
    );
    expect(plugin.getDropStats()).toEqual({
      queue_full: 0,
      retry_exhausted: 0,
      non_retryable: 0,
      unexpected_error: 0,
      shutdown_timeout: 0,
      shutdown_race: 0,
      setup_unavailable: 0,
      formatter_failed: 0,
      content_parse_failed: 0,
    });
  });
});

describe('BigQueryAgentAnalyticsPlugin final response tools', () => {
  it('writes an AGENT_RESPONSE row when a final response tool completes', async () => {
    const plugin = makePlugin({finalResponseToolNames: ['submit_answer']});
    const tool = makeTool('submit_answer');
    await plugin.afterToolCallback({
      tool,
      toolArgs: {answer: 'sunny'},
      toolContext: makeContext(makeInvocationContext()),
      result: {ok: true},
    });
    await plugin.flush();
    const responses = rowsOfType(AnalyticsEventType.AGENT_RESPONSE);
    expect(responses).toHaveLength(1);
    expect(parseColumn(responses[0].content)).toEqual({
      response: {answer: 'sunny'},
    });
    expect(parseColumn(responses[0].attributes)).toMatchObject({
      source_tool: 'submit_answer',
    });
  });

  it('writes only TOOL_COMPLETED for a tool that is not a final response tool', async () => {
    const plugin = makePlugin({finalResponseToolNames: ['submit_answer']});
    await plugin.afterToolCallback({
      tool: makeTool('lookup_weather'),
      toolArgs: {city: 'Paris'},
      toolContext: makeContext(makeInvocationContext()),
      result: {ok: true},
    });
    await plugin.flush();
    expect(onlyRow().event_type).toBe(AnalyticsEventType.TOOL_COMPLETED);
  });

  it('writes only TOOL_COMPLETED when no final response tool is configured', async () => {
    const plugin = makePlugin();
    await plugin.afterToolCallback({
      tool: makeTool('submit_answer'),
      toolArgs: {answer: 'sunny'},
      toolContext: makeContext(makeInvocationContext()),
      result: {ok: true},
    });
    await plugin.flush();
    expect(onlyRow().event_type).toBe(AnalyticsEventType.TOOL_COMPLETED);
  });
});

describe('BigQueryAgentAnalyticsPlugin configuration validation', () => {
  it('refuses a batch size below one', () => {
    expect(() => makePlugin({batchSize: 0})).toThrow(
      'batchSize must be an integer of at least 1, got 0.',
    );
  });

  it('refuses a content limit that is neither positive nor the no-limit value', () => {
    expect(() => makePlugin({maxContentLength: 0})).toThrow(
      'maxContentLength must be an integer of at least 1, or -1 for no ' +
        'limit, got 0.',
    );
  });

  it.each<[string, BigQueryLoggerConfig]>([
    ['batchSize', {batchSize: 1.5}],
    ['queueMaxSize', {queueMaxSize: 2.7}],
  ])('refuses a fractional %s', (key, config) => {
    expect(() => makePlugin(config)).toThrow(
      `${key} must be an integer of at least 1`,
    );
  });

  it.each<[string, BigQueryLoggerConfig]>([
    ['batchFlushIntervalMs', {batchFlushIntervalMs: 10.5}],
    ['shutdownTimeoutMs', {shutdownTimeoutMs: 10.5}],
  ])('accepts a fractional %s, as adk-python does', (_key, config) => {
    expect(() => makePlugin(config)).not.toThrow();
  });

  it('refuses a fractional content limit', () => {
    expect(() => makePlugin({maxContentLength: 1.5})).toThrow(
      'maxContentLength must be an integer of at least 1, or -1 for no ' +
        'limit, got 1.5.',
    );
  });

  it('refuses a shutdown timeout of zero, which would drain nothing', () => {
    expect(() => makePlugin({shutdownTimeoutMs: 0})).toThrow(
      'shutdownTimeoutMs must be a finite number greater than 0, got 0.',
    );
  });
});

describe('BigQueryAgentAnalyticsPlugin workflow nodes', () => {
  it('writes a NODE_OUTPUT row naming the node run and its parent run', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.afterNodeCallback({
      node: new FunctionNode('summarize', () => 'done'),
      nodeContext: new NodeContext({
        invocationContext,
        channel: new AsyncQueue<Event>(),
        nodePath: 'wf/draft@1/summarize@2',
        runId: '2',
      }),
      output: 'done',
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.event_type).toBe(AnalyticsEventType.NODE_OUTPUT);
    expect(parseColumn(row.attributes)).toMatchObject({
      adk: {
        node: {
          path: 'wf/draft@1/summarize@2',
          run_id: '2',
          parent_run_id: '1',
        },
      },
    });
    expect(parseColumn(row.content)).toEqual({
      node: 'summarize',
      output: 'done',
    });
  });

  it('takes a NODE_OUTPUT run id from the context, not from the path', async () => {
    const plugin = makePlugin();
    // A path whose last segment carries no `@runId`: only the context knows
    // which run produced the output.
    await plugin.afterNodeCallback({
      node: new FunctionNode('summarize', () => 'done'),
      nodeContext: new NodeContext({
        invocationContext: makeInvocationContext(),
        channel: new AsyncQueue<Event>(),
        nodePath: 'summarize',
        runId: '2',
      }),
      output: 'done',
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      adk: {node: {path: 'summarize', run_id: '2', parent_run_id: null}},
    });
  });

  it('writes a NODE_ERROR row for a node that failed', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createNodeErrorEvent({
        author: 'root_agent',
        error: Object.assign(new Error('upstream refused'), {code: 'EPERM'}),
        nodeInfo: {path: 'wf/summarize@2'},
      }),
    });
    await plugin.flush();
    const row = onlyRow();
    expect(row.event_type).toBe(AnalyticsEventType.NODE_ERROR);
    expect(row.status).toBe('ERROR');
    expect(row.error_message).toBe('upstream refused');
    expect(parseColumn(row.content)).toEqual({error_code: 'EPERM'});
    expect(parseColumn(row.attributes)).toMatchObject({
      adk: {node: {path: 'wf/summarize@2', run_id: '2'}},
    });
  });

  it('redacts a credential a failing node put in its error message', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createNodeErrorEvent({
        author: 'root_agent',
        error: new Error('refused: api_key=sk-secret-value'),
        nodeInfo: {path: 'wf/summarize@2'},
      }),
    });
    await plugin.flush();
    expect(onlyRow().error_message).toBe('refused: api_key=[REDACTED]');
  });

  it('writes a null error code for a node error event that carries none', async () => {
    const plugin = makePlugin();
    // A node error event rehydrated from a session store can arrive without
    // the code the factory would have set.
    const event = createNodeErrorEvent({
      author: 'root_agent',
      error: new Error('upstream refused'),
      nodeInfo: {path: 'wf/summarize@2'},
    });
    event.errorCode = undefined;
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event,
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({error_code: null});
  });

  it('writes no NODE_ERROR row for an ordinary node event', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        content: {role: 'model', parts: [{text: 'sunny'}]},
        nodeInfo: {path: 'wf/summarize@2'},
      }),
    });
    await plugin.flush();
    expect(rowsOfType(AnalyticsEventType.NODE_ERROR)).toHaveLength(0);
  });

  it('records null run ids for a node path that carries none', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        content: {role: 'model', parts: [{text: 'sunny'}]},
        nodeInfo: {path: 'summarize'},
      }),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      adk: {node: {path: 'summarize', run_id: null, parent_run_id: null}},
    });
  });

  it.each([
    ['wf/summarize@2', 'node_run'],
    ['call-7', 'function_call'],
  ])('classifies the isolation scope %s as %s', async (scope, kind) => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        content: {role: 'model', parts: [{text: 'sunny'}]},
        isolationScope: scope,
      }),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      adk: {scope: {id: scope, kind}},
    });
  });

  it('warns and marks the scope unknown when the event carries an empty one', async () => {
    const warnings: string[] = [];
    const restore = captureWarnings(warnings);
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        content: {role: 'model', parts: [{text: 'sunny'}]},
        isolationScope: '',
      }),
    });
    await plugin.flush();
    restore();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      adk: {scope: {id: '', kind: 'unknown'}},
    });
    expect(warnings.join('\n')).toContain('isolation scope');
  });

  it('carries the route a routing node emitted', async () => {
    const plugin = makePlugin();
    await plugin.onEventCallback({
      invocationContext: makeInvocationContext(),
      event: createEvent({
        author: 'root_agent',
        content: {role: 'model', parts: [{text: 'sunny'}]},
        route: 'escalate',
      }),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      adk: {route: 'escalate'},
    });
  });
});

describe('deriveScope', () => {
  it('marks a scope that storage returned as a non-string unknown', () => {
    expect(deriveScope(42)).toEqual({
      id: '42',
      kind: AnalyticsScopeKind.UNKNOWN,
    });
  });
});

describe('BigQueryAgentAnalyticsPlugin insert failures', () => {
  it('counts every row of the batch when the insert throws a non-object', async () => {
    fake.insertError = 'connection reset';
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    await plugin.flush();
    expect(plugin.getDropStats()['unexpected_error']).toBe(1);
  });

  it('counts only the rejected rows of a partial failure', async () => {
    fake.insertError = Object.assign(new Error('some rows failed'), {
      name: 'PartialFailureError',
      errors: [{row: {}, errors: [{reason: 'invalid'}]}],
    });
    const plugin = makePlugin({batchSize: 5, flushOnRunEnd: false});
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.beforeAgentCallback({
      agent: makeAgent(),
      callbackContext: makeContext(invocationContext),
    });
    await plugin.flush();
    expect(fake.insertCalls).toBe(1);
    expect(plugin.getDropStats()['non_retryable']).toBe(1);
  });

  it('opens the table once across two flushes', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await plugin.flush();
    await plugin.afterRunCallback({invocationContext});
    await plugin.flush();
    expect(rows()).toHaveLength(2);
    expect(fake.created).toHaveLength(1);
  });
});

describe('BigQueryAgentAnalyticsPlugin tool provenance', () => {
  it('writes the origin on a TOOL_COMPLETED row', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.afterToolCallback({
      tool: makeTool(),
      toolArgs: {city: 'Paris'},
      toolContext: makeContext(invocationContext),
      result: {temperature: 20},
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      tool: 'lookup_weather',
      result: {temperature: 20},
      tool_origin: ToolOrigin.LOCAL,
    });
  });

  it('writes the origin on a TOOL_ERROR row', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.onToolErrorCallback({
      tool: makeTool(),
      toolArgs: {city: 'Paris'},
      toolContext: makeContext(invocationContext),
      error: new Error('upstream refused'),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toEqual({
      tool: 'lookup_weather',
      args: {city: 'Paris'},
      tool_origin: ToolOrigin.LOCAL,
    });
  });

  it('resolves a handoff target through the calling agent tree', async () => {
    const remote = new RemoteA2AAgent({
      name: 'billing',
      description: 'Billing, over the A2A protocol.',
      agentCard: 'https://billing.example.test/.well-known/agent-card.json',
    });
    const root = new LlmAgent({
      name: 'root_agent',
      model: 'gemini-2.0-flash',
      subAgents: [remote],
    });
    remote.parentAgent = root;
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext({agent: root});
    await plugin.beforeToolCallback({
      tool: makeTool('transfer_to_agent'),
      toolArgs: {agentName: 'billing'},
      toolContext: makeContext(invocationContext),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toMatchObject({
      tool_origin: ToolOrigin.TRANSFER_A2A,
    });
  });

  it('writes SUB_AGENT for a local agent called as a tool', async () => {
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext();
    await plugin.beforeToolCallback({
      tool: new AgentTool({agent: makeAgent('summarizer')}),
      toolArgs: {request: 'summarize'},
      toolContext: makeContext(invocationContext),
    });
    await plugin.flush();
    expect(parseColumn(onlyRow().content)).toMatchObject({
      tool: 'summarizer',
      tool_origin: ToolOrigin.SUB_AGENT,
    });
  });
});

describe('BigQueryAgentAnalyticsPlugin OpenTelemetry correlation', () => {
  const ambientSpan = trace.wrapSpanContext({
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    traceFlags: TraceFlags.SAMPLED,
  });

  it('captures the ambient span into attributes when it is enabled', async () => {
    const active = vi
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue(ambientSpan);
    const plugin = makePlugin({enableOtelCorrelation: true});
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    active.mockRestore();
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).toMatchObject({
      otel: {
        span_id: 'b7ad6b7169203331',
        trace_id: '0af7651916cd43dd8448eb211c80319c',
      },
    });
  });

  it('writes no otel attribute by default', async () => {
    const active = vi
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue(ambientSpan);
    const plugin = makePlugin();
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    active.mockRestore();
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).not.toHaveProperty('otel');
  });

  it('adopts the ambient trace id on a row written before any span opens', async () => {
    const active = vi
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue(ambientSpan);
    const plugin = makePlugin();
    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {role: 'user', parts: [{text: 'weather?'}]},
    });
    active.mockRestore();
    await plugin.flush();
    expect(onlyRow().trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('falls back to the invocation id for a row written after the run ended', async () => {
    const active = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext({invocationId: 'inv-late'});
    await plugin.beforeRunCallback({invocationContext});
    // afterRunCallback forgets the stack, so a later event has no span to read.
    await plugin.afterRunCallback({invocationContext});
    await plugin.onEventCallback({
      invocationContext,
      event: createEvent({
        author: 'root_agent',
        actions: createEventActions({stateDelta: {step: 'late'}}),
      }),
    });
    active.mockRestore();
    await plugin.flush();
    const late = rowsOfType(AnalyticsEventType.STATE_DELTA);
    expect(late).toHaveLength(1);
    expect(late[0].trace_id).toBe('inv-late');
  });

  it('adopts the ambient trace id for a row written after the run ended', async () => {
    const active = vi
      .spyOn(trace, 'getActiveSpan')
      .mockReturnValue(ambientSpan);
    const plugin = makePlugin();
    const invocationContext = makeInvocationContext({invocationId: 'inv-amb'});
    await plugin.beforeRunCallback({invocationContext});
    await plugin.afterRunCallback({invocationContext});
    await plugin.onEventCallback({
      invocationContext,
      event: createEvent({
        author: 'root_agent',
        actions: createEventActions({stateDelta: {step: 'late'}}),
      }),
    });
    active.mockRestore();
    await plugin.flush();
    const late = rowsOfType(AnalyticsEventType.STATE_DELTA);
    expect(late).toHaveLength(1);
    expect(late[0].trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('writes no otel attribute when no valid span is active', async () => {
    const invalid = trace.wrapSpanContext({
      traceId: '00000000000000000000000000000000',
      spanId: '0000000000000000',
      traceFlags: TraceFlags.NONE,
    });
    const active = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(invalid);
    const plugin = makePlugin({enableOtelCorrelation: true});
    await plugin.beforeRunCallback({
      invocationContext: makeInvocationContext(),
    });
    active.mockRestore();
    await plugin.flush();
    expect(parseColumn(onlyRow().attributes)).not.toHaveProperty('otel');
  });
});

describe('BigQueryAgentAnalyticsPlugin run end flush', () => {
  it('gives up the run-end flush after the shutdown timeout', async () => {
    vi.useFakeTimers();
    // An insert that never settles, so an unbounded flush would hold the run.
    fake.insertGate = new Promise<void>(() => {});
    const plugin = makePlugin({batchSize: 1, shutdownTimeoutMs: 50});
    const invocationContext = makeInvocationContext();
    await plugin.beforeRunCallback({invocationContext});
    await vi.waitFor(() => {
      expect(fake.insertCalls).toBe(1);
    });
    let ended = false;
    const ending = plugin
      .afterRunCallback({invocationContext})
      .then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await ending;
    expect(ended).toBe(true);
  });
});
