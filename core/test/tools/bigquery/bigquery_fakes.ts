/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory doubles for `@google-cloud/bigquery` and `@google-cloud/dataplex`.
 *
 * The reference suite
 * (`tests/unittests/integrations/bigquery/` in adk-python, branch `main`)
 * mocks the clients too. No test here reaches the network.
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';

/** One `createQueryJob` call the fake BigQuery client recorded. */
export interface RecordedQueryJob {
  query: string;
  dryRun?: boolean;
  createSession?: boolean;
  labels?: Record<string, string>;
  connectionProperties?: Array<{key?: string | null; value?: string | null}>;
  maximumBytesBilled?: string;
}

/** How the fake answers one `createQueryJob` call. */
export interface QueryJobReply {
  /** The statement type BigQuery parsed the query as. */
  statementType?: string;
  /** The session a `createSession` dry run opened. */
  sessionId?: string;
  /** The dataset the query would write to. */
  destinationDatasetId?: string;
  /** The rows `getQueryResults` then returns. */
  rows?: Array<Record<string, unknown>>;
  /** Thrown instead of answering. */
  throws?: unknown;
}

/** What one fake BigQuery client was constructed with. */
export interface RecordedClientOptions {
  projectId?: string;
  location?: string;
  userAgent?: string;
  scopes?: string[];
  keyFilename?: string;
  credentials?: unknown;
}

/** What one fake Dataplex client was constructed with. */
export interface RecordedDataplexOptions {
  scopes?: string[];
  keyFilename?: string;
  credentials?: unknown;
  'grpc.primary_user_agent'?: string;
}

/** What the fake clients recorded, and how they answer. */
class FakeBigQueryState {
  /** The options every fake BigQuery client was built with, in order. */
  clientOptions: RecordedClientOptions[] = [];
  /** Every `createQueryJob` call, in order. */
  queryJobs: RecordedQueryJob[] = [];
  /** The replies to `createQueryJob`; the last one repeats. */
  replies: QueryJobReply[] = [];
  /** What `getDatasets` returns. */
  datasetIds: string[] = [];
  /** What `getTables` returns. */
  tableIds: string[] = [];
  /** What `dataset().getMetadata()` returns. */
  datasetMetadata: unknown = {};
  /** What `table().getMetadata()` returns. */
  tableMetadata: unknown = {};
  /** What `job().getMetadata()` returns. */
  jobMetadata: unknown = {};
  /** Thrown by every metadata call when set. */
  metadataError?: unknown;
  /** The dataset ids `dataset()` was asked for, in order. */
  requestedDatasets: string[] = [];
  /** The table ids `table()` was asked for, in order. */
  requestedTables: string[] = [];
  /** The job ids `job()` was asked for, in order. */
  requestedJobs: string[] = [];

  /** The options every fake Dataplex client was built with, in order. */
  dataplexOptions: RecordedDataplexOptions[] = [];
  /** Every `searchEntries` request, in order. */
  searchRequests: unknown[] = [];
  /** What `searchEntries` returns. */
  searchResults: unknown[] = [];
  /** Thrown by `searchEntries` when set. */
  searchError?: unknown;
  /** How many times a Dataplex client was closed. */
  dataplexCloseCount = 0;

  /** Returns the reply for the next `createQueryJob`. */
  nextReply(): QueryJobReply {
    if (this.replies.length === 0) {
      return {statementType: 'SELECT'};
    }
    return this.replies.length === 1
      ? this.replies[0]
      : (this.replies.shift() as QueryJobReply);
  }
}

/** The state the fakes read and record into. */
export let bigQueryState = new FakeBigQueryState();

/** Clears everything the fakes recorded. Call this in `beforeEach`. */
export function resetBigQueryState(): void {
  bigQueryState = new FakeBigQueryState();
}

/** Builds the job resource the fake answers a `createQueryJob` call with. */
function toJobResource(reply: QueryJobReply): Record<string, unknown> {
  return {
    statistics: {
      query: {statementType: reply.statementType},
      sessionInfo: reply.sessionId ? {sessionId: reply.sessionId} : undefined,
    },
    configuration: {
      query: {
        destinationTable: reply.destinationDatasetId
          ? {datasetId: reply.destinationDatasetId}
          : undefined,
      },
    },
  };
}

/** Stands in for `Table`. */
class FakeTable {
  constructor(readonly tableId: string) {}

  async getMetadata(): Promise<[unknown, unknown]> {
    if (bigQueryState.metadataError) {
      throw bigQueryState.metadataError;
    }
    return [bigQueryState.tableMetadata, undefined];
  }
}

/** Stands in for `Dataset`. */
class FakeDataset {
  constructor(readonly datasetId: string) {}

  async getMetadata(): Promise<[unknown, unknown]> {
    if (bigQueryState.metadataError) {
      throw bigQueryState.metadataError;
    }
    return [bigQueryState.datasetMetadata, undefined];
  }

  async getTables(): Promise<[Array<{id: string}>]> {
    if (bigQueryState.metadataError) {
      throw bigQueryState.metadataError;
    }
    return [bigQueryState.tableIds.map((id) => ({id}))];
  }

  table(tableId: string): FakeTable {
    bigQueryState.requestedTables.push(tableId);
    return new FakeTable(tableId);
  }
}

/** Stands in for `Job`. */
class FakeJob {
  constructor(private readonly reply: QueryJobReply) {}

  async getMetadata(): Promise<[unknown, unknown]> {
    if (bigQueryState.metadataError) {
      throw bigQueryState.metadataError;
    }
    return [bigQueryState.jobMetadata, undefined];
  }

  async getQueryResults(options: {
    maxResults?: number;
  }): Promise<[Array<Record<string, unknown>>]> {
    const rows = this.reply.rows ?? [];
    return [
      options.maxResults === undefined
        ? rows
        : rows.slice(0, options.maxResults),
    ];
  }
}

/** Stands in for `BigQuery`. */
export class FakeBigQuery {
  constructor(options: RecordedClientOptions) {
    bigQueryState.clientOptions.push(options);
  }

  async getDatasets(): Promise<[Array<{id: string}>]> {
    if (bigQueryState.metadataError) {
      throw bigQueryState.metadataError;
    }
    return [bigQueryState.datasetIds.map((id) => ({id}))];
  }

  dataset(datasetId: string): FakeDataset {
    bigQueryState.requestedDatasets.push(datasetId);
    return new FakeDataset(datasetId);
  }

  job(jobId: string): FakeJob {
    bigQueryState.requestedJobs.push(jobId);
    return new FakeJob({});
  }

  async createQueryJob(
    options: RecordedQueryJob,
  ): Promise<[FakeJob, Record<string, unknown>]> {
    bigQueryState.queryJobs.push(options);
    const reply = bigQueryState.nextReply();
    if (reply.throws) {
      throw reply.throws;
    }
    return [new FakeJob(reply), toJobResource(reply)];
  }
}

/** Stands in for `CatalogServiceClient`. */
export class FakeCatalogServiceClient {
  constructor(options: RecordedDataplexOptions) {
    bigQueryState.dataplexOptions.push(options);
  }

  async searchEntries(request: unknown): Promise<[unknown[]]> {
    bigQueryState.searchRequests.push(request);
    if (bigQueryState.searchError) {
      throw bigQueryState.searchError;
    }
    return [bigQueryState.searchResults];
  }

  async close(): Promise<void> {
    bigQueryState.dataplexCloseCount++;
  }
}

/**
 * Builds a real tool context, so a tool can read and write the session state
 * the way it does during an agent turn.
 *
 * @param state The session state the context starts with.
 * @return The context.
 */
export function createToolContext(
  state: Record<string, unknown> = {},
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({
        id: 'session-1',
        appName: 'app',
        userId: 'user',
        state,
      }),
      pluginManager: new PluginManager(),
    }),
  });
}
