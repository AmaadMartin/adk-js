/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared fake-clock harness for the request-driven metric reader tests.
 *
 * Ported from `_Harness` in adk-python
 * `tests/unittests/telemetry/test_agent_engine_metric_exporter.py` @ main
 * (a119dd77). Every Python second becomes a millisecond value here, because
 * every OpenTelemetry JS timing knob is in milliseconds.
 *
 * Collects are driven inline: a hook that answers true is followed by an
 * awaited `collectNow()`, so the fake clock stamps the export deterministically.
 */

import {RequestDrivenMetricReader} from '@google/adk';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {
  MeterProvider,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {expect} from 'vitest';

/** Guidepost grid spacing used by the scenario tests, in milliseconds. */
export const PERIOD_MS = 10_000;

/** Collect floor used by the scenario tests, in milliseconds. */
export const FLOOR_MS = 3_000;

/** Records the fake-clock time of every export. */
export class RecordingExporter implements PushMetricExporter {
  readonly times: number[] = [];

  constructor(private readonly clock: () => number) {}

  export(
    _metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.times.push(this.clock());
    resultCallback({code: ExportResultCode.SUCCESS});
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Drives a reader with a fake clock, recording collects and request windows. */
export class Harness {
  readonly exporter: RecordingExporter;
  readonly reader: RequestDrivenMetricReader;
  /** The `[start, end]` window of every request that has ended. */
  readonly windows: Array<[number, number]> = [];

  private t = 0;
  private readonly open = new Map<string, number>();
  private readonly meterProvider: MeterProvider;

  constructor(periodMs: number = PERIOD_MS, floorMs: number = FLOOR_MS) {
    this.exporter = new RecordingExporter(() => this.t);
    this.reader = new RequestDrivenMetricReader(this.exporter, {
      exportIntervalMillis: periodMs,
      floorMillis: floorMs,
      now: () => this.t,
    });
    this.meterProvider = new MeterProvider({readers: [this.reader]});
    // A cumulative counter with a recorded value, so every collect has data to
    // export. An empty collect exports nothing.
    this.meterProvider.getMeter('test').createCounter('c').add(1);
  }

  /** Moves the fake clock to `when` milliseconds. */
  at(when: number): this {
    this.t = when;
    return this;
  }

  async start(rid: string): Promise<void> {
    this.open.set(rid, this.t);
    if (this.reader.noteRequestStart()) {
      await this.reader.collectNow();
    }
  }

  async end(rid: string): Promise<void> {
    const startedAt = this.open.get(rid);
    if (startedAt === undefined) {
      expect.fail(`end() called for a request that never started: ${rid}`);
    }
    this.open.delete(rid);
    this.windows.push([startedAt, this.t]);
    if (this.reader.noteRequestEnd()) {
      await this.reader.collectNow();
    }
  }

  async generateContent(): Promise<void> {
    if (this.reader.noteGenerateContentStart()) {
      await this.reader.collectNow();
    }
  }

  /** The fake-clock time of every export so far. */
  get collects(): number[] {
    return [...this.exporter.times];
  }

  close(): Promise<void> {
    return this.meterProvider.shutdown();
  }
}
