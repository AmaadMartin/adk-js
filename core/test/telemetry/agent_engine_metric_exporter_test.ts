/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the request-driven metric reader.
 *
 * Every test drives the reader through an injected clock, so nothing sleeps.
 * A collect is observed through the exporter it drains into.
 */

import {
  buildRequestDrivenMetrics,
  RequestDrivenMetricReader,
} from '@google/adk';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {emptyResource} from '@opentelemetry/resources';
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {BasicTracerProvider} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';

const PERIOD_MS = 60000;
const FLOOR_MS = 5000;
const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

/** Records every batch handed to it, and reports success. */
class FakeMetricExporter implements PushMetricExporter {
  readonly batches: ResourceMetrics[] = [];
  failWith: Error | undefined;
  failWithoutReason = false;

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.batches.push(metrics);
    if (this.failWithoutReason) {
      resultCallback({code: ExportResultCode.FAILED});
      return;
    }
    if (this.failWith) {
      resultCallback({code: ExportResultCode.FAILED, error: this.failWith});
      return;
    }
    resultCallback({code: ExportResultCode.SUCCESS});
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

let clock = 0;
const now = () => clock;

/** Lets a fire-and-forget collect run before the assertion. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Builds a reader bound to a `MeterProvider` that already carries one point,
 * so every collect produces a batch the exporter can be counted through.
 */
function createReader(): {
  reader: RequestDrivenMetricReader;
  exporter: FakeMetricExporter;
} {
  const exporter = new FakeMetricExporter();
  const reader = new RequestDrivenMetricReader(exporter, {
    exportIntervalMillis: PERIOD_MS,
    floorMillis: FLOOR_MS,
    now,
  });
  const provider = new MeterProvider({readers: [reader]});
  provider
    .getMeter('agent_engine_metric_exporter_test')
    .createCounter('c')
    .add(1);
  return {reader, exporter};
}

/** Runs one request: start at `startAt`, end at `endAt`. */
async function serveRequest(
  reader: RequestDrivenMetricReader,
  startAt: number,
  endAt: number,
): Promise<void> {
  clock = startAt;
  if (reader.noteRequestStart()) {
    await reader.submitCollect();
  }
  clock = endAt;
  if (reader.noteRequestEnd()) {
    await reader.submitCollect();
  }
}

beforeEach(() => {
  clock = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('RequestDrivenMetricReader', () => {
  it('collects when the last in-flight request drains', async () => {
    const {reader, exporter} = createReader();

    await serveRequest(reader, 0, 100);

    expect(exporter.batches).toHaveLength(1);
  });

  it('batches three overlapping requests into one collect', async () => {
    const {reader, exporter} = createReader();

    clock = 0;
    expect(reader.noteRequestStart()).toBe(false);
    clock = 10;
    expect(reader.noteRequestStart()).toBe(false);
    clock = 20;
    expect(reader.noteRequestStart()).toBe(false);
    clock = 30;
    expect(reader.noteRequestEnd()).toBe(false);
    clock = 40;
    expect(reader.noteRequestEnd()).toBe(false);
    clock = 50;
    expect(reader.noteRequestEnd()).toBe(true);
    await reader.submitCollect();

    expect(exporter.batches).toHaveLength(1);
  });

  it('collects at the next request start once a guidepost is crossed', async () => {
    const {reader, exporter} = createReader();

    clock = 0;
    expect(reader.noteRequestStart()).toBe(false);
    clock = PERIOD_MS + 1000;
    expect(reader.noteRequestStart()).toBe(true);
    await reader.submitCollect();

    expect(exporter.batches).toHaveLength(1);
  });

  it('mutes a guidepost inside the floor and advances the grid', async () => {
    const {reader, exporter} = createReader();

    await serveRequest(reader, 0, PERIOD_MS - 2);
    expect(exporter.batches).toHaveLength(1);

    clock = PERIOD_MS - 1;
    expect(reader.noteRequestStart()).toBe(false);
    clock = PERIOD_MS;
    // The guidepost is due but the last collect is 2ms old, so it is muted.
    expect(reader.noteRequestStart()).toBe(false);

    // Had the grid not advanced, this start would be due and past the floor.
    clock = PERIOD_MS + FLOOR_MS;
    expect(reader.noteRequestStart()).toBe(false);
    expect(exporter.batches).toHaveLength(1);
  });

  it('collects on a generate_content start only past 1.5 periods', async () => {
    const {reader, exporter} = createReader();

    clock = 0;
    reader.noteRequestStart();
    clock = 1000;
    expect(reader.noteGenerateContentStart()).toBe(false);

    clock = 1.5 * PERIOD_MS;
    expect(reader.noteGenerateContentStart()).toBe(true);
    await reader.submitCollect();

    expect(exporter.batches).toHaveLength(1);
  });

  it('does not collect on a generate_content start with no request in flight', () => {
    const {reader} = createReader();

    clock = 2 * PERIOD_MS;

    expect(reader.noteGenerateContentStart()).toBe(false);
  });

  it('collects once for two requests that drain inside the floor', async () => {
    const {reader, exporter} = createReader();

    await serveRequest(reader, 0, 100);
    await serveRequest(reader, 200, 300);

    expect(exporter.batches).toHaveLength(1);
  });

  it('does not drive the in-flight count negative on an unmatched end', async () => {
    const {reader, exporter} = createReader();

    clock = 0;
    expect(reader.noteRequestEnd()).toBe(true);
    await reader.submitCollect();

    // With a negative count the next request would end at -1 and never collect.
    await serveRequest(reader, 2 * FLOOR_MS, 2 * FLOOR_MS + 100);

    expect(exporter.batches).toHaveLength(2);
  });

  it('returns undefined from submitCollect after shutdown', async () => {
    const {reader} = createReader();

    await reader.shutdown();

    clock = 10 * FLOOR_MS;
    reader.noteRequestStart();
    clock = 11 * FLOOR_MS;
    expect(reader.noteRequestEnd()).toBe(true);
    expect(reader.submitCollect()).toBeUndefined();
  });

  it('leaves the collect guard clear when shutdown refuses a collect', async () => {
    const {reader} = createReader();
    await reader.shutdown();
    clock = 10 * FLOOR_MS;
    reader.noteRequestStart();
    clock = 11 * FLOOR_MS;
    reader.noteRequestEnd();
    reader.submitCollect();

    // A wedged guard would make every later decision return false.
    clock = 20 * FLOOR_MS;
    reader.noteRequestStart();
    clock = 21 * FLOOR_MS;

    expect(reader.noteRequestEnd()).toBe(true);
  });

  it('exports a final batch on shutdown', async () => {
    const {reader, exporter} = createReader();

    await reader.shutdown();

    expect(exporter.batches).toHaveLength(1);
  });

  it('collects and flushes the exporter on force flush', async () => {
    const {reader, exporter} = createReader();
    const flush = vi.spyOn(exporter, 'forceFlush');

    await reader.forceFlush();

    expect(exporter.batches).toHaveLength(1);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('logs an export failure instead of rejecting', async () => {
    const {reader, exporter} = createReader();
    exporter.failWith = new Error('export refused');
    const error = vi.spyOn(logger, 'error');

    await serveRequest(reader, 0, 100);

    expect(error).toHaveBeenCalledWith(
      'Exception during request-driven metric collect',
      exporter.failWith,
    );
  });

  it('falls back to the default period on an unparseable env value', () => {
    vi.stubEnv('OTEL_METRIC_EXPORT_INTERVAL', 'soon');
    const warn = vi.spyOn(logger, 'warn');

    new RequestDrivenMetricReader(new FakeMetricExporter(), {now});

    expect(warn).toHaveBeenCalledWith(
      'Found invalid value for OTEL_METRIC_EXPORT_INTERVAL="soon", using default 60000',
    );
  });

  it('falls back to the default floor on an empty env value', async () => {
    vi.stubEnv(
      'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS',
      '',
    );
    const exporter = new FakeMetricExporter();
    const reader = new RequestDrivenMetricReader(exporter, {
      exportIntervalMillis: PERIOD_MS,
      now,
    });
    new MeterProvider({readers: [reader]})
      .getMeter('agent_engine_metric_exporter_test')
      .createCounter('c')
      .add(1);

    // A floor of zero would let the second request collect as well.
    await serveRequest(reader, 0, 100);
    await serveRequest(reader, 200, 300);

    expect(exporter.batches).toHaveLength(1);
  });

  it('reads the floor from the environment', async () => {
    vi.stubEnv(
      'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS',
      '50',
    );
    const exporter = new FakeMetricExporter();
    const reader = new RequestDrivenMetricReader(exporter, {
      exportIntervalMillis: PERIOD_MS,
      now,
    });
    new MeterProvider({readers: [reader]})
      .getMeter('agent_engine_metric_exporter_test')
      .createCounter('c')
      .add(1);

    await serveRequest(reader, 0, 100);
    await serveRequest(reader, 200, 300);

    expect(exporter.batches).toHaveLength(2);
  });

  it('logs the errors a collect reports', async () => {
    const {reader, exporter} = createReader();
    const collectError = new Error('producer failed');
    vi.spyOn(reader, 'collect').mockResolvedValue({
      resourceMetrics: {resource: emptyResource(), scopeMetrics: []},
      errors: [collectError],
    });
    const warn = vi.spyOn(logger, 'warn');

    await serveRequest(reader, 0, 100);

    expect(warn).toHaveBeenCalledWith(
      'Errors during request-driven metric collect',
      collectError,
    );
    expect(exporter.batches).toHaveLength(0);
  });

  it('does not collect while a collect is already in flight', async () => {
    const {reader, exporter} = createReader();

    clock = 0;
    reader.noteRequestStart();
    clock = 100;
    expect(reader.noteRequestEnd()).toBe(true);
    const collect = reader.submitCollect();
    clock = 200;

    expect(reader.noteRequestStart()).toBe(false);
    await collect;
    expect(exporter.batches).toHaveLength(1);
  });

  it('measures point 4 from the current busy period, not an old collect', async () => {
    const {reader} = createReader();
    await serveRequest(reader, 0, 100);

    // A fresh busy period after a long idle gap is not overdue, even though
    // the last collect is far behind.
    clock = 2 * PERIOD_MS;
    reader.noteRequestStart();
    clock = 2 * PERIOD_MS + 1000;

    expect(reader.noteGenerateContentStart()).toBe(false);
  });

  it('logs an export that fails without naming a reason', async () => {
    const {reader, exporter} = createReader();
    exporter.failWithoutReason = true;
    const error = vi.spyOn(logger, 'error');

    await serveRequest(reader, 0, 100);

    expect(error).toHaveBeenCalledWith(
      'Exception during request-driven metric collect',
      new Error('Metric export failed'),
    );
  });

  it('takes temporality and aggregation from the exporter', () => {
    const exporter = Object.assign(new FakeMetricExporter(), {
      selectAggregationTemporality: () => AggregationTemporality.DELTA,
      selectAggregation: () => ({type: AggregationType.DROP}),
    });

    const reader = new RequestDrivenMetricReader(exporter, {now});

    expect(reader.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(
      AggregationTemporality.DELTA,
    );
    expect(reader.selectAggregation(InstrumentType.COUNTER)).toEqual({
      type: AggregationType.DROP,
    });
  });
});

describe('the span processor from buildRequestDrivenMetrics', () => {
  function record(
    spanName: string,
    attributes: Record<string, string> = {},
  ): {exporter: FakeMetricExporter} {
    const exporter = new FakeMetricExporter();
    const {reader, spanProcessor} = buildRequestDrivenMetrics(exporter, {
      exportIntervalMillis: PERIOD_MS,
      floorMillis: FLOOR_MS,
      now,
    });
    new MeterProvider({readers: [reader]})
      .getMeter('agent_engine_metric_exporter_test')
      .createCounter('c')
      .add(1);

    clock = 0;
    reader.noteRequestStart();
    clock = 2 * PERIOD_MS;
    new BasicTracerProvider({spanProcessors: [spanProcessor]})
      .getTracer('agent_engine_metric_exporter_test')
      .startSpan(spanName, {attributes})
      .end();
    return {exporter};
  }

  it('collects on a span named generate_content', async () => {
    const {exporter} = record('generate_content gemini-2.0-flash');

    await vi.waitFor(() => expect(exporter.batches).toHaveLength(1));
  });

  it('collects on a span attributed generate_content', async () => {
    const {exporter} = record('call_llm', {
      [GEN_AI_OPERATION_NAME]: 'generate_content',
    });

    await vi.waitFor(() => expect(exporter.batches).toHaveLength(1));
  });

  it('ignores a span that is neither named nor attributed generate_content', async () => {
    const {exporter} = record('tool_call', {[GEN_AI_OPERATION_NAME]: 'chat'});

    await flushMicrotasks();

    expect(exporter.batches).toHaveLength(0);
  });

  it('does not throw when the reader throws', () => {
    const exporter = new FakeMetricExporter();
    const {reader, spanProcessor} = buildRequestDrivenMetrics(exporter, {now});
    const boom = new Error('boom');
    vi.spyOn(reader, 'noteGenerateContentStart').mockImplementation(() => {
      throw boom;
    });
    const error = vi.spyOn(logger, 'error');

    new BasicTracerProvider({spanProcessors: [spanProcessor]})
      .getTracer('agent_engine_metric_exporter_test')
      .startSpan('generate_content')
      .end();

    expect(error).toHaveBeenCalledWith('Metrics span-start hook failed', boom);
  });

  it('resolves forceFlush and shutdown', async () => {
    const {spanProcessor} = buildRequestDrivenMetrics(new FakeMetricExporter());

    await expect(spanProcessor.forceFlush()).resolves.toBeUndefined();
    await expect(spanProcessor.shutdown()).resolves.toBeUndefined();
  });
});
