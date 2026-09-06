/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The fake-clock harness shared by the request-driven metric reader suites.
 *
 * Ported from `_Harness` in
 * `tests/unittests/telemetry/test_agent_engine_metric_exporter.py` on
 * google/adk-python `main`. There is no real time and no network here. The
 * reader reads its clock from a mutable field, and a hook that answers "collect
 * now" is followed by an awaited collect, so the recorded export time is the
 * fake clock's current value.
 *
 * Every timestamp is in milliseconds. The reference works in seconds, so its
 * numbers appear here scaled by 1000.
 */

import {RequestDrivenMetricReader} from '@google/adk';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {
  MeterProvider,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {expect} from 'vitest';

/** Guidepost grid spacing used by the scenario suite (the reference's 10 s). */
export const PERIOD_MS = 10_000;

/** Collect floor used by the scenario suite (the reference's 3 s). */
export const FLOOR_MS = 3_000;

/** Records the fake-clock time of every export. */
export class RecordingExporter implements PushMetricExporter {
  readonly times: number[] = [];

  constructor(private readonly now: () => number) {}

  export(
    _metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.times.push(this.now());
    resultCallback({code: ExportResultCode.SUCCESS});
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** A request's in-flight window. */
export interface RequestWindow {
  start: number;
  end: number;
}

/** Overrides for a {@link Harness}. */
export interface HarnessOptions {
  /** Guidepost grid spacing in milliseconds. */
  periodMs?: number;
  /**
   * Collect floor in milliseconds. Pass null to let the reader resolve the
   * floor from the environment, which is how the floor tests observe it.
   */
  floorMs?: number | null;
}

/** Drives a reader with a fake clock, recording collects and request windows. */
export class Harness {
  /** The fake clock, in milliseconds. Move it with {@link at}. */
  t = 0;

  readonly exporter: RecordingExporter;
  readonly reader: RequestDrivenMetricReader;
  readonly windows: RequestWindow[] = [];

  private readonly meterProvider: MeterProvider;
  private readonly open = new Map<string, number>();

  constructor({periodMs = PERIOD_MS, floorMs = FLOOR_MS}: HarnessOptions = {}) {
    this.exporter = new RecordingExporter(() => this.t);
    this.reader = new RequestDrivenMetricReader(this.exporter, {
      exportIntervalMillis: periodMs,
      floorMillis: floorMs ?? undefined,
      now: () => this.t,
    });
    this.meterProvider = new MeterProvider({readers: [this.reader]});
    // A cumulative counter with a recorded value, so every collect has
    // something to export; an empty collect exports nothing.
    this.meterProvider.getMeter('test').createCounter('c').add(1);
  }

  /** Moves the fake clock to `when`. */
  at(when: number): this {
    this.t = when;
    return this;
  }

  async start(rid: string): Promise<void> {
    this.open.set(rid, this.t);
    if (this.reader.noteRequestStart()) {
      await this.reader.submitCollect();
    }
  }

  async end(rid: string): Promise<void> {
    const start = this.open.get(rid);
    if (start === undefined) {
      expect.fail(`request ${rid} was never started`);
    }
    this.open.delete(rid);
    this.windows.push({start, end: this.t});
    if (this.reader.noteRequestEnd()) {
      await this.reader.submitCollect();
    }
  }

  async generateContent(): Promise<void> {
    if (this.reader.noteGenerateContentStart()) {
      await this.reader.submitCollect();
    }
  }

  /** The fake-clock time of every collect so far. */
  get collects(): number[] {
    return [...this.exporter.times];
  }

  close(): Promise<void> {
    return this.meterProvider.shutdown();
  }
}
