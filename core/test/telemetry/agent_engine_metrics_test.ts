/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildRequestDrivenMetrics,
  getRequestDrivenMetricsState,
  MetricsFlushingSpanProcessor,
  MIN_EXPORT_INTERVAL_MS,
  RequestDrivenMetricReader,
} from '@google/adk';
import {metrics} from '@opentelemetry/api';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {Resource, resourceFromAttributes} from '@opentelemetry/resources';
import {
  AggregationOption,
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {BasicTracerProvider} from '@opentelemetry/sdk-trace-base';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const PERIOD = 10_000;
const FLOOR = 3_000;

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const FLOOR_ENV_VAR =
  'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS';

/** Records the fake-clock time of every export. */
class RecordingExporter implements PushMetricExporter {
  readonly times: number[] = [];
  shutdownCalls = 0;
  forceFlushCalls = 0;
  result: ExportResult = {code: ExportResultCode.SUCCESS};

  constructor(private readonly clock: () => number) {}

  export(
    metricsData: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    expect(metricsData.scopeMetrics.length).toBeGreaterThan(0);
    this.times.push(this.clock());
    resultCallback(this.result);
  }

  async forceFlush(): Promise<void> {
    this.forceFlushCalls += 1;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  selectAggregationTemporality?: (
    instrumentType: InstrumentType,
  ) => AggregationTemporality;

  selectAggregation?: (instrumentType: InstrumentType) => AggregationOption;
}

/** Drives a reader with a fake clock, recording collects and request windows. */
class Harness {
  private t = 0;
  readonly exporter: RecordingExporter;
  readonly reader: RequestDrivenMetricReader;
  readonly meterProvider: MeterProvider;
  readonly windows: Array<[number, number]> = [];
  private readonly open = new Map<string, number>();

  constructor(period = PERIOD, floor = FLOOR) {
    this.exporter = new RecordingExporter(() => this.t);
    this.reader = new RequestDrivenMetricReader({
      exporter: this.exporter,
      exportIntervalMillis: period,
      floorMillis: floor,
      now: () => this.t,
    });
    this.meterProvider = new MeterProvider({readers: [this.reader]});
    // A counter with a recorded value, so every collect has data to export.
    this.meterProvider.getMeter('test').createCounter('c').add(1);
  }

  at(when: number): this {
    this.t = when;
    return this;
  }

  async start(id: string): Promise<void> {
    this.open.set(id, this.t);
    if (this.reader.noteRequestStart()) {
      await this.reader.submitCollect();
    }
  }

  async end(id: string): Promise<void> {
    const started = this.open.get(id);
    if (started === undefined) {
      expect.fail(`request ${id} was never started`);
    }
    this.open.delete(id);
    this.windows.push([started, this.t]);
    if (this.reader.noteRequestEnd()) {
      await this.reader.submitCollect();
    }
  }

  async inference(): Promise<void> {
    if (this.reader.noteInferenceStart()) {
      await this.reader.submitCollect();
    }
  }

  get collects(): number[] {
    return [...this.exporter.times];
  }

  async close(): Promise<void> {
    await this.meterProvider.shutdown();
  }
}

async function baselineDrain(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  await h.at(5000).end('r1');
  expect(h.collects).toEqual([5000]);
  return h;
}

async function overlapBatched(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  await h.at(1000).start('r2');
  await h.at(2000).start('r3');
  await h.at(3000).end('r1');
  await h.at(4000).end('r2');
  await h.at(5000).end('r3');
  expect(h.collects).toEqual([5000]);
  return h;
}

async function guidepostConsumedByDrain(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  // Crosses the guidepost at 10000, but only drains here.
  await h.at(12000).end('r1');
  expect(h.collects).toEqual([12000]);
  return h;
}

async function guidepostFiresAtStart(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  await h.at(2000).start('r2');
  await h.at(4000).start('r3');
  // The guidepost at 10000 is crossed under overlap, so r4's start collects.
  await h.at(11000).start('r4');
  await h.at(12000).end('r1');
  await h.at(13000).end('r2');
  await h.at(14000).end('r3');
  await h.at(16000).end('r4');
  expect(h.collects).toEqual([11000, 16000]);
  return h;
}

async function guidepostMuted(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  await h.at(9000).end('r1');
  await h.at(9000).start('r2');
  // The guidepost is due, but 10000 - 9000 is under the floor, so it is muted.
  await h.at(10000).start('r3');
  await h.at(11000).end('r2');
  await h.at(12000).end('r3');
  expect(h.collects).toEqual([9000, 12000]);
  return h;
}

async function guidepostStaysMuted(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  await h.at(9000).end('r1');
  await h.at(9000).start('r2');
  // The guidepost at 10000 is muted, so it does not fire at a later start
  // either: the next guidepost is 20000.
  await h.at(10000).start('r3');
  await h.at(12500).start('r4');
  await h.at(13000).end('r2');
  await h.at(14000).end('r3');
  await h.at(15000).end('r4');
  expect(h.collects).toEqual([9000, 15000]);
  return h;
}

async function inferenceBackstop(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  await h.at(5000).inference(); // 5s into the busy period, under 1.5 * PERIOD.
  await h.at(10000).inference(); // 10s in, still under 15s.
  await h.at(21000).inference(); // 21s in, so collect.
  await h.at(30000).inference(); // 9s since the last collect.
  await h.at(37000).inference(); // 16s since the last collect, so collect.
  await h.at(40000).end('r1');
  expect(h.collects).toEqual([21000, 37000, 40000]);
  return h;
}

async function shortFirstRequestNotPreempted(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  // The first span of a short first request must not collect: that would stamp
  // the floor and mute the drain that carries the request's points.
  await h.at(2000).inference();
  await h.at(4000).end('r1');
  expect(h.collects).toEqual([4000]);
  return h;
}

async function subfloorSkip(): Promise<Harness> {
  const h = new Harness();
  await h.at(0).start('r1');
  await h.at(5000).end('r1');
  await h.at(6000).start('r2');
  // 6500 - 5000 is under the floor, so r2's points ride the next collect.
  await h.at(6500).end('r2');
  await h.at(9000).start('r3');
  await h.at(9000).end('r3');
  expect(h.collects).toEqual([5000, 9000]);
  return h;
}

const SCENARIOS: Array<[string, () => Promise<Harness>]> = [
  ['baseline_drain', baselineDrain],
  ['overlap_batched', overlapBatched],
  ['guidepost_consumed_by_drain', guidepostConsumedByDrain],
  ['guidepost_fires_at_start', guidepostFiresAtStart],
  ['guidepost_muted', guidepostMuted],
  ['guidepost_stays_muted', guidepostStaysMuted],
  ['inference_backstop', inferenceBackstop],
  ['short_first_request_not_preempted', shortFirstRequestNotPreempted],
  ['subfloor_skip', subfloorSkip],
];

describe('RequestDrivenMetricReader scenarios', () => {
  it.each(SCENARIOS)('%s honours I1 and I2', async (_name, scenario) => {
    const h = await scenario();
    try {
      const collects = h.collects;
      expect(collects.length).toBeGreaterThan(0);

      // I2: consecutive collects are at least FLOOR apart.
      for (let i = 1; i < collects.length; i++) {
        expect(collects[i] - collects[i - 1]).toBeGreaterThanOrEqual(FLOOR);
      }

      // I1: each collect lands inside some request window.
      for (const c of collects) {
        expect(h.windows.some(([start, end]) => start <= c && c <= end)).toBe(
          true,
        );
      }
    } finally {
      await h.close();
    }
  });

  it('creates no timer, so the scenarios need no fake timers', async () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const setTimeout = vi.spyOn(globalThis, 'setTimeout');
    const h = await baselineDrain();
    await h.close();
    expect(setInterval).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it('does not drive the in-flight count negative', async () => {
    const h = new Harness();
    try {
      // Two unmatched ends, as a double drain on one request would produce.
      h.at(0);
      if (h.reader.noteRequestEnd()) {
        await h.reader.submitCollect();
      }
      h.at(1000);
      if (h.reader.noteRequestEnd()) {
        await h.reader.submitCollect();
      }
      // A later overlapping pair still batches into one drain collect. An
      // unclamped count would leave r1's end looking like the last one.
      await h.at(4000).start('r1');
      await h.at(5000).start('r2');
      await h.at(6000).end('r1');
      await h.at(7000).end('r2');
      expect(h.collects).toEqual([0, 7000]);
    } finally {
      await h.close();
    }
  });
});

describe('RequestDrivenMetricReader floor configuration', () => {
  /**
   * Drives a request draining at 0 and another draining `gap` ms later, with
   * the floor left to the environment.
   */
  async function drainAfterGap(gap: number): Promise<number[]> {
    let t = 0;
    const exporter = new RecordingExporter(() => t);
    const reader = new RequestDrivenMetricReader({
      exporter,
      exportIntervalMillis: PERIOD,
      now: () => t,
    });
    const provider = new MeterProvider({readers: [reader]});
    provider.getMeter('test').createCounter('c').add(1);
    try {
      for (const when of [0, gap]) {
        t = when;
        reader.noteRequestStart();
        if (reader.noteRequestEnd()) {
          await reader.submitCollect();
        }
      }
      return [...exporter.times];
    } finally {
      await provider.shutdown();
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('collects again once the env floor has elapsed', async () => {
    vi.stubEnv(FLOOR_ENV_VAR, '1500');
    expect(await drainAfterGap(2000)).toEqual([0, 2000]);
  });

  it.each([
    ['an unparseable value', 'not-a-number'],
    ['a blank value', ''],
    ['no value', undefined],
  ])('falls back to the default floor for %s', async (_label, raw) => {
    vi.stubEnv(FLOOR_ENV_VAR, raw);
    expect(await drainAfterGap(2000)).toEqual([0]);
    // The same drive does collect once the default floor has elapsed.
    expect(await drainAfterGap(MIN_EXPORT_INTERVAL_MS)).toEqual([
      0,
      MIN_EXPORT_INTERVAL_MS,
    ]);
  });
});

describe('RequestDrivenMetricReader configuration', () => {
  it('defers temporality and aggregation to the exporter', () => {
    const exporter = new RecordingExporter(() => 0);
    const aggregation: AggregationOption = {
      type: AggregationType.LAST_VALUE,
    };
    exporter.selectAggregationTemporality = () => AggregationTemporality.DELTA;
    exporter.selectAggregation = () => aggregation;

    const reader = new RequestDrivenMetricReader({
      exporter,
      exportTimeoutMillis: 1234,
      now: () => 0,
    });

    expect(reader.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(
      AggregationTemporality.DELTA,
    );
    expect(reader.selectAggregation(InstrumentType.COUNTER)).toBe(aggregation);
  });
});

describe('RequestDrivenMetricReader export', () => {
  it('exports nothing when no instrument has recorded', async () => {
    const exporter = new RecordingExporter(() => 0);
    const reader = new RequestDrivenMetricReader({exporter, now: () => 0});
    const provider = new MeterProvider({readers: [reader]});
    reader.noteRequestStart();
    reader.noteRequestEnd();
    await reader.submitCollect();
    expect(exporter.times).toEqual([]);
    await provider.shutdown();
  });

  /** Builds a reader on a provider carrying `resource`, and drains it once. */
  async function drainWithResource(resource: Resource): Promise<number[]> {
    const exporter = new RecordingExporter(() => 0);
    const reader = new RequestDrivenMetricReader({exporter, now: () => 0});
    const provider = new MeterProvider({resource, readers: [reader]});
    provider.getMeter('test').createCounter('c').add(1);
    reader.noteRequestStart();
    reader.noteRequestEnd();
    await reader.submitCollect();
    const times = [...exporter.times];
    await provider.shutdown();
    return times;
  }

  it('resolves the async attributes of a pending resource', async () => {
    const resource = resourceFromAttributes({
      'test.attr': Promise.resolve('resolved'),
    });
    expect(resource.asyncAttributesPending).toBe(true);

    expect(await drainWithResource(resource)).toEqual([0]);
    expect(resource.asyncAttributesPending).toBe(false);
  });

  it('exports when a pending resource cannot report readiness', async () => {
    // `waitForAsyncAttributes` is optional on the Resource interface.
    const resource: Resource = {
      asyncAttributesPending: true,
      attributes: {},
      merge: () => resource,
      getRawAttributes: () => [],
    };
    expect(await drainWithResource(resource)).toEqual([0]);
  });

  it('reports a failed export without rejecting', async () => {
    const h = new Harness();
    h.exporter.result = {
      code: ExportResultCode.FAILED,
      error: new Error('boom'),
    };
    h.at(0);
    h.reader.noteRequestStart();
    h.reader.noteRequestEnd();
    await expect(h.reader.submitCollect()).resolves.toBeUndefined();
    expect(h.collects).toEqual([0]);
    await h.close();
  });

  it('reports a collection error without rejecting', async () => {
    const h = new Harness();
    h.meterProvider
      .getMeter('test')
      .createObservableCounter('broken')
      .addCallback(() => {
        throw new Error('observable failed');
      });
    h.at(0);
    h.reader.noteRequestStart();
    h.reader.noteRequestEnd();
    await expect(h.reader.submitCollect()).resolves.toBeUndefined();
    expect(h.collects).toEqual([0]);
    await h.close();
  });

  it('swallows a collect that throws', async () => {
    const exporter = new RecordingExporter(() => 0);
    const reader = new RequestDrivenMetricReader({exporter, now: () => 0});
    // The reader is bound to no MeterProvider, so `collect` throws.
    reader.noteRequestStart();
    reader.noteRequestEnd();
    await expect(reader.submitCollect()).resolves.toBeUndefined();
    expect(exporter.times).toEqual([]);
  });

  it('runs queued collects one at a time', async () => {
    // The floor guarantee relies on collects never overlapping, so the second
    // export must not start until the first has called back.
    const pending: Array<(result: ExportResult) => void> = [];
    let deferring = true;
    const exporter: PushMetricExporter = {
      export(_metricsData, resultCallback) {
        if (deferring) {
          pending.push(resultCallback);
          return;
        }
        resultCallback({code: ExportResultCode.SUCCESS});
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    const reader = new RequestDrivenMetricReader({exporter, now: () => 0});
    const provider = new MeterProvider({readers: [reader]});
    provider.getMeter('test').createCounter('c').add(1);

    const first = reader.submitCollect();
    const second = reader.submitCollect();

    await vi.waitFor(() => expect(pending.length).toBe(1));
    pending[0]({code: ExportResultCode.SUCCESS});
    await first;
    await vi.waitFor(() => expect(pending.length).toBe(2));
    pending[1]({code: ExportResultCode.SUCCESS});
    await second;

    deferring = false;
    await provider.shutdown();
  });

  it('collects and flushes the exporter on force flush', async () => {
    const h = new Harness();
    h.at(0);
    h.reader.noteRequestStart();
    h.reader.noteRequestEnd();
    await h.reader.forceFlush();
    expect(h.collects).toEqual([0]);
    expect(h.exporter.forceFlushCalls).toBe(1);
    await h.close();
  });

  it('exports once more on shutdown and ignores a second shutdown', async () => {
    const h = new Harness();
    await h.at(0).start('r1');
    await h.at(5000).end('r1');
    expect(h.collects).toEqual([5000]);

    h.at(6000);
    await h.reader.shutdown();
    expect(h.collects).toEqual([5000, 6000]);
    expect(h.exporter.shutdownCalls).toBe(1);

    await h.reader.shutdown();
    expect(h.collects).toEqual([5000, 6000]);
    expect(h.exporter.shutdownCalls).toBe(1);
  });

  it('resolves a collect submitted during shutdown without exporting', async () => {
    const h = new Harness();
    h.at(0);
    await h.reader.shutdown();
    const exportsAfterShutdown = h.collects.length;

    h.reader.noteRequestStart();
    h.reader.noteRequestEnd();
    await expect(h.reader.submitCollect()).resolves.toBeUndefined();
    expect(h.collects.length).toBe(exportsAfterShutdown);
  });

  it('reports a final collect failure on shutdown without rejecting', async () => {
    const exporter = new RecordingExporter(() => 0);
    // The reader is bound to no MeterProvider, so the final collect throws.
    const reader = new RequestDrivenMetricReader({exporter, now: () => 0});
    await expect(reader.shutdown()).resolves.toBeUndefined();
    expect(exporter.times).toEqual([]);
    expect(exporter.shutdownCalls).toBe(1);
  });
});

describe('MetricsFlushingSpanProcessor', () => {
  class SpyDriver {
    noteInferenceStartCalls = 0;
    submitCalls = 0;
    result = true;
    throwOnNote = false;

    noteInferenceStart(): boolean {
      this.noteInferenceStartCalls += 1;
      if (this.throwOnNote) {
        throw new Error('note failed');
      }
      return this.result;
    }

    async submitCollect(): Promise<void> {
      this.submitCalls += 1;
    }
  }

  let driver: SpyDriver;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    driver = new SpyDriver();
    provider = new BasicTracerProvider({
      spanProcessors: [new MetricsFlushingSpanProcessor(driver)],
    });
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it('collects on an inference span start', () => {
    provider.getTracer('test').startSpan('call_llm').end();
    expect(driver.noteInferenceStartCalls).toBe(1);
    expect(driver.submitCalls).toBe(1);
  });

  it('ignores a span that is not an inference span', () => {
    provider.getTracer('test').startSpan('invoke_agent my_agent').end();
    expect(driver.noteInferenceStartCalls).toBe(0);
    expect(driver.submitCalls).toBe(0);
  });

  it('does not collect when the reader declines', () => {
    driver.result = false;
    provider.getTracer('test').startSpan('call_llm').end();
    expect(driver.noteInferenceStartCalls).toBe(1);
    expect(driver.submitCalls).toBe(0);
  });

  it('does not break span creation when the reader throws', () => {
    driver.throwOnNote = true;
    expect(() =>
      provider.getTracer('test').startSpan('call_llm').end(),
    ).not.toThrow();
    expect(driver.submitCalls).toBe(0);
  });

  it('resolves shutdown and force flush', async () => {
    const processor = new MetricsFlushingSpanProcessor(driver);
    processor.onEnd();
    await expect(processor.shutdown()).resolves.toBeUndefined();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });
});

describe('buildRequestDrivenMetrics', () => {
  it('returns a reader that drains into the given exporter', async () => {
    const exporter = new RecordingExporter(() => 0);
    const state = buildRequestDrivenMetrics(exporter);
    expect(state.reader).toBeInstanceOf(RequestDrivenMetricReader);
    expect(state.spanProcessor).toBeInstanceOf(MetricsFlushingSpanProcessor);

    const provider = new MeterProvider({readers: [state.reader]});
    provider.getMeter('test').createCounter('c').add(1);
    state.reader.noteRequestStart();
    if (state.reader.noteRequestEnd()) {
      await state.reader.submitCollect();
    }
    expect(exporter.times.length).toBe(1);
    await provider.shutdown();
  });
});

describe('getAgentEngineMetricsSetup', () => {
  /** Imports a fresh copy, so the module-level memo is reset. */
  async function freshModule() {
    vi.resetModules();
    return import('../../src/telemetry/agent_engine_metrics.js');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    metrics.disable();
  });

  it('returns undefined and never builds an exporter off Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);
    const mod = await freshModule();
    const createExporter = vi.fn();
    expect(mod.getAgentEngineMetricsSetup(createExporter)).toBeUndefined();
    expect(createExporter).not.toHaveBeenCalled();
  });

  it('returns a wired state on Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, 'engine-id');
    const mod = await freshModule();
    expect(mod.getRequestDrivenMetricsState()).toBeUndefined();

    const exporter = new RecordingExporter(() => 0);
    const state = mod.getAgentEngineMetricsSetup(() => exporter);
    if (!state) {
      expect.fail('expected a metrics state on Agent Engine');
    }
    expect(state.reader).toBeInstanceOf(mod.RequestDrivenMetricReader);
    expect(state.spanProcessor).toBeInstanceOf(
      mod.MetricsFlushingSpanProcessor,
    );
    expect(mod.getRequestDrivenMetricsState()).toBe(state);
  });

  it('evaluates the gate once', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, 'engine-id');
    const mod = await freshModule();
    const exporter = new RecordingExporter(() => 0);
    const state = mod.getAgentEngineMetricsSetup(() => exporter);
    const again = mod.getAgentEngineMetricsSetup(() => {
      throw new Error('must not be called again');
    });
    expect(again).toBe(state);
  });

  it('returns undefined when a MeterProvider is already installed', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, 'engine-id');
    const installed = new MeterProvider();
    metrics.setGlobalMeterProvider(installed);
    const mod = await freshModule();
    const createExporter = vi.fn();
    expect(mod.getAgentEngineMetricsSetup(createExporter)).toBeUndefined();
    expect(createExporter).not.toHaveBeenCalled();
    await installed.shutdown();
  });

  it('returns undefined when the exporter cannot be built', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, 'engine-id');
    const mod = await freshModule();
    const state = mod.getAgentEngineMetricsSetup(() => {
      throw new Error('no credentials');
    });
    expect(state).toBeUndefined();
    expect(mod.getRequestDrivenMetricsState()).toBeUndefined();
  });
});

describe('getRequestDrivenMetricsState', () => {
  it('is undefined when the setup never ran', () => {
    expect(getRequestDrivenMetricsState()).toBeUndefined();
  });
});
