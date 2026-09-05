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
  ToolConfirmation,
  createSession,
} from '@google/adk';
import {SpannerCredentialsConfig} from '@google/adk/tools/spanner';
import {OAuth2Client} from 'google-auth-library';
import {expect} from 'vitest';

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

/** Failures a test asks the fake to raise. */
export interface FakeFailures {
  listInstances?: Error;
  getInstance?: Error;
  listInstanceConfigs?: Error;
  getInstanceConfig?: Error;
  createInstance?: Error;
  listDatabases?: Error;
  createDatabase?: Error;
  /** Raised by the long-running operation a create call returned. */
  operation?: Error;
  /** Raised when the tools close the client. */
  closeClient?: Error;
  /** Raised when the tools cancel a timed-out operation. */
  cancelOperation?: Error;
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
  failures: FakeFailures = {};
  responses: FakeAdminResponses = emptyAdminResponses();
  operationOutcome: FakeOperationOutcome = 'resolve';

  readonly clientOptions: Array<Record<string, unknown>> = [];
  readonly adminCalls: RecordedAdminCall[] = [];
  readonly pathCalls: RecordedPathCall[] = [];
  closedClients = 0;
  cancelledOperations = 0;

  reset(): void {
    this.failures = {};
    this.responses = emptyAdminResponses();
    this.operationOutcome = 'resolve';
    this.clientOptions.length = 0;
    this.adminCalls.length = 0;
    this.pathCalls.length = 0;
    this.closedClients = 0;
    this.cancelledOperations = 0;
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
}

/** The fake every mocked `Spanner` in a test file drives. */
export const spannerFake = new FakeSpannerState();

/** Records one administration call. */
function recordAdminCall(
  method: string,
  request: Record<string, unknown>,
): void {
  spannerFake.adminCalls.push({method, request});
}

/** Records one resource-name helper call. */
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
          spannerFake.failures.operation ?? new Error('the operation failed'),
        );
      case 'pending':
        return new Promise(() => {});
      default:
        return Promise.resolve({});
    }
  }

  async cancel(): Promise<unknown> {
    spannerFake.cancelledOperations += 1;
    raiseIfConfigured(spannerFake.failures.cancelOperation);
    return {};
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
      spannerFake.failures.listInstances,
      spannerFake.responses.instances,
    );
  }

  async getInstance(
    request: Record<string, unknown>,
  ): Promise<[FakeInstanceResponse]> {
    recordAdminCall('getInstance', request);
    raiseIfConfigured(spannerFake.failures.getInstance);
    return [spannerFake.responses.instance];
  }

  listInstanceConfigsAsync(
    request: Record<string, unknown>,
  ): AsyncIterable<FakeNamedResource> {
    recordAdminCall('listInstanceConfigsAsync', request);
    return pageThrough(
      spannerFake.failures.listInstanceConfigs,
      spannerFake.responses.instanceConfigs,
    );
  }

  async getInstanceConfig(
    request: Record<string, unknown>,
  ): Promise<[FakeInstanceConfigResponse]> {
    recordAdminCall('getInstanceConfig', request);
    raiseIfConfigured(spannerFake.failures.getInstanceConfig);
    return [spannerFake.responses.instanceConfig];
  }

  async createInstance(
    request: Record<string, unknown>,
  ): Promise<[FakeOperation]> {
    recordAdminCall('createInstance', request);
    raiseIfConfigured(spannerFake.failures.createInstance);
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
      spannerFake.failures.listDatabases,
      spannerFake.responses.databases,
    );
  }

  async createDatabase(
    request: Record<string, unknown>,
  ): Promise<[FakeOperation]> {
    recordAdminCall('createDatabase', request);
    raiseIfConfigured(spannerFake.failures.createDatabase);
    return [new FakeOperation()];
  }
}

class FakeSpanner {
  constructor(options: Record<string, unknown>) {
    spannerFake.clientOptions.push(options);
  }

  getInstanceAdminClient(): FakeInstanceAdminClient {
    return new FakeInstanceAdminClient();
  }

  getDatabaseAdminClient(): FakeDatabaseAdminClient {
    return new FakeDatabaseAdminClient();
  }

  async close(): Promise<void> {
    spannerFake.closedClients += 1;
    raiseIfConfigured(spannerFake.failures.closeClient);
  }
}

/** The module shape `vi.mock('@google-cloud/spanner', ...)` returns. */
export const fakeSpannerModule = {Spanner: FakeSpanner};

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

/**
 * A tool context carrying the user's answer to a confirmation request, which
 * is what a gated tool needs before it runs its body.
 */
export function confirmedToolContext(confirmed = true): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({
    invocationContext,
    functionCallId: FUNCTION_CALL_ID,
    toolConfirmation: new ToolConfirmation({confirmed}),
  });
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
