/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {TableField, TableMetadata} from '@google-cloud/bigquery';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {
  AnalyticsRetryConfig,
  ResolvedAnalyticsRetryConfig,
} from '../../src/plugins/bigquery_analytics_config.js';
import {resolvePluginOptions} from '../../src/plugins/bigquery_analytics_config.js';
import {
  AnalyticsEventType,
  AnalyticsRow,
  AnalyticsStatus,
  EVENTS_TABLE_SCHEMA,
  SCHEMA_VERSION,
  SCHEMA_VERSION_LABEL_KEY,
} from '../../src/plugins/bigquery_analytics_schema.js';
import {EVENT_VIEW_DEFS} from '../../src/plugins/bigquery_analytics_views.js';
import {
  AnalyticsDropReason,
  BigQueryRowWriter,
  retryDelayMs,
} from '../../src/plugins/bigquery_analytics_writer.js';
import type {Logger} from '../../src/utils/logger.js';
import {setLogger} from '../../src/utils/logger.js';

const {BigQueryMock, storageMock, fake} = vi.hoisted(() => {
  /** A status the service reports on an append it resolved rather than threw. */
  interface AppendStatus {
    code: number;
    message: string;
    rowErrors: unknown[];
  }

  interface FakeBigQuery {
    clientOptions: unknown[];
    streamOptions: unknown[];
    appendCalls: Array<Array<Partial<AnalyticsRow>>>;
    appendErrors: unknown[];
    appendStatuses: Array<AppendStatus | undefined>;
    streamsClosed: number;
    descriptorScopes: string[];
    streamViews: unknown[];
    streamIds: string[];
    created: Array<{tableId: string; metadata: TableMetadata}>;
    metadataReads: number;
    metadataUpdates: TableMetadata[];
    liveSchema: TableField[];
    liveLabels: Record<string, string>;
    tableExists: boolean;
    createError?: Error;
    appendHold?: Promise<void>;
    streamSchema: unknown;
    queries: string[];
    queryError?: Error;
  }

  const fake: FakeBigQuery = {
    clientOptions: [],
    streamOptions: [],
    appendCalls: [],
    appendErrors: [],
    appendStatuses: [],
    streamsClosed: 0,
    descriptorScopes: [],
    streamViews: [],
    streamIds: [],
    created: [],
    metadataReads: 0,
    metadataUpdates: [],
    liveSchema: [],
    liveLabels: {},
    tableExists: true,
    queries: [],
    streamSchema: {fields: []},
  };

  class FakeTable {
    constructor(readonly id: string) {}

    async exists(): Promise<[boolean]> {
      return [fake.tableExists];
    }

    async get(): Promise<[FakeTable]> {
      return [this];
    }

    async getMetadata(): Promise<[TableMetadata]> {
      fake.metadataReads += 1;
      return [
        {schema: {fields: fake.liveSchema}, labels: {...fake.liveLabels}},
      ];
    }

    async setMetadata(metadata: TableMetadata): Promise<[TableMetadata]> {
      fake.metadataUpdates.push(metadata);
      return [metadata];
    }
  }

  class FakeDataset {
    async exists(): Promise<[boolean]> {
      return [true];
    }

    table(id: string): FakeTable {
      return new FakeTable(id);
    }

    async createTable(
      tableId: string,
      metadata: TableMetadata,
    ): Promise<[FakeTable]> {
      fake.created.push({tableId, metadata});
      if (fake.createError !== undefined) {
        throw fake.createError;
      }
      return [new FakeTable(tableId)];
    }
  }

  class BigQueryMock {
    constructor(clientOptions: unknown) {
      fake.clientOptions.push(clientOptions);
    }

    dataset(): FakeDataset {
      return new FakeDataset();
    }

    async query(sql: string): Promise<[unknown[]]> {
      fake.queries.push(sql);
      if (fake.queryError !== undefined) {
        throw fake.queryError;
      }
      return [[]];
    }
  }

  class FakeStreamConnection {
    close(): void {
      fake.streamsClosed += 1;
    }
  }

  class FakeJSONWriter {
    appendRows(rows: Array<Partial<AnalyticsRow>>): {
      getResult: () => Promise<{error?: unknown; rowErrors?: unknown[]}>;
    } {
      fake.appendCalls.push(rows);
      // One entry per attempt, so a test can fail the first N and succeed after.
      const thrown = fake.appendErrors.shift();
      const status = fake.appendStatuses.shift();
      const hold = fake.appendHold;
      return {
        getResult: async () => {
          if (hold !== undefined) {
            await hold;
          }
          if (thrown !== undefined) {
            throw thrown;
          }
          if (status !== undefined) {
            return {
              error: {code: status.code, message: status.message},
              rowErrors: status.rowErrors,
            };
          }
          return {};
        },
      };
    }

    close(): void {
      fake.streamsClosed += 1;
    }
  }

  class FakeWriterClient {
    constructor(clientOptions: unknown) {
      fake.streamOptions.push(clientOptions);
    }

    async getWriteStream(request: {
      streamId: string;
      view?: unknown;
    }): Promise<{tableSchema: unknown}> {
      fake.streamIds.push(request.streamId);
      fake.streamViews.push(request.view);
      return {tableSchema: fake.streamSchema};
    }

    async createStreamConnection(): Promise<FakeStreamConnection> {
      return new FakeStreamConnection();
    }

    close(): void {
      fake.streamsClosed += 1;
    }
  }

  const storageMock = {
    managedwriter: {
      WriterClient: FakeWriterClient,
      JSONWriter: FakeJSONWriter,
      DefaultStream: 'DEFAULT',
    },
    adapt: {
      convertStorageSchemaToProto2Descriptor: (
        _schema: unknown,
        scope: string,
      ) => {
        fake.descriptorScopes.push(scope);
        return {name: scope};
      },
    },
    protos: {
      google: {
        cloud: {bigquery: {storage: {v1: {WriteStreamView: {FULL: 2}}}}},
      },
    },
  };

  return {BigQueryMock, storageMock, fake};
});

vi.mock('@google-cloud/bigquery', () => ({BigQuery: BigQueryMock}));
vi.mock('@google-cloud/bigquery-storage', () => storageMock);

/** The backoff one retry test waits out, kept short so the suite stays fast. */
const BACKOFF_MS = 50;

/** An error carrying a gRPC status, as the append client reports one. */
function statusError(code: number, message = 'bigquery said no'): Error {
  return Object.assign(new Error(message), {code});
}

/** A resolved append status naming `rejected` rows of a larger batch. */
function rowErrorStatus(rejected: number): {
  code: number;
  message: string;
  rowErrors: unknown[];
} {
  return {
    code: 3,
    message: 'some rows failed',
    rowErrors: Array.from({length: rejected}, (_unused, index) => ({
      index,
      code: 'FIELDS_ERROR',
    })),
  };
}

/** Redirects `logger.error` into `sink` until the returned function is called. */
function captureErrors(sink: string[]): () => void {
  const capturing: Logger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => {
      sink.push(args.map((arg) => String(arg)).join(' '));
    },
  };
  setLogger(capturing);
  return () => setLogger(null);
}

/** One well-formed row, distinguished by `id`. */
function makeRow(id: string): AnalyticsRow {
  return {
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    event_id: id,
    event_type: AnalyticsEventType.LLM_REQUEST,
    agent: 'agent',
    session_id: 's1',
    invocation_id: 'i1',
    user_id: 'u1',
    trace_id: 't1',
    span_id: 'sp1',
    parent_span_id: null,
    content: '{"a":1}',
    content_parts: [],
    attributes: '{}',
    latency_ms: null,
    status: AnalyticsStatus.OK,
    error_message: null,
    is_truncated: false,
  };
}

/**
 * A writer built from the public option resolver, so a test exercises the same
 * defaults a caller gets.
 */
function makeWriter(options?: {
  retryConfig?: AnalyticsRetryConfig;
  autoSchemaUpgrade?: boolean;
  payloadColumnDenylist?: string[];
  batchSize?: number;
  createViews?: boolean;
  viewPrefix?: string;
}): BigQueryRowWriter {
  const resolved = resolvePluginOptions({
    projectId: 'test-project',
    datasetId: 'agent_analytics',
    config: {
      // An immediate retry keeps the test off the clock while still walking
      // every attempt.
      retryConfig: {
        maxRetries: 2,
        initialDelayMs: 0,
        multiplier: 1,
        maxDelayMs: 0,
      },
      ...options,
    },
  });
  return new BigQueryRowWriter(resolved.writer);
}

/** Queues one row and waits for the insert, and any retry, to settle. */
async function writeOneRow(writer: BigQueryRowWriter): Promise<void> {
  writer.enqueue(makeRow('e1'));
  await writer.flush();
}

beforeEach(() => {
  fake.clientOptions = [];
  fake.streamOptions = [];
  fake.appendCalls = [];
  fake.appendErrors = [];
  fake.appendStatuses = [];
  fake.streamsClosed = 0;
  fake.descriptorScopes = [];
  fake.streamViews = [];
  fake.streamIds = [];
  fake.created = [];
  fake.metadataReads = 0;
  fake.metadataUpdates = [];
  fake.liveSchema = EVENTS_TABLE_SCHEMA;
  fake.liveLabels = {[SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION};
  fake.tableExists = true;
  fake.createError = undefined;
  fake.appendHold = undefined;
  fake.streamSchema = {fields: []};
  fake.queries = [];
  fake.queryError = undefined;
});

describe('retryDelayMs', () => {
  const retry: ResolvedAnalyticsRetryConfig = {
    maxRetries: 5,
    initialDelayMs: 1000,
    multiplier: 2,
    maxDelayMs: 10000,
  };

  it('grows by the multiplier on each attempt', () => {
    expect(retryDelayMs(retry, 0)).toBe(1000);
    expect(retryDelayMs(retry, 1)).toBe(2000);
    expect(retryDelayMs(retry, 2)).toBe(4000);
  });

  it('never waits longer than maxDelayMs', () => {
    expect(retryDelayMs(retry, 3)).toBe(8000);
    expect(retryDelayMs(retry, 4)).toBe(10000);
    expect(retryDelayMs(retry, 40)).toBe(10000);
  });

  it('waits nothing when every delay is zero', () => {
    expect(
      retryDelayMs(
        {maxRetries: 3, initialDelayMs: 0, multiplier: 2, maxDelayMs: 0},
        2,
      ),
    ).toBe(0);
  });
});

describe('BigQueryRowWriter insert retry', () => {
  it('writes the batch once when the insert succeeds', async () => {
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(1);
    expect(writer.getDropStats()[AnalyticsDropReason.RETRY_EXHAUSTED]).toBe(0);
  });

  it.each([4, 8, 13, 14])(
    'retries gRPC status %i and keeps the row',
    async (code) => {
      fake.appendErrors = [statusError(code)];
      const writer = makeWriter();
      await writeOneRow(writer);
      expect(fake.appendCalls).toHaveLength(2);
      expect(fake.appendCalls[1][0].event_id).toBe('e1');
      expect(writer.getDropStats()[AnalyticsDropReason.RETRY_EXHAUSTED]).toBe(
        0,
      );
    },
  );

  it('gives up after maxRetries and counts retry_exhausted', async () => {
    fake.appendErrors = [14, 14, 14, 14].map((code) => statusError(code));
    const writer = makeWriter();
    await writeOneRow(writer);
    // One first attempt plus the two retries the config allows.
    expect(fake.appendCalls).toHaveLength(3);
    expect(writer.getDropStats()[AnalyticsDropReason.RETRY_EXHAUSTED]).toBe(1);
  });

  it('attempts once and gives up when maxRetries is zero', async () => {
    fake.appendErrors = [statusError(14), statusError(14)];
    const writer = makeWriter({
      retryConfig: {maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0},
    });
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(1);
    expect(writer.getDropStats()[AnalyticsDropReason.RETRY_EXHAUSTED]).toBe(1);
  });

  it('charges every row of the batch when the retries run out', async () => {
    fake.appendErrors = [14, 14, 14].map((code) => statusError(code));
    const writer = makeWriter({batchSize: 3});
    writer.enqueue(makeRow('e1'));
    writer.enqueue(makeRow('e2'));
    writer.enqueue(makeRow('e3'));
    await writer.flush();
    expect(writer.getDropStats()[AnalyticsDropReason.RETRY_EXHAUSTED]).toBe(3);
  });

  it('waits out the configured backoff before it retries', async () => {
    fake.appendErrors = [statusError(14)];
    const writer = makeWriter({
      retryConfig: {
        maxRetries: 1,
        initialDelayMs: BACKOFF_MS,
        multiplier: 2,
        maxDelayMs: 1000,
      },
    });
    const startedAt = Date.now();
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(2);
    // A timer never fires early, so the elapsed time is a sound lower bound.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(BACKOFF_MS - 1);
  });
});

describe('BigQueryRowWriter append failure classification', () => {
  it.each([3, 7, 5, 6])(
    'counts gRPC status %i as non_retryable and does not retry',
    async (code) => {
      fake.appendErrors = [statusError(code)];
      const writer = makeWriter();
      await writeOneRow(writer);
      expect(fake.appendCalls).toHaveLength(1);
      expect(writer.getDropStats()[AnalyticsDropReason.NON_RETRYABLE]).toBe(1);
    },
  );

  it('counts a schema mismatch as non_retryable', async () => {
    fake.appendErrors = [statusError(3, 'Schema mismatch for field content')];
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(1);
    expect(writer.getDropStats()[AnalyticsDropReason.NON_RETRYABLE]).toBe(1);
  });

  it('counts only the rejected rows of a partial failure', async () => {
    fake.appendStatuses = [rowErrorStatus(2)];
    const writer = makeWriter({batchSize: 5});
    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) {
      writer.enqueue(makeRow(id));
    }
    await writer.flush();
    expect(fake.appendCalls).toHaveLength(1);
    expect(writer.getDropStats()[AnalyticsDropReason.NON_RETRYABLE]).toBe(2);
  });

  it.each([
    ['a string', 'connection reset'],
    ['an error with no status', new Error('boom')],
    [
      'an error with a non-numeric status',
      Object.assign(new Error('x'), {code: 'ECONNRESET'}),
    ],
  ])('counts %s as unexpected_error', async (_label, failure) => {
    fake.appendErrors = [failure];
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(1);
    expect(writer.getDropStats()[AnalyticsDropReason.UNEXPECTED_ERROR]).toBe(1);
  });

  it('never throws at the caller, whatever the insert does', async () => {
    fake.appendErrors = [statusError(400)];
    const writer = makeWriter();
    await expect(writeOneRow(writer)).resolves.toBeUndefined();
  });
});

describe('BigQueryRowWriter credentials', () => {
  it('passes the caller credentials to the client', async () => {
    const credentials = {client_email: 'agent@example.com', private_key: 'k'};
    const resolved = resolvePluginOptions({
      projectId: 'test-project',
      datasetId: 'agent_analytics',
      credentials,
    });
    await writeOneRow(new BigQueryRowWriter(resolved.writer));
    expect(fake.clientOptions[0]).toMatchObject({credentials});
  });

  it('leaves the client on application default credentials by default', async () => {
    await writeOneRow(makeWriter());
    expect(fake.clientOptions[0]).toMatchObject({credentials: undefined});
  });

  it('turns the client automatic retry off, so retryConfig is the only policy', async () => {
    await writeOneRow(makeWriter());
    expect(fake.clientOptions[0]).toMatchObject({
      retryOptions: {autoRetry: false},
    });
  });
});

describe('BigQueryRowWriter schema upgrade', () => {
  it('leaves a current table alone', async () => {
    await writeOneRow(makeWriter());
    expect(fake.metadataReads).toBe(1);
    expect(fake.metadataUpdates).toEqual([]);
  });

  it('adds the columns an older table is missing', async () => {
    fake.liveSchema = EVENTS_TABLE_SCHEMA.slice(0, -2);
    fake.liveLabels = {[SCHEMA_VERSION_LABEL_KEY]: '1'};
    await writeOneRow(makeWriter());
    expect(fake.metadataUpdates).toHaveLength(1);
    const fields = fake.metadataUpdates[0].schema;
    expect(Array.isArray(fields)).toBe(false);
    expect(fake.metadataUpdates[0].labels).toEqual({
      [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION,
    });
  });

  it('adds a missing column even when the version label is current', async () => {
    fake.liveSchema = EVENTS_TABLE_SCHEMA.slice(0, -1);
    await writeOneRow(makeWriter());
    expect(fake.metadataUpdates).toHaveLength(1);
  });

  it('refreshes a stale version label on a table with every column', async () => {
    fake.liveLabels = {[SCHEMA_VERSION_LABEL_KEY]: '1'};
    await writeOneRow(makeWriter());
    expect(fake.metadataUpdates).toHaveLength(1);
    expect(fake.metadataUpdates[0].labels).toEqual({
      [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION,
    });
  });

  it('keeps the other labels a table already carries', async () => {
    fake.liveLabels = {owner: 'platform'};
    await writeOneRow(makeWriter());
    expect(fake.metadataUpdates[0].labels).toEqual({
      owner: 'platform',
      [SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION,
    });
  });

  it('reads no metadata at all when the upgrade is turned off', async () => {
    fake.liveSchema = [];
    await writeOneRow(makeWriter({autoSchemaUpgrade: false}));
    expect(fake.metadataReads).toBe(0);
    expect(fake.metadataUpdates).toEqual([]);
  });

  it('counts an incompatible live column as a setup failure', async () => {
    fake.liveSchema = [{name: 'content', type: 'STRING', mode: 'NULLABLE'}];
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.appendCalls).toEqual([]);
    expect(writer.getDropStats()[AnalyticsDropReason.SETUP_UNAVAILABLE]).toBe(
      1,
    );
  });

  it('upgrades a table only once, however many batches are written', async () => {
    fake.liveLabels = {[SCHEMA_VERSION_LABEL_KEY]: '1'};
    const writer = makeWriter();
    await writeOneRow(writer);
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(2);
    expect(fake.metadataReads).toBe(1);
  });
});

describe('BigQueryRowWriter payload column projection', () => {
  it('creates the table without the denied columns', async () => {
    fake.tableExists = false;
    await writeOneRow(
      makeWriter({payloadColumnDenylist: ['content', 'latency_ms']}),
    );
    const schema = fake.created[0].metadata.schema;
    expect(Array.isArray(schema)).toBe(true);
    const columns = Array.isArray(schema)
      ? schema.map((field) => field.name)
      : [];
    expect(columns).not.toContain('content');
    expect(columns).not.toContain('latency_ms');
    expect(columns).toContain('event_id');
  });

  it('writes rows without the denied columns', async () => {
    await writeOneRow(
      makeWriter({payloadColumnDenylist: ['content', 'content_parts']}),
    );
    const [row] = fake.appendCalls[0];
    expect(row).not.toHaveProperty('content');
    expect(row).not.toHaveProperty('content_parts');
    expect(row.event_id).toBe('e1');
  });

  it('appends the event id, which is the key a reader de-duplicates on', async () => {
    await writeOneRow(makeWriter({payloadColumnDenylist: ['attributes']}));
    expect(fake.appendCalls[0][0].event_id).toBe('e1');
  });

  it('does not ask an existing table for the columns it projected out', async () => {
    // The live table keeps `content`; the writer must not read it as missing
    // and must not try to remove it either.
    await writeOneRow(makeWriter({payloadColumnDenylist: ['content']}));
    expect(fake.metadataUpdates).toEqual([]);
  });
});

describe('BigQueryRowWriter queue bounds', () => {
  it('drops a row that arrives at a full queue', async () => {
    const resolved = resolvePluginOptions({
      projectId: 'test-project',
      datasetId: 'agent_analytics',
      config: {batchSize: 100, queueMaxSize: 1},
    });
    const writer = new BigQueryRowWriter(resolved.writer);
    writer.enqueue(makeRow('e1'));
    writer.enqueue(makeRow('e2'));
    expect(writer.getDropStats()[AnalyticsDropReason.QUEUE_FULL]).toBe(1);
    await writer.flush();
    expect(fake.appendCalls[0]).toHaveLength(1);
  });
});

describe('BigQueryRowWriter analytics views', () => {
  it('creates one view per event type alongside an existing table', async () => {
    await writeOneRow(makeWriter());
    expect(fake.queries).toHaveLength(EVENT_VIEW_DEFS.size);
    expect(
      fake.queries.every((sql) => sql.startsWith('CREATE OR REPLACE VIEW')),
    ).toBe(true);
  });

  it('creates the views on a table it just created', async () => {
    fake.tableExists = false;
    await writeOneRow(makeWriter());
    expect(fake.created).toHaveLength(1);
    expect(fake.queries).toHaveLength(EVENT_VIEW_DEFS.size);
  });

  it('creates no view when the caller turned them off', async () => {
    await writeOneRow(makeWriter({createViews: false}));
    expect(fake.queries).toEqual([]);
  });

  it('names the views with the configured prefix', async () => {
    await writeOneRow(makeWriter({viewPrefix: 'agent'}));
    expect(
      fake.queries.some((sql) => sql.includes('.agent_llm_request`')),
    ).toBe(true);
  });

  it('writes the row even when every view fails to create', async () => {
    fake.queryError = new Error('permission denied on views');
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.queries.length).toBeGreaterThan(0);
    expect(fake.appendCalls).toHaveLength(1);
    expect(writer.getDropStats()[AnalyticsDropReason.SETUP_UNAVAILABLE]).toBe(
      0,
    );
  });

  it('creates the views once, however many batches are written', async () => {
    const writer = makeWriter();
    await writeOneRow(writer);
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(2);
    expect(fake.queries).toHaveLength(EVENT_VIEW_DEFS.size);
  });

  it('leaves a denied column out of the view SQL', async () => {
    await writeOneRow(makeWriter({payloadColumnDenylist: ['latency_ms']}));
    const llmResponse = fake.queries.find((sql) =>
      sql.includes("event_type = 'LLM_RESPONSE'"),
    );
    expect(llmResponse).toBeDefined();
    expect(llmResponse).not.toContain('ttft_ms');
    expect(llmResponse).toContain('usage_prompt_tokens');
  });
});

describe('BigQueryRowWriter fresh table propagation', () => {
  it('retries NOT_FOUND while a table it just created propagates', async () => {
    fake.tableExists = false;
    fake.appendErrors = [statusError(5, 'Not found: Table agent_events')];
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(2);
    expect(writer.getDropStats()[AnalyticsDropReason.NON_RETRYABLE]).toBe(0);
  });

  it('drops NOT_FOUND on a table it found already there', async () => {
    fake.tableExists = true;
    fake.createError = undefined;
    fake.appendHold = undefined;
    fake.streamSchema = {fields: []};
    fake.appendErrors = [statusError(5, 'Not found: Table agent_events')];
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.appendCalls).toHaveLength(1);
    expect(writer.getDropStats()[AnalyticsDropReason.NON_RETRYABLE]).toBe(1);
  });

  it('stops retrying NOT_FOUND once the propagation window has passed', async () => {
    vi.useFakeTimers();
    try {
      fake.tableExists = false;
      const writer = makeWriter();
      await writeOneRow(writer);
      // 60s is the window; step past it before the next append fails.
      vi.setSystemTime(Date.now() + 60_001);
      fake.appendErrors = [statusError(5, 'Not found: Table agent_events')];
      fake.appendCalls = [];
      await writeOneRow(writer);
      expect(fake.appendCalls).toHaveLength(1);
      expect(writer.getDropStats()[AnalyticsDropReason.NON_RETRYABLE]).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BigQueryRowWriter storage write stream', () => {
  it('opens the default stream of the destination table', async () => {
    await writeOneRow(makeWriter());
    expect(fake.streamIds).toEqual([
      'projects/test-project/datasets/agent_analytics/tables/agent_events/streams/_default',
    ]);
  });

  it('asks for the full stream view, which is the one carrying the schema', async () => {
    await writeOneRow(makeWriter());
    expect(fake.streamViews).toEqual([2]);
  });

  it('builds the proto descriptor under the root scope', async () => {
    await writeOneRow(makeWriter());
    expect(fake.descriptorScopes).toEqual(['root']);
  });

  it('opens one stream however many batches it writes', async () => {
    const writer = makeWriter();
    await writeOneRow(writer);
    writer.enqueue(makeRow('e2'));
    await writer.flush();
    expect(fake.appendCalls).toHaveLength(2);
    expect(fake.streamIds).toHaveLength(1);
  });

  it('passes the caller credentials to the append client too', async () => {
    const credentials = {client_email: 'a@b.test', private_key: 'k'};
    const resolved = resolvePluginOptions({
      projectId: 'test-project',
      datasetId: 'agent_analytics',
      credentials,
    });
    await writeOneRow(new BigQueryRowWriter(resolved.writer));
    expect(fake.streamOptions[0]).toMatchObject({credentials});
  });

  it('releases the writer, the connection and the client on shutdown', async () => {
    const writer = makeWriter();
    await writeOneRow(writer);
    await writer.shutdown();
    expect(fake.streamsClosed).toBe(3);
  });

  it('releases the stream even when the drain times out', async () => {
    const resolved = resolvePluginOptions({
      projectId: 'test-project',
      datasetId: 'agent_analytics',
      config: {shutdownTimeoutMs: 10},
    });
    const writer = new BigQueryRowWriter(resolved.writer);
    await writeOneRow(writer);
    // An append that never settles makes the drain hit its timeout.
    let release = () => {};
    fake.appendHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    writer.enqueue(makeRow('e2'));
    await writer.shutdown();
    expect(fake.streamsClosed).toBe(3);
    expect(writer.getDropStats()[AnalyticsDropReason.SHUTDOWN_TIMEOUT]).toBe(1);
    release();
  });

  it('opens no stream when the table cannot be readied', async () => {
    fake.tableExists = false;
    fake.createError = new Error('permission denied');
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.streamIds).toEqual([]);
    expect(writer.getDropStats()[AnalyticsDropReason.SETUP_UNAVAILABLE]).toBe(
      1,
    );
  });
});

describe('BigQueryRowWriter stream setup failure', () => {
  it('counts a drop when the service returns a stream with no schema', async () => {
    fake.streamSchema = null;
    const writer = makeWriter();
    await writeOneRow(writer);
    expect(fake.appendCalls).toEqual([]);
    expect(writer.getDropStats()[AnalyticsDropReason.SETUP_UNAVAILABLE]).toBe(
      1,
    );
  });

  it('names the table in the schemaless-stream error it logs', async () => {
    fake.streamSchema = undefined;
    const logged: string[] = [];
    const restore = captureErrors(logged);
    try {
      await writeOneRow(makeWriter());
    } finally {
      restore();
    }
    expect(logged.join('\n')).toContain(
      'returned no schema for projects/test-project/datasets/agent_analytics/tables/agent_events',
    );
  });
});
