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

/** What the tools did, and how the fake answers them. */
export class FakeSpannerState {
  dialect: string | undefined = 'GOOGLE_STANDARD_SQL';
  responses: QueryResponse[] = [];
  failures: FakeFailures = {};

  readonly clientOptions: Array<Record<string, unknown>> = [];
  readonly databases: RecordedDatabase[] = [];
  readonly queries: RecordedQuery[] = [];
  closedClients = 0;
  closedDatabases = 0;
  endedSnapshots = 0;

  reset(): void {
    this.dialect = 'GOOGLE_STANDARD_SQL';
    this.responses = [];
    this.failures = {};
    this.clientOptions.length = 0;
    this.databases.length = 0;
    this.queries.length = 0;
    this.closedClients = 0;
    this.closedDatabases = 0;
    this.endedSnapshots = 0;
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

class FakeSpanner {
  constructor(options: Record<string, unknown>) {
    spannerFake.clientOptions.push(options);
  }

  instance(instanceId: string): FakeInstance {
    return new FakeInstance(instanceId);
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
