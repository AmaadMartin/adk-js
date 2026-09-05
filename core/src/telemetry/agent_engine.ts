/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Baggage,
  Context,
  context,
  defaultTextMapGetter,
  MeterProvider,
  metrics,
  propagation,
} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {Span, SpanProcessor} from '@opentelemetry/sdk-trace-base';

import {logger} from '../utils/logger.js';
import {
  buildRequestDrivenMetrics,
  MetricsState,
  RequestDrivenMetricReaderHooks,
} from './agent_engine_metric_exporter.js';
import {createGcpMetricExporter} from './gcp_metric_exporter.js';

/** Header carrying the trace context an Agent Engine caller wants joined. */
const AGENT_ENGINE_TRACEPARENT_HEADER = 'google-agent-engine-traceparent';

/** Header carrying the support identifier of the caller's request. */
const TRACEPARENT_HEADER = 'traceparent';

/**
 * Baggage key holding the accepted Agent Engine trace context.
 *
 * {@link isTopSpan} reads it back to tell a parent this module accepted from
 * any other remote parent, so the write is load-bearing for `supportID`
 * attribution. The default W3C baggage propagator also carries it to the
 * services the run calls, which is what adk-python writes it for.
 */
const TRACEPARENT_BAGGAGE_KEY = 'traceparent';

/** Baggage key holding the support identifier. */
const GOOGLE_TRACEPARENT_BAGGAGE_KEY = 'google_traceparent';

/** Span attribute the support identifier is recorded under. */
const SUPPORT_ID_ATTRIBUTE = 'supportID';

/** Environment variable Agent Engine sets on the serving container. */
const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

const TRACE_CONTEXT_PROPAGATOR = new W3CTraceContextPropagator();

/** Inbound HTTP headers, shaped like Node's `IncomingHttpHeaders`. */
export type TraceContextHeaders = Record<string, string | string[] | undefined>;

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
 * A top span either has no parent, or its parent is exactly the span this
 * module accepted from the `Google-Agent-Engine-Traceparent` header and stored
 * in baggage. Testing `parentSpanContext.isRemote` instead would accept any
 * remote parent, including one this module never saw.
 *
 * adk-python also treats an all-zero parent span id as parentless. That cannot
 * arise here: the JS SDK drops an invalid parent span context, leaving
 * `parentSpanContext` undefined.
 *
 * @param span The span that is starting.
 * @param baggage The baggage of the span's parent context, if any.
 */
function isTopSpan(span: Span, baggage: Baggage | undefined): boolean {
  const parentSpanId = span.parentSpanContext?.spanId;
  if (parentSpanId === undefined) {
    return true;
  }
  const traceparent = baggage?.getEntry(TRACEPARENT_BAGGAGE_KEY)?.value;
  if (traceparent === undefined) {
    return false;
  }
  // Python parses the span id as a hex integer; both sides are hex strings
  // here, so a value that is not hex simply fails to match.
  const parts = traceparent.split('-');
  return (
    parts.length >= 3 && parts[2].toLowerCase() === parentSpanId.toLowerCase()
  );
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
    if (supportId !== undefined && isTopSpan(span, baggage)) {
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

/** The part of an HTTP response this module observes. */
export interface ClosableResponse {
  once(event: 'close', listener: () => void): unknown;
}

/** The middleware that drives the reader from the request lifecycle. */
export type MetricsFlushingMiddleware = (
  req: unknown,
  res: ClosableResponse,
  next: () => void,
) => void;

/** The part of an HTTP app this module installs middleware on. */
export interface MiddlewareCapableApp {
  use(middleware: MetricsFlushingMiddleware): unknown;
}

/**
 * Returns the middleware that drives `reader` from the request lifecycle.
 *
 * Collection has to happen while a request is in flight: Agent Engine
 * throttles CPU the instant a request ends. Traces and logs are not flushed
 * here, because the Agent Engine runtime already flushes them per request.
 */
export function metricsFlushingMiddleware(
  reader: RequestDrivenMetricReaderHooks,
): MetricsFlushingMiddleware {
  return (_req, res, next) => {
    // Never let a metrics failure break the request it rides on.
    try {
      if (reader.noteRequestStart()) {
        void reader.submitCollect();
      }
    } catch (e: unknown) {
      logger.error('Metrics request-start hook failed', e);
    }
    // 'close' fires once the response is fully sent, and also when the
    // connection is aborted or the handler throws, so every request start is
    // balanced by exactly one end.
    res.once('close', () => void drainMetrics(reader));
    next();
  };
}

/**
 * Drains the reader at request end.
 *
 * Awaited so the export completes before the request loses its CPU.
 */
export async function drainMetrics(
  reader: RequestDrivenMetricReaderHooks,
): Promise<void> {
  try {
    if (reader.noteRequestEnd()) {
      await reader.submitCollect();
    }
  } catch (e: unknown) {
    logger.error('Failed to flush metrics on request end', e);
  }
}

/**
 * Returns true when `provider` is an SDK `MeterProvider` rather than the API's
 * no-op one.
 *
 * A duck-type check, not `instanceof`: two copies of the SDK in one runtime
 * produce objects that fail an `instanceof` against the other copy's class.
 */
function isSdkMeterProvider(provider: MeterProvider): boolean {
  return 'forceFlush' in provider && 'shutdown' in provider;
}

let metricsSetup: Promise<MetricsState | undefined> | undefined;

/**
 * Builds the request-driven metric state on Agent Engine, memoized.
 *
 * Resolves to the reader plus the span processor that drives it, or to
 * undefined when:
 *
 *  1. the process is not on Agent Engine; or
 *  2. a `MeterProvider` is already installed, so the reader would not land on
 *     the active provider; or
 *  3. the Google Cloud metric exporter is unavailable, or the setup fails.
 *
 * Memoized so the "already installed" check runs exactly once, before ADK
 * installs its own provider in `maybeSetOtelProviders`, and so both callers
 * get the same handles.
 */
export function getAgentEngineMetricsSetup(): Promise<
  MetricsState | undefined
> {
  metricsSetup ??= buildAgentEngineMetricsSetup();
  return metricsSetup;
}

/** Drops the memoized metric state, so the next call rebuilds it. */
export function clearAgentEngineMetricsSetupCache(): void {
  metricsSetup = undefined;
}

async function buildAgentEngineMetricsSetup(): Promise<
  MetricsState | undefined
> {
  if (!isAgentEngine()) {
    return undefined;
  }
  if (isSdkMeterProvider(metrics.getMeterProvider())) {
    logger.warn(
      'A MeterProvider is already installed; skipping request-driven metric ' +
        "export. On Agent Engine's request-billed runtime metrics may be " +
        'dropped between requests.',
    );
    return undefined;
  }
  try {
    return buildRequestDrivenMetrics(await createGcpMetricExporter());
  } catch (e: unknown) {
    logger.warn(
      'Failed to set up request-driven metric export on Agent Engine.',
      e,
    );
    return undefined;
  }
}

/**
 * Installs the request-path metric flushing middleware, when applicable.
 *
 * On Agent Engine's request-billed runtime CPU is throttled the instant a
 * request ends, starving background metric export. The Google Cloud exporter
 * setup builds a request-driven reader there; this drives it from the request
 * path. It is a no-op off Agent Engine.
 *
 * @param app The app to install the middleware on.
 * @param options.otelToCloud Whether telemetry is exported to Google Cloud.
 */
export async function maybeInstallRequestMetricsMiddleware(
  app: MiddlewareCapableApp,
  options: {otelToCloud: boolean},
): Promise<void> {
  if (!options.otelToCloud) {
    return;
  }
  const state = await getAgentEngineMetricsSetup();
  if (state === undefined) {
    return;
  }
  app.use(metricsFlushingMiddleware(state.reader));
}
