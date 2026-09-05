/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  context,
  defaultTextMapGetter,
  metrics,
  propagation,
} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {MeterProvider} from '@opentelemetry/sdk-metrics';
import {Span, SpanProcessor} from '@opentelemetry/sdk-trace-base';
import type {Application, RequestHandler, Response} from 'express';

import {logger} from '../utils/logger.js';
import {version} from '../version.js';

/** Header carrying the trace context an Agent Engine caller wants joined. */
const AGENT_ENGINE_TRACEPARENT_HEADER = 'google-agent-engine-traceparent';

/** Header carrying the support identifier of the caller's request. */
const TRACEPARENT_HEADER = 'traceparent';

/**
 * Baggage key holding the accepted Agent Engine trace context.
 *
 * Nothing in this process reads it. It is written for parity with adk-python,
 * which puts the accepted header here so the default W3C baggage propagator
 * carries it to the services the run calls.
 */
const TRACEPARENT_BAGGAGE_KEY = 'traceparent';

/** Baggage key holding the support identifier. */
const GOOGLE_TRACEPARENT_BAGGAGE_KEY = 'google_traceparent';

/** Span attribute the support identifier is recorded under. */
const SUPPORT_ID_ATTRIBUTE = 'supportID';

/** Environment variable Agent Engine sets on the serving container. */
const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

/** Environment variable that turns Agent Engine telemetry export on. */
const AGENT_ENGINE_TELEMETRY_ENV_VAR =
  'GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY';

const TRACE_CONTEXT_PROPAGATOR = new W3CTraceContextPropagator();

/** Inbound HTTP headers, shaped like Node's `IncomingHttpHeaders`. */
export type TraceContextHeaders = Record<string, string | string[] | undefined>;

/**
 * The part of the request-driven metric reader this module drives.
 *
 * Structural on purpose: the reader itself is a separate module
 * (adk-python `telemetry/_agent_engine_metric_exporter.py`) that adk-js does
 * not have yet.
 */
export interface RequestDrivenMetricReader {
  /** True when a collect is warranted now that a request has started. */
  noteRequestStart(): boolean;
  /** True when a collect is warranted now that a request has ended. */
  noteRequestEnd(): boolean;
  /** Runs a collect off the event loop; undefined when none was started. */
  submitCollect(): Promise<void> | undefined;
}

/** The reader plus the span processor that drives it. */
export interface AgentEngineMetricsState {
  reader: RequestDrivenMetricReader;
  spanProcessor: SpanProcessor;
}

/** Builds the request-driven metric state, or undefined when it cannot. */
export type AgentEngineMetricsBuilder = () =>
  | AgentEngineMetricsState
  | undefined;

/** Options for {@link maybeInstallRequestMetricsMiddleware}. */
export interface RequestMetricsMiddlewareOptions {
  /** Whether telemetry is exported to Google Cloud. */
  otelToCloud: boolean;
  /** Supplies the request-driven metric state, when one can be built. */
  buildMetrics?: AgentEngineMetricsBuilder;
}

/** Returns true when the process runs on Vertex AI Agent Engine. */
export function isAgentEngine(): boolean {
  return Boolean(process.env[AGENT_ENGINE_ID_ENV_VAR]);
}

/**
 * Reads a header by its lowercase name.
 *
 * Node lowercases the name of every header it parses, so `name` is looked up
 * as given. A repeated header arrives as an array, of which only the first
 * value is used.
 */
function getHeader(
  headers: TraceContextHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function setBaggageEntry(ctx: Context, key: string, value: string): Context {
  const baggage = propagation.getBaggage(ctx) ?? propagation.createBaggage();
  return propagation.setBaggage(ctx, baggage.setEntry(key, {value}));
}

/**
 * Builds the context an Agent Engine request should run under.
 *
 * The `Google-Agent-Engine-Traceparent` header parents the run onto the
 * caller's span. The `traceparent` header is an opaque support identifier that
 * {@link TopSpanProcessor} records on the top span. Neither header can make
 * this function throw: a value the propagator rejects leaves the context
 * unchanged.
 *
 * @param headers inbound request headers, e.g. Express's `req.headers`.
 */
export function getPropagatedContext(headers: TraceContextHeaders): Context {
  let ctx = context.active();

  const supportId = getHeader(headers, TRACEPARENT_HEADER);
  if (supportId !== undefined) {
    ctx = setBaggageEntry(ctx, GOOGLE_TRACEPARENT_BAGGAGE_KEY, supportId);
  }

  const traceparent = getHeader(headers, AGENT_ENGINE_TRACEPARENT_HEADER);
  if (traceparent !== undefined) {
    const extracted = TRACE_CONTEXT_PROPAGATOR.extract(
      ctx,
      {traceparent},
      defaultTextMapGetter,
    );
    // extract() returns the context unchanged when it rejects the header;
    // testing the extracted span for validity instead would false-accept,
    // since ctx usually already carries a valid span.
    if (extracted !== ctx) {
      ctx = setBaggageEntry(extracted, TRACEPARENT_BAGGAGE_KEY, traceparent);
    }
  }

  return ctx;
}

/**
 * Returns true when the span is the first span of a run.
 *
 * A top span either has no parent, or its parent is the span the caller
 * propagated in the `Google-Agent-Engine-Traceparent` header. The propagator
 * marks that parent remote, and the SDK leaves `parentSpanContext` undefined
 * on a root span. adk-python instead compares the parent span id against the
 * `traceparent` in baggage; the SDK flag answers the same question here and
 * cannot mis-parse a caller-supplied value.
 */
function isTopSpan(span: Span): boolean {
  return !span.parentSpanContext || span.parentSpanContext.isRemote === true;
}

/**
 * Records the caller's support identifier on the top span of every trace.
 *
 * The identifier lets a support engineer find the trace of a reported request.
 * It is set on the top span only, so it identifies the run rather than each of
 * its spans.
 */
export class TopSpanProcessor implements SpanProcessor {
  /** Records the support identifier when the span starting is a top span. */
  onStart(span: Span, parentContext: Context): void {
    const baggage = propagation.getBaggage(parentContext);
    const supportId = baggage?.getEntry(GOOGLE_TRACEPARENT_BAGGAGE_KEY)?.value;
    if (supportId !== undefined && isTopSpan(span)) {
      span.setAttribute(SUPPORT_ID_ATTRIBUTE, supportId);
    }
  }

  /** Does nothing: the support identifier is set when a span starts. */
  onEnd(): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Returns the Vertex Agent Engine `User-Agent` header, if telemetry is on.
 *
 * adk-python reports the `google-cloud-aiplatform` version and appends the
 * OTLP exporter version. Neither is readable from adk-js without loading a
 * dependency's `package.json` at runtime, so this reports the ADK version.
 */
export function telemetryUserAgentHeaders():
  | Record<string, string>
  | undefined {
  if (!process.env[AGENT_ENGINE_TELEMETRY_ENV_VAR]) {
    return undefined;
  }
  return {'User-Agent': `Vertex-Agent-Engine/${version}`};
}

/**
 * Collects and exports metrics on request end, awaited so the export finishes
 * before the response is finalized.
 *
 * Never rejects: a metrics failure must not break the request it rides on.
 */
export async function drainMetrics(
  reader: RequestDrivenMetricReader,
): Promise<void> {
  try {
    if (reader.noteRequestEnd()) {
      await reader.submitCollect();
    }
  } catch (e: unknown) {
    logger.warn('Failed to flush metrics on request end', e);
  }
}

/** Starts a collect on request entry, without waiting for it. */
function noteRequestStart(reader: RequestDrivenMetricReader): void {
  try {
    if (reader.noteRequestStart()) {
      void reader.submitCollect();
    }
  } catch (e: unknown) {
    logger.warn('Metrics request-start hook failed', e);
  }
}

/** The chunk types an HTTP response body accepts. */
type ResponseChunk = string | Uint8Array;

/**
 * The encoding `res.write` accepts, taken from its own signature. Node
 * declares it as `BufferEncoding`, a type-only global the lint configuration
 * does not know about.
 */
type ResponseEncoding = Parameters<Response['write']>[1];

/**
 * Replaces `res.end` so the metric drain runs after the body is written and
 * before the response is finalized.
 *
 * Node documents `end(chunk, encoding, callback)` as `write(chunk, encoding)`
 * followed by `end(callback)`, which is the split this uses: the client gets
 * every byte first, then the drain runs while the request still holds CPU.
 */
function drainBeforeResponseEnd(res: Response, drain: () => Promise<void>) {
  const originalEnd: (callback?: () => void) => void = res.end.bind(res);

  res.end = (
    chunkOrCallback?: ResponseChunk | (() => void),
    encodingOrCallback?: ResponseEncoding | (() => void),
    callback?: () => void,
  ): Response => {
    const done =
      typeof chunkOrCallback === 'function'
        ? chunkOrCallback
        : typeof encodingOrCallback === 'function'
          ? encodingOrCallback
          : callback;
    const encoding =
      typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;

    if (
      typeof chunkOrCallback !== 'function' &&
      chunkOrCallback !== undefined
    ) {
      if (encoding === undefined) {
        res.write(chunkOrCallback);
      } else {
        res.write(chunkOrCallback, encoding);
      }
    }

    void drain().then(() => {
      originalEnd(done);
    });
    return res;
  };
}

/**
 * Drives `reader` from the Express request lifecycle.
 *
 * Collection has to happen while a request is in flight: Agent Engine's
 * request-billed runtime throttles CPU the instant a request ends, so a
 * background export timer gets no CPU between requests. Traces and logs are
 * not flushed here -- on Agent Engine the `AdkApp` in `vertexai.agent_engines`
 * already force-flushes them per request.
 */
export function createMetricsFlushingMiddleware(
  reader: RequestDrivenMetricReader,
): RequestHandler {
  return (_req, res, next) => {
    noteRequestStart(reader);

    let drained = false;
    const drainOnce = (): Promise<void> => {
      if (drained) {
        return Promise.resolve();
      }
      drained = true;
      return drainMetrics(reader);
    };

    drainBeforeResponseEnd(res, drainOnce);
    // Back-stop for an aborted connection, where `end` is never reached and
    // the request start would otherwise never be balanced.
    res.once('close', () => {
      void drainOnce();
    });

    try {
      next();
    } catch (e: unknown) {
      // next() failed: the response is never ended, so balance the request
      // start here before the error propagates.
      void drainOnce();
      throw e;
    }
  };
}

let metricsSetup: AgentEngineMetricsState | undefined;
let metricsSetupEvaluated = false;

function buildAgentEngineMetricsSetup(
  buildMetrics?: AgentEngineMetricsBuilder,
): AgentEngineMetricsState | undefined {
  if (!isAgentEngine()) {
    return undefined;
  }
  // `instanceof` is safe here: the class belongs to `@opentelemetry/sdk-metrics`,
  // a single pinned dependency, not to an ADK package a user can install twice.
  if (metrics.getMeterProvider() instanceof MeterProvider) {
    logger.warn(
      'A MeterProvider is already installed; skipping request-driven metric' +
        " export. On Agent Engine's request-billed runtime metrics may be" +
        ' dropped between requests.',
    );
    return undefined;
  }
  try {
    return buildMetrics?.();
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
 * Returns the reader plus the span processor that drives it, or undefined when
 * a `MeterProvider` is already installed, when the process is not on Agent
 * Engine, or when `buildMetrics` supplies nothing.
 *
 * The result is memoized and `buildMetrics` is ignored after the first call,
 * so the "already installed" check runs exactly once -- before ADK installs
 * its own `MeterProvider` -- and every call site drives the same reader.
 */
export function getAgentEngineMetricsSetup(
  buildMetrics?: AgentEngineMetricsBuilder,
): AgentEngineMetricsState | undefined {
  if (!metricsSetupEvaluated) {
    metricsSetupEvaluated = true;
    metricsSetup = buildAgentEngineMetricsSetup(buildMetrics);
  }
  return metricsSetup;
}

/** Clears the {@link getAgentEngineMetricsSetup} memo, for tests. */
export function resetAgentEngineMetricsSetup(): void {
  metricsSetupEvaluated = false;
  metricsSetup = undefined;
}

/**
 * Installs the request-path metric flushing middleware, if applicable.
 *
 * No-op off Agent Engine, and no-op when telemetry is not exported to Google
 * Cloud, because the reader would then be on no `MeterProvider`.
 */
export function maybeInstallRequestMetricsMiddleware(
  app: Application,
  options: RequestMetricsMiddlewareOptions,
): void {
  if (!options.otelToCloud) {
    return;
  }
  const state = getAgentEngineMetricsSetup(options.buildMetrics);
  if (state === undefined) {
    return;
  }
  app.use(createMetricsFlushingMiddleware(state.reader));
}
