/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  context,
  defaultTextMapGetter,
  propagation,
} from '@opentelemetry/api';
import {W3CTraceContextPropagator} from '@opentelemetry/core';
import {Span, SpanProcessor} from '@opentelemetry/sdk-trace-base';
import type {IncomingHttpHeaders} from 'node:http';

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

const TRACE_CONTEXT_PROPAGATOR = new W3CTraceContextPropagator();

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
  headers: IncomingHttpHeaders,
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
export function getPropagatedContext(headers: IncomingHttpHeaders): Context {
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
