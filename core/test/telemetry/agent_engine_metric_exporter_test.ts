/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-js tests for the request-driven metric reader.
 *
 * The ported adk-python scenarios live in
 * `agent_engine_metric_exporter_parity_test.ts`, and the workload sweep in
 * `agent_engine_metric_exporter_properties_test.ts`. This file covers what the
 * reference suite cannot, because the OpenTelemetry JavaScript reader has a
 * different shape: the reader calls the exporter itself, the exporter reports
 * through a callback, shutdown and force-flush are separate hooks, and a
 * promise chain replaces the reference's single worker thread.
 */

import {
  buildRequestDrivenMetrics,
  MIN_EXPORT_INTERVAL_MS,
  RequestDrivenMetricReader,
} from '@google/adk';
import {context} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  ExportResult,
  ExportResultCode,
  isTracingSuppressed,
} from '@opentelemetry/core';
import {
  AggregationOption,
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const PERIOD_MS = 10_000;
const FLOOR_MS = 3_000;

const INTERVAL_ENV = 'OTEL_METRIC_EXPORT_INTERVAL';
const FLOOR_ENV =
  'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS';
const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

/** Lets every queued microtask run, so a fire-and-forget collect reaches the exporter. */
function flushPendingWork(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** A settable promise, for holding an export open. */
function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return {promise, resolve};
}

/** A push exporter that records everything the reader asks of it. */
class FakeExporter implements PushMetricExporter {
  readonly exports: ResourceMetrics[] = [];
  /** Whether tracing was suppressed when each export ran. */
  readonly suppressedAtExport: boolean[] = [];
  forceFlushCalls = 0;
  shutdownCalls = 0;
  /** The result handed back to the reader. */
  result: ExportResult = {code: ExportResultCode.SUCCESS};
  /** When set, the export completes only once this resolves. */
  gate: Promise<void> | undefined;

  private running = 0;
  maxConcurrentExports = 0;

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.exports.push(metrics);
    this.suppressedAtExport.push(isTracingSuppressed(context.active()));
    this.running++;
    this.maxConcurrentExports = Math.max(
      this.maxConcurrentExports,
      this.running,
    );
    const finish = () => {
      this.running--;
      resultCallback(this.result);
    };
    if (this.gate === undefined) {
      finish();
      return;
    }
    void this.gate.then(finish);
  }

  forceFlush(): Promise<void> {
    this.forceFlushCalls++;
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdownCalls++;
    return Promise.resolve();
  }
}

/** A reader bound to a provider, plus the knobs a test needs to drive it. */
interface Fixture {
  clock: {t: number};
  exporter: FakeExporter;
  reader: RequestDrivenMetricReader;
  meterProvider: MeterProvider;
}

interface FixtureOptions {
  /** Record a counter value, so a collect has something to export. */
  withData?: boolean;
  /** Register an observable whose callback throws, so a collect reports errors. */
  withFailingObservable?: boolean;
}

function createFixture({
  withData = true,
  withFailingObservable = false,
}: FixtureOptions = {}): Fixture {
  const clock = {t: 0};
  const exporter = new FakeExporter();
  const reader = new RequestDrivenMetricReader(exporter, {
    exportIntervalMillis: PERIOD_MS,
    floorMillis: FLOOR_MS,
    now: () => clock.t,
  });
  const meterProvider = new MeterProvider({readers: [reader]});
  const meter = meterProvider.getMeter('test');
  if (withData) {
    meter.createCounter('c').add(1);
  }
  if (withFailingObservable) {
    meter.createObservableGauge('g').addCallback(() => {
      throw new Error('observable callback failed');
    });
  }
  return {clock, exporter, reader, meterProvider};
}

describe('RequestDrivenMetricReader export context', () => {
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    context.disable();
    contextManager.disable();
  });

  it('suppresses tracing while the exporter runs', async () => {
    const {exporter, reader, meterProvider} = createFixture();

    await reader.forceFlush();

    expect(exporter.suppressedAtExport).toEqual([true]);
    expect(isTracingSuppressed(context.active())).toBe(false);
    await meterProvider.shutdown();
  });
});

describe('RequestDrivenMetricReader collect execution', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not export a collect that produced no metrics', async () => {
    const {exporter, reader, meterProvider} = createFixture({withData: false});

    await reader.forceFlush();

    expect(exporter.exports).toEqual([]);
    expect(exporter.forceFlushCalls).toBe(1);
    await meterProvider.shutdown();
  });

  it('logs collection errors and still exports what it collected', async () => {
    const {exporter, reader, meterProvider} = createFixture({
      withFailingObservable: true,
    });

    await reader.forceFlush();

    expect(warnSpy).toHaveBeenCalledWith(
      'Errors while collecting request-driven metrics',
      expect.arrayContaining([expect.any(Error)]),
    );
    expect(exporter.exports).toHaveLength(1);
    await meterProvider.shutdown();
  });

  it('logs a failed export instead of rejecting, and collects again', async () => {
    const {clock, exporter, reader, meterProvider} = createFixture();
    exporter.result = {
      code: ExportResultCode.FAILED,
      error: new Error('backend rejected the points'),
    };

    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 1000;
    expect(reader.noteRequestEnd()).toBe(true);
    await expect(reader.submitCollect()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'Exception during request-driven metric collect',
      expect.objectContaining({message: 'backend rejected the points'}),
    );

    exporter.result = {code: ExportResultCode.SUCCESS};
    clock.t = 10_000;
    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 11_000;
    expect(reader.noteRequestEnd()).toBe(true);
    await reader.submitCollect();

    expect(exporter.exports).toHaveLength(2);
    await meterProvider.shutdown();
  });

  it('reports a failed export with no error of its own', async () => {
    const {exporter, reader, meterProvider} = createFixture();
    exporter.result = {code: ExportResultCode.FAILED};

    await reader.forceFlush();

    expect(errorSpy).toHaveBeenCalledWith(
      'Exception during request-driven metric collect',
      expect.objectContaining({message: 'Metric export failed'}),
    );
    await meterProvider.shutdown();
  });

  it('runs one collect at a time, whatever the caller does', async () => {
    const {exporter, reader, meterProvider} = createFixture();
    const gate = deferred();
    exporter.gate = gate.promise;

    const first = reader.submitCollect();
    const second = reader.submitCollect();
    await flushPendingWork();

    expect(exporter.exports).toHaveLength(1);

    gate.resolve();
    await first;
    await second;

    expect(exporter.exports).toHaveLength(2);
    expect(exporter.maxConcurrentExports).toBe(1);
    await meterProvider.shutdown();
  });
});

describe('RequestDrivenMetricReader lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains queued collects, collects once more, then shuts the exporter down', async () => {
    const {exporter, reader, meterProvider} = createFixture();
    const gate = deferred();
    exporter.gate = gate.promise;
    const queued = reader.submitCollect();
    exporter.gate = undefined;
    gate.resolve();

    await meterProvider.shutdown();
    await queued;

    expect(exporter.exports).toHaveLength(2);
    expect(exporter.shutdownCalls).toBe(1);
  });

  it('collects and then flushes the exporter on a force flush', async () => {
    const {exporter, reader, meterProvider} = createFixture();

    await reader.forceFlush();

    expect(exporter.exports).toHaveLength(1);
    expect(exporter.forceFlushCalls).toBe(1);
    await meterProvider.shutdown();
  });

  it('refuses a collect after shutdown and releases the guard', async () => {
    const {clock, reader, meterProvider} = createFixture();
    await meterProvider.shutdown();

    clock.t = 100_000;
    expect(reader.noteRequestStart()).toBe(false);
    expect(reader.noteRequestEnd()).toBe(true);
    expect(reader.submitCollect()).toBeUndefined();

    // The guard is clear, so the next drain still decides to collect.
    clock.t = 200_000;
    expect(reader.noteRequestStart()).toBe(false);
    expect(reader.noteRequestEnd()).toBe(true);
  });

  it('does not arm a second collect while one is committed', async () => {
    const {clock, reader, meterProvider} = createFixture();

    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 11_000;
    // The guidepost at 10000 is crossed and there is overlap, so this start
    // commits a collect. Nothing runs it, so the guard stays closed.
    expect(reader.noteRequestStart()).toBe(true);

    clock.t = 21_000;
    expect(reader.noteRequestStart()).toBe(false);
    expect(reader.noteRequestEnd()).toBe(false);
    expect(reader.noteGenerateContentStart()).toBe(false);

    await meterProvider.shutdown();
  });

  it('measures overdue from the current busy period, not an older collect', async () => {
    // A collect from an earlier busy period must not make a fresh short
    // request look overdue. Otherwise point 4 fires on that request's first
    // inference span, stamps the floor, and mutes the drain that carries its
    // points.
    const {clock, reader, meterProvider} = createFixture();

    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 5_000;
    expect(reader.noteRequestEnd()).toBe(true);
    await reader.submitCollect();

    // A long idle gap, then a short request.
    clock.t = 100_000;
    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 101_000;
    expect(reader.noteGenerateContentStart()).toBe(false);

    // Once this busy period itself runs long, point 4 does fire.
    clock.t = 115_000;
    expect(reader.noteGenerateContentStart()).toBe(true);

    await meterProvider.shutdown();
  });

  it('advances the guidepost grid past a collect', async () => {
    const {clock, reader, meterProvider} = createFixture();

    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 11_000;
    // The guidepost at 10000 fires here, and the grid moves to 20000.
    expect(reader.noteRequestStart()).toBe(true);
    await reader.submitCollect();

    clock.t = 14_000;
    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 19_999;
    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 20_000;
    expect(reader.noteRequestStart()).toBe(true);

    await meterProvider.shutdown();
  });

  it('defers a muted guidepost by a whole period', async () => {
    // Point 3 skips the guidepost, so the next start does not pick it up as
    // soon as the floor allows; it waits for the following guidepost.
    const {clock, exporter, reader, meterProvider} = createFixture();

    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 9_000;
    expect(reader.noteRequestEnd()).toBe(true);
    await reader.submitCollect();

    clock.t = 9_500;
    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 10_000;
    // The guidepost is due but sits inside the floor, so it is muted.
    expect(reader.noteRequestStart()).toBe(false);

    clock.t = 12_500;
    expect(reader.noteRequestStart()).toBe(false);
    clock.t = 19_999;
    expect(reader.noteRequestStart()).toBe(false);
    expect(exporter.exports).toHaveLength(1);

    // The next guidepost, one period on, does fire.
    clock.t = 20_000;
    expect(reader.noteRequestStart()).toBe(true);

    await meterProvider.shutdown();
  });

  it('keeps the in-flight count at zero when an end has no start', async () => {
    const {clock, reader, meterProvider} = createFixture();

    expect(reader.noteRequestEnd()).toBe(true);
    await reader.submitCollect();

    clock.t = FLOOR_MS;
    expect(reader.noteRequestStart()).toBe(false);
    expect(reader.noteRequestEnd()).toBe(true);
    await meterProvider.shutdown();
  });

  it('takes temporality and aggregation from the exporter', () => {
    const exporter: PushMetricExporter = {
      export: (_metrics, resultCallback) =>
        resultCallback({code: ExportResultCode.SUCCESS}),
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      selectAggregationTemporality: (): AggregationTemporality =>
        AggregationTemporality.DELTA,
      selectAggregation: (): AggregationOption => ({type: AggregationType.SUM}),
    };
    const reader = new RequestDrivenMetricReader(exporter);

    expect(reader.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(
      AggregationTemporality.DELTA,
    );
    expect(reader.selectAggregation(InstrumentType.HISTOGRAM)).toEqual({
      type: AggregationType.SUM,
    });
  });
});

describe('RequestDrivenMetricReader configuration from the environment', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /**
   * Starts two overlapping requests 6000 ms apart and returns the collects.
   *
   * A guidepost crossed before the second start collects there (point 2), so
   * the result tells a 5000 ms period apart from the 60000 ms default.
   */
  async function collectsAcrossTwoStarts(): Promise<number[]> {
    const clock = {t: 0};
    const exporter = new FakeExporter();
    const reader = new RequestDrivenMetricReader(exporter, {
      floorMillis: FLOOR_MS,
      now: () => clock.t,
    });
    const meterProvider = new MeterProvider({readers: [reader]});
    meterProvider.getMeter('test').createCounter('c').add(1);
    const times: number[] = [];
    try {
      for (const at of [0, 6000]) {
        clock.t = at;
        if (reader.noteRequestStart()) {
          await reader.submitCollect();
          times.push(at);
        }
      }
      return times;
    } finally {
      await meterProvider.shutdown();
    }
  }

  it('uses the default period when the interval variable is unset', async () => {
    vi.stubEnv(INTERVAL_ENV, undefined);

    expect(await collectsAcrossTwoStarts()).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('uses the period from the interval variable', async () => {
    vi.stubEnv(INTERVAL_ENV, '5000');

    expect(await collectsAcrossTwoStarts()).toEqual([6000]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty value', ''],
    ['a whitespace value', '   '],
    ['a non-numeric value', 'not-a-number'],
  ])('warns once and uses the default for %s', async (_label, raw) => {
    vi.stubEnv(INTERVAL_ENV, raw);

    expect(await collectsAcrossTwoStarts()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `Found invalid value for ${INTERVAL_ENV}=${raw}, using default 60000`,
    );
  });

  it('reports the floor variable by name when it is invalid', async () => {
    vi.stubEnv(FLOOR_ENV, 'soon');

    const reader = new RequestDrivenMetricReader(new FakeExporter());

    expect(reader).toBeInstanceOf(RequestDrivenMetricReader);
    expect(warnSpy).toHaveBeenCalledWith(
      `Found invalid value for ${FLOOR_ENV}=soon, using default ${MIN_EXPORT_INTERVAL_MS}`,
    );
  });
});

describe('buildRequestDrivenMetrics span processor', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Wires the returned processor into a real tracer provider. */
  function createTracer(spanProcessor: SpanProcessor): BasicTracerProvider {
    return new BasicTracerProvider({spanProcessors: [spanProcessor]});
  }

  /** A reader already one and a half periods into a lone long request. */
  function createOverdueReader(): {
    clock: {t: number};
    exporter: FakeExporter;
    state: ReturnType<typeof buildRequestDrivenMetrics>;
    meterProvider: MeterProvider;
  } {
    const clock = {t: 0};
    const exporter = new FakeExporter();
    const state = buildRequestDrivenMetrics(exporter, {
      exportIntervalMillis: PERIOD_MS,
      floorMillis: FLOOR_MS,
      now: () => clock.t,
    });
    const meterProvider = new MeterProvider({readers: [state.reader]});
    meterProvider.getMeter('test').createCounter('c').add(1);
    state.reader.noteRequestStart();
    clock.t = 2 * PERIOD_MS;
    return {clock, exporter, state, meterProvider};
  }

  it('collects on a span named generate_content', async () => {
    const {exporter, state, meterProvider} = createOverdueReader();
    const tracer = createTracer(state.spanProcessor).getTracer('test');

    tracer.startSpan('generate_content gemini-2.5-flash').end();
    await state.reader.forceFlush();

    expect(exporter.exports.length).toBeGreaterThanOrEqual(1);
    expect(errorSpy).not.toHaveBeenCalled();
    await meterProvider.shutdown();
  });

  it('collects on a span attributed with the generate_content operation', async () => {
    const {exporter, state, meterProvider} = createOverdueReader();
    const tracer = createTracer(state.spanProcessor).getTracer('test');

    tracer
      .startSpan('call_llm', {
        attributes: {[GEN_AI_OPERATION_NAME]: 'generate_content'},
      })
      .end();
    await flushPendingWork();

    expect(exporter.exports).toHaveLength(1);
    await meterProvider.shutdown();
  });

  it('ignores a span that is neither named nor attributed for generation', async () => {
    const {exporter, state, meterProvider} = createOverdueReader();
    const tracer = createTracer(state.spanProcessor).getTracer('test');

    tracer
      .startSpan('invocation', {attributes: {[GEN_AI_OPERATION_NAME]: 'chat'}})
      .end();
    await flushPendingWork();

    expect(exporter.exports).toEqual([]);
    await meterProvider.shutdown();
  });

  it('logs and keeps the span when the reader throws', () => {
    const exporter = new FakeExporter();
    // The constructor reads the clock, so it only fails once the reader is up.
    let clockFails = false;
    const {spanProcessor} = buildRequestDrivenMetrics(exporter, {
      now: () => {
        if (clockFails) {
          throw new Error('clock unavailable');
        }
        return 0;
      },
    });
    clockFails = true;
    const tracer = createTracer(spanProcessor).getTracer('test');

    const span = tracer.startSpan('generate_content');
    span.end();

    expect(errorSpy).toHaveBeenCalledWith(
      'Metrics span-start hook failed',
      expect.objectContaining({message: 'clock unavailable'}),
    );
    expect(span.isRecording()).toBe(false);
  });

  it('resolves its own shutdown and force flush', async () => {
    const {spanProcessor} = buildRequestDrivenMetrics(new FakeExporter());

    await expect(spanProcessor.forceFlush()).resolves.toBeUndefined();
    await expect(spanProcessor.shutdown()).resolves.toBeUndefined();
  });
});
