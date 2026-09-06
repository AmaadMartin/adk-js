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
 * points are dropped. {@link RequestDrivenMetricReader} has no timer at all: it
 * collects only when the request lifecycle tells it to.
 *
 * Three constraints shape the design.
 *
 * - I1, export only while serving. A collect runs while a request is in flight,
 *   the only time CPU is guaranteed.
 * - I2, never collect more often than the floor. Two collects closer than
 *   {@link MIN_EXPORT_INTERVAL_MS} are rejected.
 * - I3, never collect too rarely. One export carries at most about 200 points,
 *   so the reader collects at least once per configured period.
 *
 * The configured export period becomes a grid of guideposts rather than a
 * schedule. A guidepost is a would-be collect time, used to decide whether an
 * event-driven collect is warranted. Four decision points drive the reader:
 *
 * 1. Baseline. When the in-flight count drains to zero, collect. This is gated
 *    on the floor only, never on a guidepost.
 * 2. Under continuous overlap the in-flight count never reaches zero, so a
 *    crossed guidepost fires at the next request start.
 * 3. A guidepost within the floor of the last collect is muted, and the grid
 *    advances by one period.
 * 4. A lone long request collects off its own `generate_content` span starts,
 *    once {@link OVERDUE_PERIOD_FACTOR} times the period has elapsed since the
 *    reference point of the current busy period.
 *
 * One case still loses points, and that is accepted. A request shorter than the
 * floor that drains right after a collect, and is the last request before the
 * process goes idle, loses its points: a collect now is muted by the floor, and
 * no later request arrives to carry them.
 *
 * The middleware that drives the reader from an HTTP request lifecycle is not
 * part of this module. A caller notes each request itself:
 *
 * ```ts
 * const {reader, spanProcessor} = buildRequestDrivenMetrics(exporter);
 * const meterProvider = new MeterProvider({readers: [reader]});
 * const tracerProvider = new NodeTracerProvider({spanProcessors: [spanProcessor]});
 *
 * if (reader.noteRequestStart()) void reader.submitCollect();
 * // ... serve the request and stream the response body ...
 * if (reader.noteRequestEnd()) await reader.submitCollect();
 * ```
 */

import {context} from '@opentelemetry/api';
import {ExportResultCode, suppressTracing} from '@opentelemetry/core';
import {
  MetricReader,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {Span, SpanProcessor} from '@opentelemetry/sdk-trace-base';

import {logger} from '../utils/logger.js';

/** Env var overriding the hard floor on collect spacing (I2), in milliseconds. */
const AGENT_ENGINE_METRICS_FLOOR_ENV =
  'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS';

/** Env var carrying the OpenTelemetry metric export interval, in milliseconds. */
const OTEL_METRIC_EXPORT_INTERVAL_ENV = 'OTEL_METRIC_EXPORT_INTERVAL';

/** Env var carrying the OpenTelemetry metric export timeout, in milliseconds. */
const OTEL_METRIC_EXPORT_TIMEOUT_ENV = 'OTEL_METRIC_EXPORT_TIMEOUT';

/** Guidepost grid spacing when no interval is configured, in milliseconds. */
const DEFAULT_EXPORT_INTERVAL_MS = 60000;

/** Per-collect timeout when none is configured, in milliseconds. */
const DEFAULT_EXPORT_TIMEOUT_MS = 30000;

/** Multiple of the period a busy stretch must exceed before point 4 collects. */
const OVERDUE_PERIOD_FACTOR = 1.5;

/** Semantic-convention attribute carrying the GenAI operation name. */
const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

/** The GenAI operation whose span starts drive point 4. */
const GENERATE_CONTENT_OPERATION = 'generate_content';

/**
 * The minimum spacing between two metric exports to Cloud Monitoring, shared by
 * every ADK metric reader.
 *
 * The backend currently accepts points sent more frequently than this, but only
 * to absorb drift from a reader that fires slightly early. Exporting faster
 * than this interval risks points being rejected or throttled, so keep new
 * readers at or above it.
 */
export const MIN_EXPORT_INTERVAL_MS = 5000;

/** Overrides for a {@link RequestDrivenMetricReader}'s timings. */
export interface RequestDrivenMetricReaderOptions {
  /** Guidepost grid spacing in milliseconds (I3). */
  exportIntervalMillis?: number;
  /** Per-collect timeout in milliseconds. */
  exportTimeoutMillis?: number;
  /** Minimum spacing between two collects in milliseconds (I2). */
  floorMillis?: number;
  /** Monotonic clock in milliseconds. Injected by tests. */
  now?: () => number;
}

/** The metric-export handles an application wires up. */
export interface MetricsState {
  /** Install this on the `MeterProvider`. */
  reader: RequestDrivenMetricReader;
  /** Install this on the `TracerProvider`. */
  spanProcessor: SpanProcessor;
}

/** Reads a millisecond env var, falling back to `defaultMs` when unusable. */
function envMillis(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultMs;
  }
  // Number('') is 0, so an empty value would silently mean "no interval".
  const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.warn(
      `Found invalid value for ${name}=${raw}, using default ${defaultMs}`,
    );
    return defaultMs;
  }
  return parsed;
}

/** Promisifies the callback-style {@link PushMetricExporter.export}. */
function exportMetrics(
  exporter: PushMetricExporter,
  metrics: ResourceMetrics,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    exporter.export(metrics, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        resolve();
        return;
      }
      reject(result.error ?? new Error('Metric export failed'));
    });
  });
}

/**
 * A `MetricReader` whose collects are driven by the request lifecycle.
 *
 * The reader starts no timer and calls no `setTimeout`. Callers drive it
 * through {@link noteRequestStart}, {@link noteRequestEnd} and
 * {@link noteGenerateContentStart}, each of which answers "should I collect
 * now?", and run the collect with {@link submitCollect}.
 *
 * The adk-python reader guards its state with a lock because its collects run
 * on a worker thread. Here they run on the event loop, so every decision hook
 * is a synchronous critical section and no lock exists.
 */
export class RequestDrivenMetricReader extends MetricReader {
  private readonly exporter: PushMetricExporter;
  private readonly now: () => number;
  private readonly periodMs: number;
  private readonly floorMs: number;
  private readonly timeoutMs: number;

  /** Requests currently being served. */
  private inFlight = 0;
  /** Time of the last collect that actually ran. */
  private lastCollect: number | undefined;
  /**
   * Start of the current busy period, stamped when in-flight goes 0 to 1.
   *
   * Only read while a request is in flight, so the constructor's value is never
   * the one used.
   */
  private busyStart: number;
  /** A collect is committed or running. */
  private collecting = false;
  /** The next guidepost on the grid. */
  private nextDue: number;
  /** Set once the reader is shutting down. */
  private shuttingDown = false;
  /** Serializes collects, so two never overlap. */
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
      envMillis(OTEL_METRIC_EXPORT_INTERVAL_ENV, DEFAULT_EXPORT_INTERVAL_MS);
    this.timeoutMs =
      options.exportTimeoutMillis ??
      envMillis(OTEL_METRIC_EXPORT_TIMEOUT_ENV, DEFAULT_EXPORT_TIMEOUT_MS);
    this.floorMs =
      options.floorMillis ??
      envMillis(AGENT_ENGINE_METRICS_FLOOR_ENV, MIN_EXPORT_INTERVAL_MS);
    const startedAt = this.now();
    this.nextDue = startedAt + this.periodMs;
    this.busyStart = startedAt;
  }

  /**
   * Notes that a request has started, and answers whether to collect now.
   *
   * @returns True when the caller should run {@link submitCollect}.
   */
  noteRequestStart(): boolean {
    const now = this.now();
    const overlap = this.inFlight >= 1;
    if (!overlap) {
      // A fresh busy period, which resets the point-4 reference.
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
      // Point 3: the guidepost is too close to the last collect, so mute it.
      this.nextDue += this.periodMs;
    }
    return false;
  }

  /**
   * Notes that a request has finished, and answers whether to collect now.
   *
   * Call this after the response body is fully sent. The drain collect is not
   * gated on a guidepost.
   *
   * @returns True when the caller should run {@link submitCollect}.
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
   * Notes a `generate_content` span start, and answers whether to collect now.
   *
   * @returns True when the caller should run {@link submitCollect}.
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
   * Runs a committed collect off the awaited path.
   *
   * Collects are serialized on a single promise chain, so two never overlap and
   * none runs on a caller's critical path. Fire and forget on a request start
   * or a span start; await it on the request-end drain, so the export finishes
   * before the connection closes.
   *
   * @returns The queued collect, or undefined when the reader is shutting down.
   */
  submitCollect(): Promise<void> | undefined {
    if (this.shuttingDown) {
      // Clear the guard, so it cannot wedge shut.
      this.collecting = false;
      return undefined;
    }
    this.pending = this.pending.then(() => this.collectNow());
    return this.pending;
  }

  /** Drains the SDK aggregation into the exporter. Never rejects. */
  private async collectNow(): Promise<void> {
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
      // Without this the exporter's own request is traced, which produces
      // spans, which produce metrics, which produce another export.
      await context.with(suppressTracing(context.active()), () =>
        exportMetrics(this.exporter, resourceMetrics),
      );
    } catch (e: unknown) {
      // A fire-and-forget collect has nobody to observe its rejection.
      logger.error('Exception during request-driven metric collect', e);
    } finally {
      this.collecting = false;
    }
  }

  protected async onForceFlush(): Promise<void> {
    this.pending = this.pending.then(() => this.collectNow());
    await this.pending;
    await this.exporter.forceFlush();
  }

  protected async onShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.pending;
    await this.collectNow();
    await this.exporter.shutdown();
  }

  /** True when the guidepost grid has been crossed. */
  private due(now: number): boolean {
    return now >= this.nextDue;
  }

  /** True when a collect now would honour the floor (I2). */
  private floorOk(now: number): boolean {
    return (
      this.lastCollect === undefined || now - this.lastCollect >= this.floorMs
    );
  }

  /**
   * True when the current busy period is overdue a collect (point 4).
   *
   * "Overdue" is measured over the current busy period only: from its last
   * collect, or from when it began if it has had none. A collect from an
   * earlier busy period must not make a short request look overdue, and a fresh
   * period is not overdue until {@link OVERDUE_PERIOD_FACTOR} periods into it.
   * Otherwise point 4 fires on a short request's first inference span, stamps
   * the floor, and mutes the drain that carries that request's points.
   */
  private overdue(now: number): boolean {
    const ref =
      this.lastCollect === undefined
        ? this.busyStart
        : Math.max(this.busyStart, this.lastCollect);
    return now - ref >= OVERDUE_PERIOD_FACTOR * this.periodMs;
  }

  /**
   * Commits to a collect and advances the guidepost grid past `now`.
   *
   * This does not stamp the last-collect time. That happens at the real
   * collect, so the floor constrains actual collect spacing rather than
   * decision spacing.
   */
  private arm(now: number): void {
    this.collecting = true;
    if (now >= this.nextDue) {
      const missed = Math.floor((now - this.nextDue) / this.periodMs) + 1;
      this.nextDue += missed * this.periodMs;
    }
  }
}

/** Fires a fire-and-forget collect on each `generate_content` span start. */
class MetricsFlushingSpanProcessor implements SpanProcessor {
  constructor(private readonly reader: RequestDrivenMetricReader) {}

  onStart(span: Span): void {
    // onStart runs inside span creation on the inference path, so a metrics
    // failure must never break the span it observes.
    try {
      const matches =
        span.attributes[GEN_AI_OPERATION_NAME] === GENERATE_CONTENT_OPERATION ||
        span.name.startsWith(GENERATE_CONTENT_OPERATION);
      if (matches && this.reader.noteGenerateContentStart()) {
        void this.reader.submitCollect();
      }
    } catch (e: unknown) {
      logger.error('Metrics span-start hook failed', e);
    }
  }

  onEnd(): void {
    // The reader collects on span starts only.
  }

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
 * `spanProcessor` on a `TracerProvider`, then drive the reader from the request
 * path.
 *
 * @param exporter The exporter the reader drains into on each collect.
 * @param options Overrides for the reader's timings.
 * @returns The reader and the span processor.
 */
export function buildRequestDrivenMetrics(
  exporter: PushMetricExporter,
  options?: RequestDrivenMetricReaderOptions,
): MetricsState {
  const reader = new RequestDrivenMetricReader(exporter, options);
  return {reader, spanProcessor: new MetricsFlushingSpanProcessor(reader)};
}
