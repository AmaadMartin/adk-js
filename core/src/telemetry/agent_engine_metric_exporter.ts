/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Request-driven, sleepless metric export.
 *
 * A metric reader (plus the span processor that drives it) that exports
 * metrics from an agent running on the Vertex AI Agent Engine request-billed
 * runtime, without adding latency to any request.
 *
 * The Agent Engine runtime throttles CPU the instant a request finishes. A
 * normal metric pipeline exports on a background timer, and between requests
 * that timer gets no CPU, so its periodic export is starved and metric points
 * are dropped. This reader has no timer: it collects only when the request
 * path tells it to.
 *
 * Three invariants shape the design:
 *
 * - I1, export only while serving. Every collect runs while a request is in
 *   flight, the only time CPU is guaranteed.
 * - I2, never collect more often than the floor. A collect that would land
 *   closer than {@link MIN_EXPORT_INTERVAL_MS} to the previous one is skipped.
 * - I3, never collect too rarely. A single export carries a bounded number of
 *   points, so a guidepost grid forces a collect under sustained load.
 *
 * The configured export period is demoted from a hard schedule to that
 * guidepost grid: hint times used to decide whether an event-driven collect is
 * warranted.
 *
 * The loss case this accepts: a request shorter than the floor that drains
 * right after a collect, and is the last request before the process goes idle,
 * loses its points. A collect now is muted by the floor (I2), and the next
 * collect never comes.
 *
 * The middleware that drives this reader from the request lifecycle lives in
 * `./agent_engine.js`.
 *
 * Ported from adk-python
 * `src/google/adk/telemetry/_agent_engine_metric_exporter.py`.
 */

import {ExportResultCode} from '@opentelemetry/core';
import {
  MetricReader,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {Span, SpanProcessor} from '@opentelemetry/sdk-trace-base';

import {logger} from '../utils/logger.js';

/**
 * The minimum spacing between two metric exports, shared by every ADK metric
 * reader: the collect floor (I2) of the request-driven reader here, and the
 * export interval of the periodic reader in `./google_cloud.js`.
 *
 * Exporting faster than this risks points being rejected or throttled. Keep
 * new readers at or above it.
 */
export const MIN_EXPORT_INTERVAL_MS = 5000;

/** Environment variable overriding the collect floor, in milliseconds. */
const AGENT_ENGINE_METRICS_FLOOR_ENV =
  'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS';

/** Environment variable holding the guidepost period, in milliseconds. */
const OTEL_METRIC_EXPORT_INTERVAL_ENV = 'OTEL_METRIC_EXPORT_INTERVAL';

/** Environment variable holding the export timeout, in milliseconds. */
const OTEL_METRIC_EXPORT_TIMEOUT_ENV = 'OTEL_METRIC_EXPORT_TIMEOUT';

const DEFAULT_EXPORT_INTERVAL_MS = 60000;
const DEFAULT_EXPORT_TIMEOUT_MS = 30000;

/**
 * How far past the guidepost period a busy stretch must run before a
 * `generate_content` span start is allowed to collect (point 4).
 */
const OVERDUE_PERIOD_FACTOR = 1.5;

/** Semantic-convention attribute carrying the GenAI operation name. */
const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

/** The GenAI operation whose span starts drive a point-4 collect. */
const GENERATE_CONTENT_OPERATION = 'generate_content';

/** Reads a numeric environment variable, falling back to `fallback`. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  // `Number('')` is 0, which would silently disable the interval it sets.
  const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(
      `Found invalid value for ${name}=${JSON.stringify(raw)}, using default ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/** Exports one collected batch, resolving when the exporter reports back. */
function exportMetrics(
  exporter: PushMetricExporter,
  metrics: ResourceMetrics,
): Promise<void> {
  return new Promise((resolve, reject) => {
    exporter.export(metrics, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        resolve();
        return;
      }
      reject(result.error ?? new Error('Metric export failed'));
    });
  });
}

/** Options overriding the reader's timings, mainly for tests. */
export interface RequestDrivenMetricReaderOptions {
  /** Guidepost period in milliseconds. */
  exportIntervalMillis?: number;
  /** Collect timeout in milliseconds. */
  exportTimeoutMillis?: number;
  /** Minimum spacing between two collects, in milliseconds. */
  floorMillis?: number;
  /** Monotonic clock in milliseconds. */
  now?: () => number;
}

/**
 * The hooks the request path calls to decide whether a collect is warranted.
 *
 * The middleware takes this interface rather than the concrete reader, so a
 * test can drive it with a spy.
 */
export interface RequestDrivenMetricReaderHooks {
  /** Called when a request enters. Returns true when a collect is warranted. */
  noteRequestStart(): boolean;
  /** Called when a request ends. Returns true when a collect is warranted. */
  noteRequestEnd(): boolean;
  /** Called on a `generate_content` span start (point 4). */
  noteGenerateContentStart(): boolean;
  /** Runs a committed collect, or returns undefined during shutdown. */
  submitCollect(): Promise<void> | undefined;
}

/** A `MetricReader` whose collects are driven by the request lifecycle. */
export class RequestDrivenMetricReader
  extends MetricReader
  implements RequestDrivenMetricReaderHooks
{
  private readonly exporter: PushMetricExporter;
  private readonly now: () => number;
  private readonly periodMs: number;
  private readonly floorMs: number;
  private readonly timeoutMs: number;

  private inFlight = 0;
  private lastCollect: number | undefined;
  /**
   * Start of the current busy period, stamped when in-flight goes 0 to 1. The
   * point-4 reference for the current stretch of activity, so a collect from a
   * long-past busy period cannot make a short request look overdue.
   */
  private busyStart: number;
  private collecting = false;
  private nextDue: number;
  private shuttingDown = false;
  /** Serializes collects, so two never overlap and timestamps stay ordered. */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    exporter: PushMetricExporter,
    options: RequestDrivenMetricReaderOptions = {},
  ) {
    // Defer temporality and aggregation to the wrapped exporter, exactly as
    // PeriodicExportingMetricReader does.
    super({
      aggregationSelector: exporter.selectAggregation?.bind(exporter),
      aggregationTemporalitySelector:
        exporter.selectAggregationTemporality?.bind(exporter),
    });
    this.exporter = exporter;
    this.now = options.now ?? (() => performance.now());
    this.periodMs =
      options.exportIntervalMillis ??
      envNumber(OTEL_METRIC_EXPORT_INTERVAL_ENV, DEFAULT_EXPORT_INTERVAL_MS);
    this.timeoutMs =
      options.exportTimeoutMillis ??
      envNumber(OTEL_METRIC_EXPORT_TIMEOUT_ENV, DEFAULT_EXPORT_TIMEOUT_MS);
    this.floorMs =
      options.floorMillis ??
      envNumber(AGENT_ENGINE_METRICS_FLOOR_ENV, MIN_EXPORT_INTERVAL_MS);
    this.busyStart = this.now();
    this.nextDue = this.busyStart + this.periodMs;
  }

  private due(now: number): boolean {
    return now >= this.nextDue;
  }

  private floorOk(now: number): boolean {
    return (
      this.lastCollect === undefined || now - this.lastCollect >= this.floorMs
    );
  }

  private overdue15(now: number): boolean {
    const reference =
      this.lastCollect === undefined
        ? this.busyStart
        : Math.max(this.busyStart, this.lastCollect);
    return now - reference >= OVERDUE_PERIOD_FACTOR * this.periodMs;
  }

  /**
   * Commits to a collect: marks it in flight and advances the guidepost grid.
   *
   * Does not stamp `lastCollect`. That happens at the actual collect, so the
   * floor constrains real collect spacing rather than decision spacing.
   */
  private arm(now: number): void {
    this.collecting = true;
    if (now >= this.nextDue) {
      const missed = Math.floor((now - this.nextDue) / this.periodMs) + 1;
      this.nextDue += missed * this.periodMs;
    }
  }

  noteRequestStart(): boolean {
    const now = this.now();
    const overlap = this.inFlight >= 1;
    if (!overlap) {
      this.busyStart = now;
    }
    this.inFlight += 1;
    if (this.collecting) {
      return false;
    }
    if (overlap && this.due(now)) {
      if (this.floorOk(now)) {
        this.arm(now);
        return true;
      }
      // Point 3: a guidepost too close to the last collect is muted.
      this.nextDue += this.periodMs;
    }
    return false;
  }

  noteRequestEnd(): boolean {
    const now = this.now();
    this.inFlight -= 1;
    if (this.inFlight < 0) {
      this.inFlight = 0;
    }
    if (this.inFlight === 0 && !this.collecting && this.floorOk(now)) {
      this.arm(now);
      return true;
    }
    return false;
  }

  noteGenerateContentStart(): boolean {
    const now = this.now();
    if (
      !this.collecting &&
      this.inFlight >= 1 &&
      this.overdue15(now) &&
      this.floorOk(now)
    ) {
      this.arm(now);
      return true;
    }
    return false;
  }

  submitCollect(): Promise<void> | undefined {
    if (this.shuttingDown) {
      this.collecting = false;
      return undefined;
    }
    this.pending = this.pending.then(() => this.collectNow());
    return this.pending;
  }

  /** Runs one collect and export. Never rejects. */
  private async collectNow(): Promise<void> {
    this.lastCollect = this.now();
    try {
      const {resourceMetrics, errors} = await this.collect({
        timeoutMillis: this.timeoutMs,
      });
      if (errors.length > 0) {
        logger.warn('Errors during request-driven metric collect', ...errors);
      }
      if (resourceMetrics.scopeMetrics.length > 0) {
        await exportMetrics(this.exporter, resourceMetrics);
      }
    } catch (e: unknown) {
      logger.error('Exception during request-driven metric collect', e);
    } finally {
      this.collecting = false;
    }
  }

  /** Runs a collect, then flushes the wrapped exporter. */
  protected async onForceFlush(): Promise<void> {
    this.pending = this.pending.then(() => this.collectNow());
    await this.pending;
    await this.exporter.forceFlush();
  }

  /** Drains the collects in flight, collects once more, then shuts down. */
  protected async onShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.pending;
    await this.collectNow();
    await this.exporter.shutdown();
  }
}

/** Fires a collect on each `generate_content` span start (point 4). */
class MetricsFlushingSpanProcessor implements SpanProcessor {
  constructor(private readonly reader: RequestDrivenMetricReaderHooks) {}

  onStart(span: Span): void {
    // onStart runs inside span creation, on the inference path. A metrics
    // failure must not break the span it observes.
    try {
      const operation = span.attributes[GEN_AI_OPERATION_NAME];
      if (
        (operation === GENERATE_CONTENT_OPERATION ||
          span.name.startsWith(GENERATE_CONTENT_OPERATION)) &&
        this.reader.noteGenerateContentStart()
      ) {
        void this.reader.submitCollect();
      }
    } catch (e: unknown) {
      logger.error('Metrics span-start hook failed', e);
    }
  }

  onEnd(): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/** The metric-export handles the app wires up. */
export interface MetricsState {
  /** Installed on the `MeterProvider`. */
  reader: RequestDrivenMetricReader;
  /** Installed on the `TracerProvider`. */
  spanProcessor: SpanProcessor;
}

/**
 * Builds the request-driven reader and the span processor that drives it.
 *
 * This sets no global provider. The caller installs `reader` on a
 * `MeterProvider` and `spanProcessor` on the `TracerProvider`, and drives the
 * reader from the request path.
 *
 * @param exporter The exporter the reader drains into on each collect.
 */
export function buildRequestDrivenMetrics(
  exporter: PushMetricExporter,
  options?: RequestDrivenMetricReaderOptions,
): MetricsState {
  const reader = new RequestDrivenMetricReader(exporter, options);
  return {reader, spanProcessor: new MetricsFlushingSpanProcessor(reader)};
}
