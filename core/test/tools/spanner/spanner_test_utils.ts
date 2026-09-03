/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A stand-in for `@google-cloud/spanner`.
 *
 * Every Spanner tool test installs it with
 * `vi.mock('@google-cloud/spanner', ...)`, so no test opens a connection.
 * `spannerFake` is the single place a test scripts the responses and reads
 * back what the tools asked for.
 */

import {
  Context,
  createSession,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import {Readable} from 'node:stream';

/** One query a tool sent to the fake database. */
export interface RecordedQuery {
  sql: string;
  params?: Record<string, unknown>;
  types?: Record<string, string>;
  json?: boolean;
  streamed: boolean;
}

/** A canned answer for the queries whose SQL matches `match`. */
export interface ScriptedResponse {
  match: RegExp;
  rows: unknown[];
}

/** What the fake answers with, and what it recorded. */
export interface SpannerFake {
  /** The dialect `getDatabaseDialect` reports. */
  dialect: string;
  /** The canned answers, tried in order. */
  responses: ScriptedResponse[];
  /** Rows returned when no scripted response matches. */
  defaultRows: unknown[];
  /** Thrown instead of answering a query whose SQL matches. */
  failQuery?: {match: RegExp; error: Error};
  /** Thrown by `Database.close()`. */
  failDatabaseClose?: Error;
  /** Thrown by `Spanner.close()`. */
  failClientClose?: Error;
  /** Every query the tools sent, in order. */
  queries: RecordedQuery[];
  /** Every client the tools built, in order. */
  clients: FakeSpanner[];
  /** Every database the tools opened, in order. */
  databases: FakeDatabase[];
}

/** The scripted state shared by the fake and the test that installs it. */
export const spannerFake: SpannerFake = newSpannerFake();

function newSpannerFake(): SpannerFake {
  return {
    dialect: 'GOOGLE_STANDARD_SQL',
    responses: [],
    defaultRows: [],
    // Listed explicitly so `resetSpannerFake` clears a previous test's
    // failure instead of leaving the key in place.
    failQuery: undefined,
    failDatabaseClose: undefined,
    failClientClose: undefined,
    queries: [],
    clients: [],
    databases: [],
  };
}

/** Clears the scripted answers and the recorded calls, for `beforeEach`. */
export function resetSpannerFake(): void {
  Object.assign(spannerFake, newSpannerFake());
}

/** Scripts the rows returned for the queries whose SQL matches `match`. */
export function respondTo(match: RegExp, rows: unknown[]): void {
  spannerFake.responses.push({match, rows});
}

/** Builds a positional row, the shape `Database.run` returns by default. */
export function positionalRow(...values: unknown[]): Array<{
  name: string;
  value: unknown;
}> {
  return values.map((value, index) => ({name: `column_${index}`, value}));
}

function rowsFor(sql: string): unknown[] {
  const scripted = spannerFake.responses.find((response) =>
    response.match.test(sql),
  );
  return scripted ? scripted.rows : spannerFake.defaultRows;
}

function recordAndAnswer(
  query: string | Record<string, unknown>,
  streamed: boolean,
): unknown[] {
  const request = typeof query === 'string' ? {sql: query} : query;
  const sql = String(request['sql']);
  spannerFake.queries.push({
    sql,
    params: request['params'] as Record<string, unknown> | undefined,
    types: request['types'] as Record<string, string> | undefined,
    json: request['json'] as boolean | undefined,
    streamed,
  });
  if (spannerFake.failQuery?.match.test(sql)) {
    throw spannerFake.failQuery.error;
  }
  return rowsFor(sql);
}

/** The subset of `Database` the Spanner tools use. */
export class FakeDatabase {
  closeCount = 0;

  constructor(
    readonly databaseId: string,
    readonly databaseRole?: string | null,
  ) {}

  async getDatabaseDialect(): Promise<string> {
    return spannerFake.dialect;
  }

  async run(
    query: string | Record<string, unknown>,
  ): Promise<[unknown[], unknown, unknown]> {
    return [recordAndAnswer(query, false), {}, {}];
  }

  runStream(query: string | Record<string, unknown>): Readable {
    return Readable.from(recordAndAnswer(query, true));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (spannerFake.failDatabaseClose) {
      throw spannerFake.failDatabaseClose;
    }
  }
}

/** The subset of `Instance` the Spanner tools use. */
export class FakeInstance {
  constructor(readonly instanceId: string) {}

  database(
    databaseId: string,
    _poolOptions?: unknown,
    _queryOptions?: unknown,
    databaseRole?: string | null,
  ): FakeDatabase {
    const database = new FakeDatabase(databaseId, databaseRole);
    spannerFake.databases.push(database);
    return database;
  }
}

/** The subset of `Spanner` the Spanner tools use. */
export class FakeSpanner {
  closeCount = 0;

  constructor(readonly options: Record<string, unknown>) {
    spannerFake.clients.push(this);
  }

  instance(instanceId: string): FakeInstance {
    return new FakeInstance(instanceId);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    if (spannerFake.failClientClose) {
      throw spannerFake.failClientClose;
    }
  }
}

/** The module namespace `vi.mock('@google-cloud/spanner', ...)` installs. */
export function spannerModuleFake(): {Spanner: typeof FakeSpanner} {
  return {Spanner: FakeSpanner};
}

/** Builds a real tool context whose session state the test controls. */
export function createToolContext(
  options: {state?: Record<string, unknown>; functionCallId?: string} = {},
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'spanner-test-invocation',
      session: createSession({
        id: 'spanner-test-session',
        appName: 'spanner-test-app',
        state: options.state ?? {},
      }),
      pluginManager: new PluginManager(),
    }),
    functionCallId: options.functionCallId,
  });
}
