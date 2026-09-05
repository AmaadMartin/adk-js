/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Fixtures shared by the two `SqliteSpanExporter` suites. */

import {SqliteSpanExporter} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {
  Attributes,
  HrTime,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api';
import {ExportResult} from '@opentelemetry/core';
import {emptyResource} from '@opentelemetry/resources';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import {StorageSpan} from '../../src/telemetry/db/schema.js';

export const SESSION_ID_ATTRIBUTE = 'gcp.vertex.agent.session_id';
export const INVOCATION_ID_ATTRIBUTE = 'gcp.vertex.agent.invocation_id';
export const CONVERSATION_ID_ATTRIBUTE = 'gen_ai.conversation.id';

const DEFAULT_SPAN_ID = '00000000000abc12';
const DEFAULT_TRACE_ID = '000000000000000000000000000def45';

export interface CreateSpanOptions {
  spanId?: string;
  traceId?: string;
  parentSpanId?: string;
  name?: string;
  attributes?: Attributes;
  startTime?: HrTime;
  endTime?: HrTime;
}

/**
 * Builds a finished span, the analogue of the reference's `_create_span`.
 *
 * Every `ReadableSpan` field is populated, so the literal satisfies the
 * interface on its own and no cast is needed.
 */
export function createReadableSpan(
  options: CreateSpanOptions = {},
): ReadableSpan {
  const {
    spanId = DEFAULT_SPAN_ID,
    traceId = DEFAULT_TRACE_ID,
    parentSpanId,
    name = 'test_span',
    attributes = {},
    startTime = [0, 1000],
    endTime = [0, 2000],
  } = options;

  const spanContext = {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  };

  return {
    name,
    kind: SpanKind.INTERNAL,
    spanContext: () => spanContext,
    parentSpanContext: parentSpanId
      ? {...spanContext, spanId: parentSpanId}
      : undefined,
    startTime,
    endTime,
    duration: [endTime[0] - startTime[0], endTime[1] - startTime[1]],
    status: {code: SpanStatusCode.UNSET},
    attributes,
    links: [],
    events: [],
    ended: true,
    resource: emptyResource(),
    instrumentationScope: {name: 'test', version: '0.0.0'},
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** Promisified `export`, since the JS interface reports through a callback. */
export function exportSpans(
  exporter: SqliteSpanExporter,
  spans: ReadableSpan[],
): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve) => {
    exporter.export(spans, resolve);
  });
}

/**
 * Opens `dbPath` on a connection of its own, runs `use`, then closes it.
 *
 * Tests reach the database directly to assert what the exporter wrote, and to
 * write rows the exporter would never produce. The connection is always
 * closed, so Windows can delete the temporary directory afterwards.
 */
export async function withDatabase<T>(
  dbPath: string,
  use: (orm: MikroORM) => Promise<T>,
): Promise<T> {
  const orm = await MikroORM.init({
    dbName: dbPath,
    driver: SqliteDriver,
    entities: [StorageSpan],
  });
  try {
    return await use(orm);
  } finally {
    await orm.close();
  }
}
