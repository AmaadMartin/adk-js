/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Request-driven, sleepless metric export for the Vertex AI Agent Runtime.
 *
 * The Agent Runtime throttles CPU the instant a request finishes, so a metric
 * reader that exports on a timer is starved between requests and drops points.
 * The reader here never creates a timer. It collects only when the request
 * lifecycle drives it, through the middleware in `@google/adk-devtools` and the
 * span processor below.
 *
 * Three constraints shape the design:
 *
 * - I1: export only while serving, the only time CPU is guaranteed.
 * - I2: never collect more often than the floor ({@link MIN_EXPORT_INTERVAL_MS}
 *   by default). A collect that would land sooner is rejected.
 * - I3: never collect too rarely. A single export carries about 200 points, so
 *   collect at least once per configured period.
 *
 * The configured export period is a guidepost grid rather than a schedule: it
 * only decides whether an event-driven collect is warranted.
 *
 * This is not lossless. A request shorter than the floor that drains right
 * after a collect, and is the last request before the process goes idle, loses
 * its points. That case is accepted.
 */

import {context, metrics} from '@opentelemetry/api';
import {
  ExportResult,
  ExportResultCode,
  suppressTracing,
} from '@opentelemetry/core';
import {MetricReader, PushMetricExporter} from '@opentelemetry/sdk-metrics';
import {Span, SpanProcessor} from '@opentelemetry/sdk-trace-base';

import {logger} from '../utils/logger.js';

/** Env var overriding the hard floor on collect spacing, in milliseconds. */
export const GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS =
  'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS';

/**
 * Minimum spacing between two metric exports, shared by every ADK reader: the
 * floor (I2) here, and the export interval of the periodic reader in
 * `google_cloud`.
 *
 * The backend accepts points sent more frequently, but only to absorb drift.
 * Exporting faster than this risks points being rejected or throttled.
 */
export const MIN_EXPORT_INTERVAL_MS = 5000;

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const OTEL_METRIC_EXPORT_INTERVAL = 'OTEL_METRIC_EXPORT_INTERVAL';
const OTEL_METRIC_EXPORT_TIMEOUT = 'OTEL_METRIC_EXPORT_TIMEOUT';
const DEFAULT_EXPORT_INTERVAL_MS = 60000;
const DEFAULT_EXPORT_TIMEOUT_MS = 30000;

/**
 * How many periods must pass before a lone long request is overdue a collect.
 */
const OVERDUE_PERIOD_MULTIPLIER = 1.5;

/** The ADK inference span; `adk-python` matches `generate_content` instead. */
const INFERENCE_SPAN_NAME = 'call_llm';

/** Reads a numeric env var, falling back to a default on missing or invalid. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  // `Number('')` is 0, so a blank value has to be rejected explicitly.
  const value = raw.trim() === '' ? Number.NaN : Number(raw);
  if (Number.isNaN(value)) {
    logger.warn(
      `Found invalid value for ${name}=${raw}, using default ${fallback}`,
    );
    return fallback;
  }
  return value;
}

/** The part of the reader the request path drives. */
export interface RequestMetricsDriver {
  /** Call on request entry. Returns whether a collect is warranted. */
  noteRequestStart(): boolean;
  /** Call once the response is written. Returns whether to collect. */
  noteRequestEnd(): boolean;
  /** Runs a committed collect. Never rejects. */
  submitCollect(): Promise<void>;
}

/** The part of the reader an inference span start drives. */
export interface InferenceMetricsDriver {
  /** Call on an inference span start. Returns whether to collect. */
  noteInferenceStart(): boolean;
  /** Runs a committed collect. Never rejects. */
  submitCollect(): Promise<void>;
}

/** Options for {@link RequestDrivenMetricReader}. */
export interface RequestDrivenMetricReaderOptions {
  /** The exporter each collect drains into. */
  exporter: PushMetricExporter;
  /** Guidepost period. Default: `OTEL_METRIC_EXPORT_INTERVAL`, else 60000. */
  exportIntervalMillis?: number;
  /** Collect timeout. Default: `OTEL_METRIC_EXPORT_TIMEOUT`, else 30000. */
  exportTimeoutMillis?: number;
  /**
   * Minimum spacing between collects. Default: the value of
   * {@link GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS},
   * else {@link MIN_EXPORT_INTERVAL_MS}.
   */
  floorMillis?: number;
  /** Monotonic clock in milliseconds. Default: `performance.now`. */
  now?: () => number;
}

/**
 * A `MetricReader` whose collects are driven by the request lifecycle.
 *
 * It deliberately does not override `onInitialized`, which is where the SDK's
 * periodic reader starts its interval. No timer is ever created.
 */
export class RequestDrivenMetricReader
  extends MetricReader
  implements RequestMetricsDriver, InferenceMetricsDriver
{
  private readonly exporter: PushMetricExporter;
  private readonly exportTimeoutMillis: number;
  private readonly periodMs: number;
  private readonly floorMs: number;
  private readonly now: () => number;

  private inFlight = 0;
  private lastCollect?: number;
  /**
   * Start of the current busy period, stamped when in-flight goes 0 to 1. A
   * collect from a long-past busy period must not make a short request look
   * overdue, so `overdue15` measures from here. Only read while a request is
   * in flight, which is exactly when it has been stamped.
   */
  private busyStart: number;
  private collecting = false;
  private nextDue: number;
  private shuttingDown = false;
  /** Serializes collects: the single-worker executor of this port. */
  private collectChain: Promise<void> = Promise.resolve();

  constructor(options: RequestDrivenMetricReaderOptions) {
    // Defer temporality and aggregation to the wrapped exporter, exactly as
    // PeriodicExportingMetricReader does.
    super({
      aggregationSelector: options.exporter.selectAggregation?.bind(
        options.exporter,
      ),
      aggregationTemporalitySelector:
        options.exporter.selectAggregationTemporality?.bind(options.exporter),
    });
    this.exporter = options.exporter;
    this.now = options.now ?? (() => performance.now());
    this.periodMs =
      options.exportIntervalMillis ??
      envNumber(OTEL_METRIC_EXPORT_INTERVAL, DEFAULT_EXPORT_INTERVAL_MS);
    this.exportTimeoutMillis =
      options.exportTimeoutMillis ??
      envNumber(OTEL_METRIC_EXPORT_TIMEOUT, DEFAULT_EXPORT_TIMEOUT_MS);
    this.floorMs =
      options.floorMillis ??
      envNumber(
        GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS,
        MIN_EXPORT_INTERVAL_MS,
      );
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

  /**
   * Whether a lone long request has gone long enough without a collect.
   *
   * Measured over the current busy period: from the last collect in it, or
   * from when the period began. Treating "no collect yet" as overdue makes the
   * first inference span of a short first request collect before that request
   * has recorded anything, which stamps the floor and mutes the drain that
   * carries the points.
   */
  private overdue15(now: number): boolean {
    const ref = Math.max(this.busyStart, this.lastCollect ?? this.busyStart);
    return now - ref >= OVERDUE_PERIOD_MULTIPLIER * this.periodMs;
  }

  /**
   * Commits to a collect and advances the guidepost grid past `now`.
   *
   * It must not stamp `lastCollect`: the worker does that at the real collect,
   * so I2 constrains real collect spacing rather than decision spacing.
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
    if (this.collecting || !overlap || !this.due(now)) {
      return false;
    }
    if (!this.floorOk(now)) {
      // The guidepost is too close to the last collect, so mute it.
      this.nextDue += this.periodMs;
      return false;
    }
    this.arm(now);
    return true;
  }

  noteRequestEnd(): boolean {
    const now = this.now();
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight > 0 || this.collecting || !this.floorOk(now)) {
      return false;
    }
    // The baseline drain collect, not gated on a guidepost.
    this.arm(now);
    return true;
  }

  noteInferenceStart(): boolean {
    const now = this.now();
    if (
      this.collecting ||
      this.inFlight < 1 ||
      !this.overdue15(now) ||
      !this.floorOk(now)
    ) {
      return false;
    }
    this.arm(now);
    return true;
  }

  /**
   * Queues a committed collect behind any collect already running.
   *
   * Resolves without collecting during shutdown, clearing the guard so it
   * cannot wedge shut. Never rejects.
   */
  submitCollect(): Promise<void> {
    if (this.shuttingDown) {
      this.collecting = false;
      return Promise.resolve();
    }
    this.collectChain = this.collectChain.then(() => this.runCollect());
    return this.collectChain;
  }

  private async runCollect(): Promise<void> {
    this.lastCollect = this.now();
    try {
      await this.collectAndExport();
    } catch (e: unknown) {
      logger.warn('Exception during request-driven metric collect', e);
    } finally {
      this.collecting = false;
    }
  }

  private async collectAndExport(): Promise<void> {
    const {resourceMetrics, errors} = await this.collect({
      timeoutMillis: this.exportTimeoutMillis,
    });
    if (errors.length > 0) {
      logger.warn('Request-driven metric collection errors', ...errors);
    }
    if (resourceMetrics.resource.asyncAttributesPending) {
      await resourceMetrics.resource.waitForAsyncAttributes?.();
    }
    if (resourceMetrics.scopeMetrics.length === 0) {
      return;
    }
    const result = await new Promise<ExportResult>((resolve) => {
      context.with(suppressTracing(context.active()), () => {
        this.exporter.export(resourceMetrics, resolve);
      });
    });
    if (result.code !== ExportResultCode.SUCCESS) {
      logger.warn('Request-driven metric export failed', result.error);
    }
  }

  /** Collects on demand and flushes the exporter. */
  protected async onForceFlush(): Promise<void> {
    await this.submitCollect();
    await this.exporter.forceFlush();
  }

  protected async onShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.collectChain;
    // A final best-effort collect, bypassing the guard. The base class refuses
    // a second shutdown, so this runs at most once.
    try {
      await this.collectAndExport();
    } catch (e: unknown) {
      logger.warn('Exception during final metric collect on shutdown', e);
    }
    await this.exporter.shutdown();
  }
}

/** Fires a fire-and-forget collect on each inference span start. */
export class MetricsFlushingSpanProcessor implements SpanProcessor {
  constructor(
    private readonly reader: InferenceMetricsDriver,
    private readonly operation: string = INFERENCE_SPAN_NAME,
  ) {}

  /** Collects when an inference span starts, if the reader is due one. */
  onStart(span: Span): void {
    // `adk-python` also matches the `gen_ai.operation.name` attribute. ADK JS
    // sets that attribute after the span starts, so the bag is empty here.
    try {
      if (
        span.name.startsWith(this.operation) &&
        this.reader.noteInferenceStart()
      ) {
        void this.reader.submitCollect();
      }
    } catch (e: unknown) {
      // onStart runs inside span creation, so a metrics failure must not break
      // the span it observes.
      logger.warn('Metrics span-start hook failed', e);
    }
  }

  /** Nothing to do: the reader is driven by span starts only. */
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
  /** Install on the `MeterProvider`. */
  reader: RequestDrivenMetricReader;
  /** Install on the `TracerProvider`. */
  spanProcessor: SpanProcessor;
}

/**
 * Builds the request-driven reader and the span processor that drives it.
 *
 * This sets no global provider. The caller installs `reader` on a
 * `MeterProvider` and `spanProcessor` on the `TracerProvider`, and drives the
 * reader from the request path.
 */
export function buildRequestDrivenMetrics(
  exporter: PushMetricExporter,
): MetricsState {
  const reader = new RequestDrivenMetricReader({exporter});
  return {reader, spanProcessor: new MetricsFlushingSpanProcessor(reader)};
}

let cachedState: MetricsState | undefined;
let evaluated = false;

/** Whether an SDK `MeterProvider` is already globally installed. */
function isSdkMeterProviderInstalled(): boolean {
  const provider = metrics.getMeterProvider();
  // The API's no-op provider only implements `getMeter`. Duck-typing avoids
  // `instanceof`, which fails across two copies of the SDK in one runtime.
  return 'shutdown' in provider && 'forceFlush' in provider;
}

function buildAgentEngineMetrics(
  createExporter: () => PushMetricExporter,
): MetricsState | undefined {
  if (!process.env[AGENT_ENGINE_ID_ENV_VAR]) {
    return undefined;
  }
  if (isSdkMeterProviderInstalled()) {
    logger.warn(
      'A MeterProvider is already installed; skipping request-driven metric' +
        ' export. On the Agent Engine request-billed runtime metrics may be' +
        ' dropped between requests.',
    );
    return undefined;
  }
  try {
    return buildRequestDrivenMetrics(createExporter());
  } catch (e: unknown) {
    logger.warn(
      'Failed to set up request-driven metric export on Agent Engine.',
      e,
    );
    return undefined;
  }
}

/**
 * Builds the request-driven metric state on Agent Engine, memoized.
 *
 * `createExporter` runs only once the gate passes. Returns undefined off Agent
 * Engine, when a `MeterProvider` is already installed, or when the exporter
 * cannot be built.
 */
export function getAgentEngineMetricsSetup(
  createExporter: () => PushMetricExporter,
): MetricsState | undefined {
  if (!evaluated) {
    evaluated = true;
    cachedState = buildAgentEngineMetrics(createExporter);
  }
  return cachedState;
}

/** The memoized metric state, or undefined if it was never built. */
export function getRequestDrivenMetricsState(): MetricsState | undefined {
  return cachedState;
}
