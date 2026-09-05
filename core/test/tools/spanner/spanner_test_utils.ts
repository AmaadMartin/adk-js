/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A double for `@google-cloud/spanner`, shared by the Spanner tool tests.
 * Install it with:
 *
 * ```ts
 * vi.mock('@google-cloud/spanner', async () => {
 *   const {fakeSpannerModule} = await import('./spanner_test_utils.js');
 *   return fakeSpannerModule;
 * });
 * ```
 *
 * The mock factory and the test share this module, so a test reads what the
 * tools did from {@link spannerFake}.
 */

import {
  BaseToolset,
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {SpannerCredentialsConfig} from '@google/adk/tools/spanner';
import {OAuth2Client} from 'google-auth-library';
import {Readable} from 'node:stream';
import {expect} from 'vitest';

/** One row of a result set, as the tools see it. */
export type FakeRow = Array<{name: string; value: unknown}> | FakeJsonRow;

/** One row of a result set the request asked for as `json`. */
export type FakeJsonRow = Record<string, unknown>;

/** A statement the tools ran. */
export interface RecordedQuery {
  sql: string;
  params?: Record<string, unknown>;
  types?: Record<string, string>;
  json?: boolean;
  /** Whether the tool streamed the rows instead of buffering them. */
  streamed: boolean;
}

/** A database handle the tools opened. */
export interface RecordedDatabase {
  instanceId: string;
  databaseId: string;
  databaseRole?: string;
}

/** Rows the fake answers a matching statement with. */
export interface QueryResponse {
  match: string | RegExp;
  rows: FakeRow[];
}

/** Failures a test asks the fake to raise. */
export interface FakeFailures {
  getDatabaseDialect?: Error;
  getSnapshot?: Error;
  run?: Error;
  closeDatabase?: Error;
  closeClient?: Error;
}

/** A call the tools made against an administration endpoint. */
export interface RecordedAdminCall {
  method: string;
  request: Record<string, unknown>;
}

/** A resource-name helper the tools called, and what they passed it. */
export interface RecordedPathCall {
  helper: string;
  args: string[];
}

/** Any resource a listing call pages through. */
export interface FakeNamedResource {
  name?: string | null;
}

/** An instance, as the instance administration endpoint reports it. */
export interface FakeInstanceResponse extends FakeNamedResource {
  displayName?: string | null;
  config?: string | null;
  nodeCount?: number | null;
  processingUnits?: number | null;
  labels?: Record<string, string> | null;
}

/** One replica of an instance config. */
export interface FakeReplicaResponse {
  location?: string | null;
  /** The wire form of a replica type: its number, or its name. */
  type?: number | string | null;
  defaultLeaderLocation?: boolean | null;
}

/** An instance config, as the instance administration endpoint reports it. */
export interface FakeInstanceConfigResponse extends FakeNamedResource {
  displayName?: string | null;
  replicas?: FakeReplicaResponse[] | null;
  labels?: Record<string, string> | null;
}

/** What an administration endpoint answers with. */
export interface FakeAdminResponses {
  instances: FakeNamedResource[];
  instanceConfigs: FakeNamedResource[];
  databases: FakeNamedResource[];
  instance: FakeInstanceResponse;
  instanceConfig: FakeInstanceConfigResponse;
}

/** Failures a test asks an administration endpoint to raise. */
export interface FakeAdminFailures {
  listInstances?: Error;
  getInstance?: Error;
  listInstanceConfigs?: Error;
  getInstanceConfig?: Error;
  createInstance?: Error;
  listDatabases?: Error;
  createDatabase?: Error;
  /** Raised by the long-running operation a create call returned. */
  operation?: Error;
}

/**
 * How the long-running operation a create call returns behaves.
 *
 * `pending` never settles, which is how a test reaches the timeout in
 * `waitForOperation` without waiting for it.
 */
export type FakeOperationOutcome = 'resolve' | 'reject' | 'pending';

/** What an administration endpoint answers before a test configures it. */
function emptyAdminResponses(): FakeAdminResponses {
  return {
    instances: [],
    instanceConfigs: [],
    databases: [],
    instance: {},
    instanceConfig: {},
  };
}

/** What the tools did, and how the fake answers them. */
export class FakeSpannerState {
  dialect: string | undefined = 'GOOGLE_STANDARD_SQL';
  responses: QueryResponse[] = [];
  failures: FakeFailures = {};

  adminFailures: FakeAdminFailures = {};
  adminResponses: FakeAdminResponses = emptyAdminResponses();
  operationOutcome: FakeOperationOutcome = 'resolve';

  readonly clientOptions: Array<Record<string, unknown>> = [];
  readonly databases: RecordedDatabase[] = [];
  readonly queries: RecordedQuery[] = [];
  readonly adminCalls: RecordedAdminCall[] = [];
  readonly pathCalls: RecordedPathCall[] = [];
  closedClients = 0;
  closedDatabases = 0;
  endedSnapshots = 0;

  reset(): void {
    this.dialect = 'GOOGLE_STANDARD_SQL';
    this.responses = [];
    this.failures = {};
    this.adminFailures = {};
    this.adminResponses = emptyAdminResponses();
    this.operationOutcome = 'resolve';
    this.clientOptions.length = 0;
    this.databases.length = 0;
    this.queries.length = 0;
    this.adminCalls.length = 0;
    this.pathCalls.length = 0;
    this.closedClients = 0;
    this.closedDatabases = 0;
    this.endedSnapshots = 0;
  }

  /** The arguments one path helper was called with, in call order. */
  pathArgsFor(helper: string): string[][] {
    return this.pathCalls
      .filter((call) => call.helper === helper)
      .map((call) => call.args);
  }

  /** The requests one administration method received, in call order. */
  requestsFor(method: string): Array<Record<string, unknown>> {
    return this.adminCalls
      .filter((call) => call.method === method)
      .map((call) => call.request);
  }

  /** The rows configured for a statement, or none. */
  rowsFor(sql: string): FakeRow[] {
    const response = this.responses.find(({match}) =>
      typeof match === 'string' ? sql.includes(match) : match.test(sql),
    );
    return response ? response.rows : [];
  }

  /** The last statement the tools ran. */
  lastQuery(): RecordedQuery {
    const query = this.queries.at(-1);
    if (!query) {
      throw new Error('No statement was run.');
    }
    return query;
  }
}

/** The fake every mocked `Spanner` in a test file drives. */
export const spannerFake = new FakeSpannerState();

/** A statement, as `Snapshot.run` and `Snapshot.runStream` receive it. */
interface FakeQuery {
  sql: string;
  params?: Record<string, unknown>;
  types?: Record<string, string>;
  json?: boolean;
}

class FakeSnapshot {
  async run(query: FakeQuery): Promise<[FakeRow[], object, object]> {
    spannerFake.queries.push({...query, streamed: false});
    if (spannerFake.failures.run) {
      throw spannerFake.failures.run;
    }
    return [spannerFake.rowsFor(query.sql), {}, {}];
  }

  runStream(query: FakeQuery): Readable {
    spannerFake.queries.push({...query, streamed: true});
    const {run} = spannerFake.failures;
    const rows = spannerFake.rowsFor(query.sql);
    return Readable.from(
      (async function* () {
        if (run) {
          throw run;
        }
        yield* rows;
      })(),
    );
  }

  end(): void {
    spannerFake.endedSnapshots += 1;
  }
}

class FakeDatabase {
  async getDatabaseDialect(): Promise<string | undefined> {
    if (spannerFake.failures.getDatabaseDialect) {
      throw spannerFake.failures.getDatabaseDialect;
    }
    return spannerFake.dialect;
  }

  async getSnapshot(): Promise<[FakeSnapshot]> {
    if (spannerFake.failures.getSnapshot) {
      throw spannerFake.failures.getSnapshot;
    }
    return [new FakeSnapshot()];
  }

  async close(): Promise<void> {
    spannerFake.closedDatabases += 1;
    if (spannerFake.failures.closeDatabase) {
      throw spannerFake.failures.closeDatabase;
    }
  }
}

class FakeInstance {
  constructor(private readonly instanceId: string) {}

  database(
    databaseId: string,
    poolOptions?: unknown,
    queryOptions?: unknown,
    databaseRole?: string,
  ): FakeDatabase {
    spannerFake.databases.push({
      instanceId: this.instanceId,
      databaseId,
      databaseRole,
    });
    return new FakeDatabase();
  }
}

/** Records one administration call and returns its request unchanged. */
function recordAdminCall(
  method: string,
  request: Record<string, unknown>,
): void {
  spannerFake.adminCalls.push({method, request});
}

/** Records one resource-name helper call and renders the name it returns. */
function recordPath(helper: string, ...args: string[]): void {
  spannerFake.pathCalls.push({helper, args});
}

/**
 * Pages through `resources`, or raises `failure` on the first read.
 *
 * A listing call in the real client returns its iterable straight away and
 * surfaces a rejected request while it is iterated, so the fake does too.
 */
async function* pageThrough<T>(
  failure: Error | undefined,
  resources: T[],
): AsyncIterable<T> {
  if (failure) {
    throw failure;
  }
  yield* resources;
}

/** Raises `failure` when a test configured one. */
function raiseIfConfigured(failure: Error | undefined): void {
  if (failure) {
    throw failure;
  }
}

class FakeOperation {
  promise(): Promise<unknown> {
    recordAdminCall('operation.promise', {});
    switch (spannerFake.operationOutcome) {
      case 'reject':
        return Promise.reject(
          spannerFake.adminFailures.operation ??
            new Error('the operation failed'),
        );
      case 'pending':
        return new Promise(() => {});
      default:
        return Promise.resolve({});
    }
  }
}

class FakeInstanceAdminClient {
  projectPath(project: string): string {
    recordPath('projectPath', project);
    return `projects/${project}`;
  }

  instancePath(project: string, instance: string): string {
    recordPath('instancePath', project, instance);
    return `projects/${project}/instances/${instance}`;
  }

  instanceConfigPath(project: string, config: string): string {
    recordPath('instanceConfigPath', project, config);
    return `projects/${project}/instanceConfigs/${config}`;
  }

  listInstancesAsync(
    request: Record<string, unknown>,
  ): AsyncIterable<FakeNamedResource> {
    recordAdminCall('listInstancesAsync', request);
    return pageThrough(
      spannerFake.adminFailures.listInstances,
      spannerFake.adminResponses.instances,
    );
  }

  async getInstance(
    request: Record<string, unknown>,
  ): Promise<[FakeInstanceResponse]> {
    recordAdminCall('getInstance', request);
    raiseIfConfigured(spannerFake.adminFailures.getInstance);
    return [spannerFake.adminResponses.instance];
  }

  listInstanceConfigsAsync(
    request: Record<string, unknown>,
  ): AsyncIterable<FakeNamedResource> {
    recordAdminCall('listInstanceConfigsAsync', request);
    return pageThrough(
      spannerFake.adminFailures.listInstanceConfigs,
      spannerFake.adminResponses.instanceConfigs,
    );
  }

  async getInstanceConfig(
    request: Record<string, unknown>,
  ): Promise<[FakeInstanceConfigResponse]> {
    recordAdminCall('getInstanceConfig', request);
    raiseIfConfigured(spannerFake.adminFailures.getInstanceConfig);
    return [spannerFake.adminResponses.instanceConfig];
  }

  async createInstance(
    request: Record<string, unknown>,
  ): Promise<[FakeOperation]> {
    recordAdminCall('createInstance', request);
    raiseIfConfigured(spannerFake.adminFailures.createInstance);
    return [new FakeOperation()];
  }
}

class FakeDatabaseAdminClient {
  instancePath(project: string, instance: string): string {
    recordPath('databaseAdmin.instancePath', project, instance);
    return `projects/${project}/instances/${instance}`;
  }

  listDatabasesAsync(
    request: Record<string, unknown>,
  ): AsyncIterable<FakeNamedResource> {
    recordAdminCall('listDatabasesAsync', request);
    return pageThrough(
      spannerFake.adminFailures.listDatabases,
      spannerFake.adminResponses.databases,
    );
  }

  async createDatabase(
    request: Record<string, unknown>,
  ): Promise<[FakeOperation]> {
    recordAdminCall('createDatabase', request);
    raiseIfConfigured(spannerFake.adminFailures.createDatabase);
    return [new FakeOperation()];
  }
}

class FakeSpanner {
  constructor(options: Record<string, unknown>) {
    spannerFake.clientOptions.push(options);
  }

  instance(instanceId: string): FakeInstance {
    return new FakeInstance(instanceId);
  }

  getInstanceAdminClient(): FakeInstanceAdminClient {
    return new FakeInstanceAdminClient();
  }

  getDatabaseAdminClient(): FakeDatabaseAdminClient {
    return new FakeDatabaseAdminClient();
  }

  async close(): Promise<void> {
    spannerFake.closedClients += 1;
    if (spannerFake.failures.closeClient) {
      throw spannerFake.failures.closeClient;
    }
  }
}

/** The module shape `vi.mock('@google-cloud/spanner', ...)` returns. */
export const fakeSpannerModule = {Spanner: FakeSpanner};

/**
 * Builds one row from its column names and values, as the Spanner client
 * yields it. Prefer this over {@link valueRow} whenever the tool reads a
 * column by name, so the fixture carries the same labels the client does.
 */
export function namedRow(fields: Record<string, unknown>): FakeRow {
  return Object.entries(fields).map(([name, value]) => ({name, value}));
}

/** Builds one row out of positional values, as a non-`json` request sees it. */
export function valueRow(...values: unknown[]): FakeRow {
  return values.map((value, index) => ({name: `col${index}`, value}));
}

/** Id of the function call every tool context below answers for. */
export const FUNCTION_CALL_ID = 'fc-1';

/** A tool context backed by an empty session. */
export function makeToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: FUNCTION_CALL_ID});
}

/** An auth client the Spanner client accepts. */
export function testAuthClient(): OAuth2Client {
  return new OAuth2Client();
}

/**
 * Calls one tool of a toolset by name.
 *
 * @param toolset The toolset to take the tool from.
 * @param name The prefixed tool name.
 * @param args The arguments a model would send.
 * @param context The tool context, defaulting to an empty session.
 * @return Whatever the tool answered.
 */
export async function runTool(
  toolset: BaseToolset,
  name: string,
  args: Record<string, unknown> = {},
  context: Context = makeToolContext(),
): Promise<unknown> {
  const tool = (await toolset.getTools()).find((each) => each.name === name);
  if (!tool) {
    return expect.fail(`the toolset exposes no tool named ${name}`);
  }
  return tool.runAsync({args, toolContext: context});
}

/** Narrows an arbitrary value to an indexable record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a tool result that must have succeeded. */
export function successOf(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) {
    return expect.fail(`expected a tool result, got ${String(result)}`);
  }
  expect(result).toMatchObject({status: 'SUCCESS'});
  return result;
}

/** Reads the message of a tool result that must have failed. */
export function errorOf(result: unknown): string {
  if (!isRecord(result)) {
    return expect.fail(`expected a tool result, got ${String(result)}`);
  }
  expect(result.status).toBe('ERROR');
  const details = result['error_details'];
  if (typeof details !== 'string') {
    return expect.fail(`expected error_details, got ${String(details)}`);
  }
  return details;
}

/** The simplest valid credentials config: one identity for every user. */
export function testCredentialsConfig(): SpannerCredentialsConfig {
  return {authClient: testAuthClient()};
}
