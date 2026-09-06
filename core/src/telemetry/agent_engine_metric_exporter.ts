/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Request-driven metric export for the Vertex AI Agent Runtime.
 *
 * The runtime bills per request and throttles CPU the instant a request
 * finishes. A normal metric pipeline exports on a background timer, and between
 * requests that timer gets no CPU, so the periodic export is starved and metric
 * points are dropped. {@link RequestDrivenMetricReader} starts no timer: it
 * collects only when the request lifecycle tells it to.
 *
 * Three constraints shape the design.
 *
 * - I1, export only while serving. Every collect runs while a request is in
 *   flight, the only time CPU is guaranteed.
 * - I2, never collect more often than the floor. Two collects closer together
 *   than the floor are skipped.
 * - I3, never collect too rarely. One export carries a limited number of
 *   points, so the reader collects at least once per configured period.
 *
 * The configured export period is a grid of guideposts rather than a schedule.
 * A guidepost is a would-be collect time, used to decide whether an
 * event-driven collect is warranted. Four decision points drive the reader:
 *
 * 1. Baseline. When the in-flight count drains to zero, collect. This is gated
 *    on the floor only, never on a guidepost.
 * 2. Under continuous overlap the in-flight count never reaches zero, so a
 *    crossed guidepost fires at the next request start instead.
 * 3. A guidepost within the floor of the last collect is muted, and the grid
 *    advances by one period.
 * 4. A lone long request collects off its own inference span starts, once
 *    1.5 periods have passed since the reference point of the current busy
 *    period.
 *
 * One case still loses points, and that is accepted. A request shorter than the
 * floor that drains right after a collect, and is the last request before the
 * process goes idle, loses its points: a collect now is muted by the floor, and
 * no later request arrives to carry them.
 *
 * Apart from the collect at shutdown, every collect starts from a request hook,
 * and point 4 needs a request in flight. The host must therefore note each
 * request. This module ships the hooks; the request middleware that calls them
 * is not part of it.
 *
 * ```ts
 * const {reader, spanProcessor} = buildRequestDrivenMetrics(exporter);
 * maybeSetOtelProviders([{metricReaders: [reader], spanProcessors: [spanProcessor]}]);
 *
 * if (reader.noteRequestStart()) void reader.submitCollect();
 * // ... serve the request and stream the response body ...
 * if (reader.noteRequestEnd()) await reader.submitCollect();
 * ```
 */

import {ExportResultCode, internal} from '@opentelemetry/core';
import {MetricReader, PushMetricExporter} from '@opentelemetry/sdk-metrics';
import {Span, SpanProcessor} from '@opentelemetry/sdk-trace-base';

import {getNumberEnvVar} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

/**
 * The minimum spacing between two metric exports to Cloud Monitoring.
 *
 * The backend currently accepts points sent more frequently than this, but only
 * to absorb drift from a reader that fires slightly early. Exporting faster
 * than this interval risks points being rejected or throttled.
 */
export const MIN_EXPORT_INTERVAL_MS = 5000;

/** Env var overriding the hard floor on collect spacing (I2), in milliseconds. */
export const AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS_ENV =
  'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS';

/** Env var carrying the OpenTelemetry metric export interval, in milliseconds. */
const OTEL_METRIC_EXPORT_INTERVAL_ENV = 'OTEL_METRIC_EXPORT_INTERVAL';

/** Env var carrying the OpenTelemetry metric export timeout, in milliseconds. */
const OTEL_METRIC_EXPORT_TIMEOUT_ENV = 'OTEL_METRIC_EXPORT_TIMEOUT';

/** Guidepost grid spacing when nothing configures one, in milliseconds. */
const DEFAULT_EXPORT_INTERVAL_MS = 60000;

/** Per-collect timeout when nothing configures one, in milliseconds. */
const DEFAULT_EXPORT_TIMEOUT_MS = 30000;

/** Multiple of the period a busy period must exceed before point 4 collects. */
const OVERDUE_PERIOD_FACTOR = 1.5;

/**
 * Name of the inference span whose starts drive point 4.
 *
 * adk-js opens one `call_llm` span per model call. adk-python matches
 * `generate_content`, the span the GenAI Python SDK's own instrumentation
 * opens; adk-js emits no such span.
 */
const INFERENCE_SPAN_NAME = 'call_llm';

/** Semantic-convention attribute carrying the GenAI operation name. */
const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

/** Returns the minimum spacing between two collects (I2), in milliseconds. */
export function collectFloorMillis(): number {
  return getNumberEnvVar(
    AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS_ENV,
    MIN_EXPORT_INTERVAL_MS,
  );
}

/** True when a span start should drive point 4. */
function isInferenceSpan(span: Span): boolean {
  return (
    span.attributes[GEN_AI_OPERATION_NAME] === INFERENCE_SPAN_NAME ||
    span.name.startsWith(INFERENCE_SPAN_NAME)
  );
}

/** Timing overrides for a {@link RequestDrivenMetricReader}. */
export interface RequestDrivenMetricReaderOptions {
  /** Guidepost grid spacing in milliseconds (I3). */
  exportIntervalMillis?: number;
  /** Per-collect timeout in milliseconds. */
  exportTimeoutMillis?: number;
  /** Minimum spacing between two collects in milliseconds (I2). */
  floorMillis?: number;
  /** Monotonic clock in milliseconds. */
  now?: () => number;
}

/** The metric-export handles an application wires up. */
export interface MetricsState {
  /** Install this on the `MeterProvider`. */
  reader: RequestDrivenMetricReader;
  /** Install this on the `TracerProvider`. */
  spanProcessor: SpanProcessor;
}

/**
 * A `MetricReader` whose collects are driven by the request lifecycle.
 *
 * The reader starts no timer. Callers drive it through
 * {@link RequestDrivenMetricReader.noteRequestStart},
 * {@link RequestDrivenMetricReader.noteRequestEnd} and
 * {@link RequestDrivenMetricReader.noteGenerateContentStart}, each of which
 * answers "should I collect now?", and run the collect with
 * {@link RequestDrivenMetricReader.submitCollect}.
 *
 * adk-python guards the same state with a lock, because its collects run on a
 * worker thread. Here they run on the event loop, so every hook is already a
 * synchronous critical section and there is no lock.
 */
export class RequestDrivenMetricReader extends MetricReader {
  private readonly exporter: PushMetricExporter;
  private readonly now: () => number;
  private readonly periodMs: number;
  private readonly floorMs: number;
  private readonly timeoutMs: number;

  /** Requests currently being served. */
  private inFlight = 0;
  /** When the last collect that actually ran started. */
  private lastCollect: number | undefined;
  /**
   * Start of the current busy period, restamped when in-flight goes 0 to 1.
   *
   * Point 4 measures "overdue" from the current busy period, so a collect from
   * a long-past one cannot make a short request look overdue.
   */
  private busyStart: number;
  /** A collect is committed or running. */
  private collecting = false;
  /** The next guidepost on the grid. */
  private nextDue: number;
  /** Set once the reader starts shutting down. */
  private isShutdown = false;
  /** Serializes collects, so two never overlap. */
  private tail: Promise<void> = Promise.resolve();

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
      getNumberEnvVar(
        OTEL_METRIC_EXPORT_INTERVAL_ENV,
        DEFAULT_EXPORT_INTERVAL_MS,
      );
    this.timeoutMs =
      options.exportTimeoutMillis ??
      getNumberEnvVar(
        OTEL_METRIC_EXPORT_TIMEOUT_ENV,
        DEFAULT_EXPORT_TIMEOUT_MS,
      );
    this.floorMs = options.floorMillis ?? collectFloorMillis();

    const startedAt = this.now();
    this.nextDue = startedAt + this.periodMs;
    this.busyStart = startedAt;
  }

  /**
   * Notes that a request has started, and answers whether to collect now.
   *
   * @returns True when the caller should run
   *     {@link RequestDrivenMetricReader.submitCollect}.
   */
  noteRequestStart(): boolean {
    const now = this.now();
    const overlap = this.inFlight >= 1;
    if (!overlap) {
      this.busyStart = now;
    }
    this.inFlight++;
    if (this.collecting) {
      return false;
    }
    if (overlap && this.due(now)) {
      if (this.floorOk(now)) {
        this.arm(now);
        return true;
      }
      // Point 3: this guidepost is too close to the last collect, so mute it.
      this.nextDue += this.periodMs;
    }
    return false;
  }

  /**
   * Notes that a request has finished, and answers whether to collect now.
   *
   * Call this once the response body is fully sent. This drain collect is not
   * gated on a guidepost.
   *
   * @returns True when the caller should run
   *     {@link RequestDrivenMetricReader.submitCollect}.
   */
  noteRequestEnd(): boolean {
    const now = this.now();
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight === 0 && !this.collecting && this.floorOk(now)) {
      this.arm(now);
      return true;
    }
    return false;
  }

  /**
   * Notes an inference span start, and answers whether to collect now.
   *
   * @returns True when the caller should run
   *     {@link RequestDrivenMetricReader.submitCollect}.
   */
  noteGenerateContentStart(): boolean {
    const now = this.now();
    if (
      !this.collecting &&
      this.inFlight >= 1 &&
      this.overdue(now) &&
      this.floorOk(now)
    ) {
      this.arm(now);
      return true;
    }
    return false;
  }

  /**
   * Queues a committed collect behind the ones already running.
   *
   * Fire and forget it on a request start or a span start. Await it on the
   * request-end drain, so the export finishes before the connection closes.
   *
   * @returns The queued collect, or undefined when the reader is shutting down.
   */
  submitCollect(): Promise<void> | undefined {
    if (this.isShutdown) {
      // Release the guard, so a later hook is not locked out by it.
      this.collecting = false;
      return undefined;
    }
    this.tail = this.tail.then(() => this.collectNow());
    return this.tail;
  }

  /** Drains the SDK aggregation into the exporter. Never rejects. */
  async collectNow(): Promise<void> {
    this.lastCollect = this.now();
    try {
      const {resourceMetrics, errors} = await this.collect({
        timeoutMillis: this.timeoutMs,
      });
      if (errors.length > 0) {
        logger.warn('Errors while collecting request-driven metrics', errors);
      }
      if (resourceMetrics.scopeMetrics.length === 0) {
        return;
      }
      // `_export` suppresses tracing around the call, so the exporter's own
      // request cannot open spans that record metrics that trigger the next
      // export. PeriodicExportingMetricReader exports through it too.
      const result = await internal._export(this.exporter, resourceMetrics);
      if (result.code !== ExportResultCode.SUCCESS) {
        throw result.error ?? new Error('Metric export failed');
      }
    } catch (e: unknown) {
      // A fire-and-forget collect has nobody to observe its rejection.
      logger.error('Exception during request-driven metric collect', e);
    } finally {
      this.collecting = false;
    }
  }

  /** True once the guidepost grid has been crossed. */
  private due(now: number): boolean {
    return now >= this.nextDue;
  }

  /** True when a collect now would honour the floor (I2). */
  private floorOk(now: number): boolean {
    return (
      this.lastCollect === undefined || now - this.lastCollect >= this.floorMs
    );
  }

  /** True when the current busy period has run without a collect for too long. */
  private overdue(now: number): boolean {
    const ref = Math.max(this.busyStart, this.lastCollect ?? this.busyStart);
    return now - ref >= OVERDUE_PERIOD_FACTOR * this.periodMs;
  }

  /**
   * Commits to a collect and advances the guidepost grid to the first tick
   * strictly after `now`.
   *
   * This deliberately does not stamp `lastCollect`: the worker stamps it at the
   * actual collect, so the floor constrains real collect spacing rather than
   * decision spacing.
   */
  private arm(now: number): void {
    this.collecting = true;
    if (now >= this.nextDue) {
      const missed = Math.floor((now - this.nextDue) / this.periodMs) + 1;
      this.nextDue += missed * this.periodMs;
    }
  }

  /** Runs one collect, then flushes the exporter. */
  protected async onForceFlush(): Promise<void> {
    await this.submitCollect();
    await this.exporter.forceFlush();
  }

  /** Drains queued collects, runs a final one, then shuts the exporter down. */
  protected async onShutdown(): Promise<void> {
    this.isShutdown = true;
    await this.tail;
    await this.collectNow();
    await this.exporter.shutdown();
  }
}

/** Collects on each inference span start (point 4). */
class MetricsFlushingSpanProcessor implements SpanProcessor {
  constructor(private readonly reader: RequestDrivenMetricReader) {}

  onStart(span: Span): void {
    // This runs inside span creation on the inference path, so a metrics
    // failure must not break the span it observes.
    try {
      if (isInferenceSpan(span) && this.reader.noteGenerateContentStart()) {
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

/**
 * Builds the request-driven reader and the span processor that drives it.
 *
 * This sets no global provider. Install `reader` on a `MeterProvider` and
 * `spanProcessor` on the `TracerProvider`, then drive the reader from the
 * request path.
 *
 * @param exporter The exporter each collect drains into.
 * @param options Timing overrides for the reader.
 * @returns The reader and the span processor.
 */
export function buildRequestDrivenMetrics(
  exporter: PushMetricExporter,
  options: RequestDrivenMetricReaderOptions = {},
): MetricsState {
  const reader = new RequestDrivenMetricReader(exporter, options);
  return {reader, spanProcessor: new MetricsFlushingSpanProcessor(reader)};
}
