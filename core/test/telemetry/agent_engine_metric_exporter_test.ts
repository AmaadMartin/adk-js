/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-js tests for the request-driven metric reader.
 *
 * These cover the parts of the port that adk-python's tests do not reach: the
 * promise-chain serialization that replaces its thread pool, the OpenTelemetry
 * JS lifecycle methods, the environment parsing and the span processor. The
 * ported reference tests live in the two sibling files.
 */

import {
  buildRequestDrivenMetrics,
  RequestDrivenMetricReader,
} from '@google/adk';
import {context, metrics} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  ExportResult,
  ExportResultCode,
  isTracingSuppressed,
} from '@opentelemetry/core';
import {
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
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const PERIOD_MS = 10_000;
const FLOOR_MS = 3_000;
const INTERVAL_ENV = 'OTEL_METRIC_EXPORT_INTERVAL';
const TIMEOUT_ENV = 'OTEL_METRIC_EXPORT_TIMEOUT';

/** A `PushMetricExporter` that records what happened on every call. */
class FakeExporter implements PushMetricExporter {
  readonly exports: ResourceMetrics[] = [];
  readonly suppressed: boolean[] = [];
  shutdownCalls = 0;
  forceFlushCalls = 0;
  /** Set to make every export report a failure. */
  failure: ExportResult | undefined;
  /** Awaited inside `export`, to hold a collect open. */
  gate: Promise<void> | undefined;
  /** Records `enter` and `exit` around each export body. */
  readonly order: string[] = [];

  export(
    metricData: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.order.push('enter');
    this.exports.push(metricData);
    this.suppressed.push(isTracingSuppressed(context.active()));
    const finish = () => {
      this.order.push('exit');
      resultCallback(this.failure ?? {code: ExportResultCode.SUCCESS});
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

/** A clock the test moves by hand. */
class FakeClock {
  t = 0;
  readonly now = () => this.t;
}

/** Attaches a meter with one recorded value, so a collect has data to export. */
function meterProviderWith(reader: RequestDrivenMetricReader): MeterProvider {
  const provider = new MeterProvider({readers: [reader]});
  provider.getMeter('test').createCounter('c').add(1);
  return provider;
}

describe('RequestDrivenMetricReader collect execution', () => {
  let exporter: FakeExporter;
  let clock: FakeClock;
  let reader: RequestDrivenMetricReader;
  let provider: MeterProvider | undefined;

  beforeEach(() => {
    exporter = new FakeExporter();
    clock = new FakeClock();
    reader = new RequestDrivenMetricReader(exporter, {
      exportIntervalMillis: PERIOD_MS,
      floorMillis: FLOOR_MS,
      now: clock.now,
    });
    provider = meterProviderWith(reader);
  });

  afterEach(async () => {
    await provider?.shutdown();
    provider = undefined;
    vi.restoreAllMocks();
  });

  it('runs queued collects one at a time', async () => {
    let release = () => {};
    exporter.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = reader.submitCollect();
    const second = reader.submitCollect();
    release();
    await Promise.all([first, second]);

    expect(exporter.order).toEqual(['enter', 'exit', 'enter', 'exit']);
  });

  it('exports with tracing suppressed', async () => {
    // `context.with` only propagates through a real context manager, which
    // `NodeTracerProvider.register()` installs in a running agent.
    const contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
    try {
      await reader.submitCollect();

      expect(exporter.suppressed).toEqual([true]);
    } finally {
      context.disable();
      contextManager.disable();
    }
  });

  it('skips the export when the collect found no metrics', async () => {
    const emptyReader = new RequestDrivenMetricReader(exporter, {
      now: clock.now,
    });
    const emptyProvider = new MeterProvider({readers: [emptyReader]});

    await emptyReader.submitCollect();

    expect(exporter.exports).toEqual([]);
    await emptyProvider.shutdown();
  });

  it('logs a failed export instead of rejecting', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    exporter.failure = {
      code: ExportResultCode.FAILED,
      error: new Error('backend refused the points'),
    };

    await expect(reader.submitCollect()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'Exception during request-driven metric collect',
      expect.objectContaining({message: 'backend refused the points'}),
    );
  });

  it('names the failure when the exporter reports no error', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    exporter.failure = {code: ExportResultCode.FAILED};

    await reader.submitCollect();

    expect(errorSpy).toHaveBeenCalledWith(
      'Exception during request-driven metric collect',
      expect.objectContaining({message: 'Metric export failed'}),
    );
  });

  it('logs a throwing collect and releases the collect guard', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    // A reader that no MeterProvider ever bound: collect() throws.
    const unboundReader = new RequestDrivenMetricReader(exporter, {
      floorMillis: FLOOR_MS,
      now: clock.now,
    });
    expect(unboundReader.noteRequestStart()).toBe(false);
    expect(unboundReader.noteRequestEnd()).toBe(true);

    await unboundReader.submitCollect();

    expect(errorSpy).toHaveBeenCalledWith(
      'Exception during request-driven metric collect',
      expect.objectContaining({
        message: 'MetricReader is not bound to a MetricProducer',
      }),
    );
    // The guard was released, so the next drain can arm again.
    clock.t = FLOOR_MS;
    expect(unboundReader.noteRequestStart()).toBe(false);
    expect(unboundReader.noteRequestEnd()).toBe(true);
  });

  it('warns about a metric producer that failed to collect', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    provider
      ?.getMeter('test')
      .createObservableGauge('g')
      .addCallback(() => {
        throw new Error('producer failed');
      });

    await reader.submitCollect();

    expect(warnSpy).toHaveBeenCalledWith(
      'Errors while collecting request-driven metrics',
      expect.arrayContaining([
        expect.objectContaining({message: 'producer failed'}),
      ]),
    );
  });
});

describe('RequestDrivenMetricReader lifecycle', () => {
  let exporter: FakeExporter;
  let clock: FakeClock;
  let reader: RequestDrivenMetricReader;
  let provider: MeterProvider;

  beforeEach(() => {
    exporter = new FakeExporter();
    clock = new FakeClock();
    reader = new RequestDrivenMetricReader(exporter, {
      exportIntervalMillis: PERIOD_MS,
      floorMillis: FLOOR_MS,
      now: clock.now,
    });
    provider = meterProviderWith(reader);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collects and flushes the exporter on forceFlush', async () => {
    await reader.forceFlush();

    expect(exporter.exports).toHaveLength(1);
    expect(exporter.forceFlushCalls).toBe(1);
    await provider.shutdown();
  });

  it('drains a queued collect, runs a final one, then shuts the exporter down', async () => {
    let release = () => {};
    exporter.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = reader.submitCollect();
    release();

    await reader.shutdown();

    await queued;
    expect(exporter.exports).toHaveLength(2);
    expect(exporter.shutdownCalls).toBe(1);
  });

  it('ignores a second shutdown', async () => {
    await reader.shutdown();
    await reader.shutdown();

    expect(exporter.exports).toHaveLength(1);
    expect(exporter.shutdownCalls).toBe(1);
  });

  it('refuses to schedule after shutdown and releases the collect guard', async () => {
    await reader.shutdown();
    clock.t = 10 * FLOOR_MS;
    expect(reader.noteRequestStart()).toBe(false);
    expect(reader.noteRequestEnd()).toBe(true);

    expect(reader.submitCollect()).toBeUndefined();

    // The guard was released, so a later hook still arms.
    clock.t = 20 * FLOOR_MS;
    expect(reader.noteRequestStart()).toBe(false);
    expect(reader.noteRequestEnd()).toBe(true);
  });

  it('does not arm a second collect while one is already committed', async () => {
    expect(reader.noteRequestStart()).toBe(false);
    clock.t = FLOOR_MS;
    // Armed, but deliberately not submitted, so the collect stays committed.
    expect(reader.noteRequestEnd()).toBe(true);
    expect(reader.noteRequestStart()).toBe(false);

    // Overlapping and past a guidepost, which would otherwise arm a collect.
    clock.t = 2 * PERIOD_MS;
    expect(reader.noteRequestStart()).toBe(false);

    await provider.shutdown();
  });

  it('clamps the in-flight count at zero', async () => {
    // More ends than starts must not drive the count negative, or the drain
    // condition `inFlight === 0` would stop matching.
    expect(reader.noteRequestEnd()).toBe(true);
    await reader.submitCollect();

    clock.t = FLOOR_MS;
    expect(reader.noteRequestEnd()).toBe(true);
    await provider.shutdown();
  });
});

describe('RequestDrivenMetricReader configuration', () => {
  const clock = new FakeClock();

  beforeEach(() => {
    clock.t = 0;
    delete process.env[INTERVAL_ENV];
    delete process.env[TIMEOUT_ENV];
  });

  afterEach(() => {
    delete process.env[INTERVAL_ENV];
    delete process.env[TIMEOUT_ENV];
    vi.restoreAllMocks();
  });

  /** Answers whether a guidepost at 11000 fires, which pins the period. */
  function guidepostFiresAt11s(
    options: {exportIntervalMillis?: number} = {},
  ): boolean {
    const reader = new RequestDrivenMetricReader(new FakeExporter(), {
      floorMillis: FLOOR_MS,
      now: clock.now,
      ...options,
    });
    reader.noteRequestStart();
    clock.t = 11_000;
    return reader.noteRequestStart();
  }

  it('reads the guidepost period from the environment', () => {
    process.env[INTERVAL_ENV] = '10000';

    expect(guidepostFiresAt11s()).toBe(true);
  });

  it('falls back to the default period on an invalid interval', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env[INTERVAL_ENV] = 'abc';

    // The default period is 60000, so a guidepost at 11000 has not arrived.
    expect(guidepostFiresAt11s()).toBe(false);
  });

  it('prefers an explicit period over the environment', () => {
    process.env[INTERVAL_ENV] = '10000';

    expect(guidepostFiresAt11s({exportIntervalMillis: 60_000})).toBe(false);
  });

  /** Returns the timeout the reader passed to `collect`. */
  async function collectTimeout(
    options: {exportTimeoutMillis?: number} = {},
  ): Promise<number | undefined> {
    const reader = new RequestDrivenMetricReader(new FakeExporter(), {
      now: clock.now,
      ...options,
    });
    const provider = new MeterProvider({readers: [reader]});
    const collectSpy = vi.spyOn(reader, 'collect');

    await reader.submitCollect();
    await provider.shutdown();

    return collectSpy.mock.calls[0][0]?.timeoutMillis;
  }

  it('defaults the collect timeout when the environment is unset', async () => {
    await expect(collectTimeout()).resolves.toBe(30_000);
  });

  it('reads the collect timeout from the environment', async () => {
    process.env[TIMEOUT_ENV] = '15000';

    await expect(collectTimeout()).resolves.toBe(15_000);
  });

  it('prefers an explicit collect timeout over the environment', async () => {
    process.env[TIMEOUT_ENV] = '15000';

    await expect(collectTimeout({exportTimeoutMillis: 45_000})).resolves.toBe(
      45_000,
    );
  });

  it.each([
    ['an empty value', ''],
    ['a blank value', '  '],
    ['a non-numeric value', 'abc'],
    ['a non-finite value', 'Infinity'],
  ])('rejects %s for the collect timeout', async (_label, raw) => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env[TIMEOUT_ENV] = raw;

    await expect(collectTimeout()).resolves.toBe(30_000);

    expect(warnSpy).toHaveBeenCalledWith(
      `Found invalid value for ${TIMEOUT_ENV}=${raw}, using default 30000`,
    );
  });

  it('accepts a negative collect timeout, as adk-python does', async () => {
    process.env[TIMEOUT_ENV] = '-1';

    await expect(collectTimeout()).resolves.toBe(-1);
  });

  it('defers temporality and aggregation to the exporter', () => {
    const exporter = new FakeExporter() as PushMetricExporter;
    exporter.selectAggregationTemporality = () => AggregationTemporality.DELTA;
    exporter.selectAggregation = () => ({type: AggregationType.LAST_VALUE});

    const reader = new RequestDrivenMetricReader(exporter);

    expect(reader.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(
      AggregationTemporality.DELTA,
    );
    expect(reader.selectAggregation(InstrumentType.COUNTER)).toEqual({
      type: AggregationType.LAST_VALUE,
    });
  });
});

describe('buildRequestDrivenMetrics', () => {
  let exporter: FakeExporter;
  let clock: FakeClock;
  let reader: RequestDrivenMetricReader;
  let spanProcessor: SpanProcessor;
  let meterProvider: MeterProvider;
  let tracerProvider: BasicTracerProvider;

  /** Wires a real tracer and meter around a reader driven by a fake clock. */
  function build(options: {inferenceSpanName?: string} = {}): void {
    exporter = new FakeExporter();
    clock = new FakeClock();
    ({reader, spanProcessor} = buildRequestDrivenMetrics(exporter, {
      exportIntervalMillis: PERIOD_MS,
      floorMillis: FLOOR_MS,
      now: clock.now,
      ...options,
    }));
    meterProvider = meterProviderWith(reader);
    tracerProvider = new BasicTracerProvider({spanProcessors: [spanProcessor]});
  }

  /** Opens a request, then a span, at a time point 4 considers overdue. */
  function spanDuringOverdueRequest(
    name: string,
    attributes: Record<string, string> = {},
  ): void {
    reader.noteRequestStart();
    clock.t = 2 * PERIOD_MS;
    tracerProvider.getTracer('test').startSpan(name, {attributes}).end();
  }

  beforeEach(() => {
    build();
  });

  afterEach(async () => {
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
    vi.restoreAllMocks();
  });

  it('sets no global meter provider', () => {
    const before = metrics.getMeterProvider();

    buildRequestDrivenMetrics(new FakeExporter());

    expect(metrics.getMeterProvider()).toBe(before);
  });

  it('collects on a call_llm span start', async () => {
    spanDuringOverdueRequest('call_llm');

    await vi.waitFor(() => expect(exporter.exports).toHaveLength(1));
  });

  it('collects on a span carrying the GenAI operation name', async () => {
    spanDuringOverdueRequest('some_wrapper_span', {
      'gen_ai.operation.name': 'call_llm',
    });

    await vi.waitFor(() => expect(exporter.exports).toHaveLength(1));
  });

  it('ignores a span that is neither', async () => {
    spanDuringOverdueRequest('execute_tool');

    await new Promise((resolve) => setImmediate(resolve));
    expect(exporter.exports).toEqual([]);
  });

  it('honours a configured inference span name', async () => {
    build({inferenceSpanName: 'generate_content'});

    spanDuringOverdueRequest('generate_content');

    await vi.waitFor(() => expect(exporter.exports).toHaveLength(1));
  });

  it('ignores the default span name once one is configured', async () => {
    build({inferenceSpanName: 'generate_content'});

    spanDuringOverdueRequest('call_llm');

    await new Promise((resolve) => setImmediate(resolve));
    expect(exporter.exports).toEqual([]);
  });

  it('logs a throwing span-start hook instead of breaking the span', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    let ticks = 0;
    ({reader, spanProcessor} = buildRequestDrivenMetrics(exporter, {
      now: () => {
        // The constructor reads the clock once; every later read fails.
        if (ticks++ > 0) {
          throw new Error('clock failed');
        }
        return 0;
      },
    }));
    tracerProvider = new BasicTracerProvider({spanProcessors: [spanProcessor]});

    const span = tracerProvider.getTracer('test').startSpan('call_llm');

    expect(span.isRecording()).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      'Metrics span-start hook failed',
      expect.objectContaining({message: 'clock failed'}),
    );
    span.end();
  });

  it('resolves its no-op lifecycle methods', async () => {
    await expect(spanProcessor.forceFlush()).resolves.toBeUndefined();
    await expect(spanProcessor.shutdown()).resolves.toBeUndefined();
  });
});
