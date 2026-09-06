/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stand-ins for `@google-cloud/bigquery` and `@google-cloud/dataplex`.
 *
 * The tests install them with `vi.mock` and reach them through the toolset, so
 * the clients the tools receive are typed by the real SDK declarations while
 * the calls land here.
 */

import type {JobMetadata, Query} from '@google-cloud/bigquery';

/** Fixtures the fake BigQuery client answers with. */
export interface FakeBigQueryData {
  /** An `undefined` entry stands for a resource the API did not name. */
  datasetIds?: Array<string | undefined>;
  datasetMetadata?: unknown;
  tableIds?: Array<string | undefined>;
  tableMetadata?: unknown;
  jobMetadata?: unknown;
  /** One entry per `createQueryJob` call. The last entry repeats. */
  plannedJobs?: JobMetadata[];
  /** The rows `query` answers with. */
  rows?: unknown[];
  /** Thrown by the operation it is keyed under, instead of answering. */
  errors?: {
    getDatasets?: Error;
    getDatasetMetadata?: Error;
    getTables?: Error;
    getTableMetadata?: Error;
    getJobMetadata?: Error;
    createQueryJob?: Error;
    query?: Error;
  };
}

/**
 * Records what the tools asked the fake BigQuery client for.
 *
 * A call is recorded before a configured error is raised, so the log shows
 * what was attempted rather than only what succeeded.
 */
export interface FakeBigQueryCalls {
  constructed: Array<Record<string, unknown>>;
  datasets: Array<{datasetId: string; projectId?: string}>;
  tables: string[];
  jobs: string[];
  queryJobs: Query[];
  queries: Query[];
}

/** Fixtures the fake Dataplex client answers with. */
export interface FakeDataplexData {
  searchResults?: unknown[];
  searchError?: Error;
}

/** Records what the tools asked the fake Dataplex client for. */
export interface FakeDataplexCalls {
  constructed: Array<Record<string, unknown>>;
  searches: Array<Record<string, unknown>>;
  closed: number;
}

interface FakeState {
  bigquery: {data: FakeBigQueryData; calls: FakeBigQueryCalls};
  dataplex: {data: FakeDataplexData; calls: FakeDataplexCalls};
}

function newBigQueryCalls(): FakeBigQueryCalls {
  return {
    constructed: [],
    datasets: [],
    tables: [],
    jobs: [],
    queryJobs: [],
    queries: [],
  };
}

function newDataplexCalls(): FakeDataplexCalls {
  return {constructed: [], searches: [], closed: 0};
}

/** The fixtures and the call log the next fake clients are built with. */
export const fakeState: FakeState = {
  bigquery: {data: {}, calls: newBigQueryCalls()},
  dataplex: {data: {}, calls: newDataplexCalls()},
};

/** Clears the fixtures and the call log between tests. */
export function resetFakes(
  bigquery: FakeBigQueryData = {},
  dataplex: FakeDataplexData = {},
): void {
  fakeState.bigquery = {data: bigquery, calls: newBigQueryCalls()};
  fakeState.dataplex = {data: dataplex, calls: newDataplexCalls()};
}

/** Throws `error` when the fixtures named one for this operation. */
function raiseIfConfigured(error: Error | undefined): void {
  if (error) {
    throw error;
  }
}

class FakeTable {
  constructor(readonly id?: string) {}

  async getMetadata(): Promise<[unknown]> {
    const {data} = fakeState.bigquery;
    raiseIfConfigured(data.errors?.getTableMetadata);
    return [data.tableMetadata];
  }
}

class FakeDataset {
  constructor(readonly id?: string) {}

  async getMetadata(): Promise<[unknown]> {
    const {data} = fakeState.bigquery;
    raiseIfConfigured(data.errors?.getDatasetMetadata);
    return [data.datasetMetadata];
  }

  async getTables(): Promise<[FakeTable[]]> {
    const {data} = fakeState.bigquery;
    raiseIfConfigured(data.errors?.getTables);
    return [(data.tableIds ?? []).map((id) => new FakeTable(id))];
  }

  table(id: string): FakeTable {
    fakeState.bigquery.calls.tables.push(id);
    return new FakeTable(id);
  }
}

class FakeJob {
  constructor(readonly metadata: unknown) {}

  async getMetadata(): Promise<[unknown]> {
    raiseIfConfigured(fakeState.bigquery.data.errors?.getJobMetadata);
    return [this.metadata];
  }
}

/** The fake `BigQuery` class `vi.mock` installs. */
export class FakeBigQuery {
  constructor(options: Record<string, unknown>) {
    fakeState.bigquery.calls.constructed.push(options);
  }

  async getDatasets(options: {projectId?: string}): Promise<[FakeDataset[]]> {
    const {data} = fakeState.bigquery;
    fakeState.bigquery.calls.datasets.push({
      datasetId: '',
      projectId: options.projectId,
    });
    raiseIfConfigured(data.errors?.getDatasets);
    return [(data.datasetIds ?? []).map((id) => new FakeDataset(id))];
  }

  dataset(datasetId: string, options?: {projectId?: string}): FakeDataset {
    fakeState.bigquery.calls.datasets.push({
      datasetId,
      projectId: options?.projectId,
    });
    return new FakeDataset(datasetId);
  }

  job(jobId: string): FakeJob {
    fakeState.bigquery.calls.jobs.push(jobId);
    return new FakeJob(fakeState.bigquery.data.jobMetadata);
  }

  async createQueryJob(request: Query): Promise<[FakeJob]> {
    const {data, calls} = fakeState.bigquery;
    const planned = data.plannedJobs ?? [];
    const index = Math.min(calls.queryJobs.length, planned.length - 1);
    calls.queryJobs.push(request);
    raiseIfConfigured(data.errors?.createQueryJob);
    return [new FakeJob(planned[index] ?? {})];
  }

  async query(request: Query): Promise<[unknown[], unknown]> {
    const {data, calls} = fakeState.bigquery;
    calls.queries.push(request);
    raiseIfConfigured(data.errors?.query);
    return [data.rows ?? [], {}];
  }
}

/** The fake `CatalogServiceClient` class `vi.mock` installs. */
export class FakeCatalogServiceClient {
  constructor(options: Record<string, unknown>) {
    fakeState.dataplex.calls.constructed.push(options);
  }

  async searchEntries(
    request: Record<string, unknown>,
  ): Promise<[unknown[], unknown, unknown]> {
    const {data, calls} = fakeState.dataplex;
    calls.searches.push(request);
    raiseIfConfigured(data.searchError);
    return [data.searchResults ?? [], null, {}];
  }

  async close(): Promise<void> {
    fakeState.dataplex.calls.closed += 1;
  }
}

/** A planned job BigQuery would report for a statement of `statementType`. */
export function plannedJob(
  statementType: string,
  extra: {destinationDatasetId?: string; sessionId?: string} = {},
): JobMetadata {
  return {
    statistics: {
      query: {statementType},
      ...(extra.sessionId
        ? {sessionInfo: {sessionId: extra.sessionId}}
        : undefined),
    },
    configuration: {
      query: {
        query: '',
        ...(extra.destinationDatasetId
          ? {destinationTable: {datasetId: extra.destinationDatasetId}}
          : undefined),
      },
    },
  };
}
