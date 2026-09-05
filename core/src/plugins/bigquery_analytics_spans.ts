/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isSpanContextValid, trace} from '@opentelemetry/api';
import {randomUUID} from '../utils/env_aware_utils.js';

/**
 * Span bookkeeping for the BigQuery analytics plugin.
 *
 * adk-python keys this state on `contextvars`. Node cannot assign an
 * `AsyncLocalStorage` from inside a framework-invoked callback, so a stack per
 * invocation id gives the same isolation: two invocations running at once
 * never share a stack.
 */

/**
 * Invocations whose span stacks are kept at once. An invocation whose
 * `afterRunCallback` never fires would otherwise leak a stack forever, so the
 * oldest entries are evicted past this cap.
 */
const MAX_TRACKED_INVOCATIONS = 1024;

/** What pushed a span, so an error callback only pops a span it owns. */
export enum SpanKind {
  INVOCATION = 'invocation',
  AGENT = 'agent',
  LLM_REQUEST = 'llm_request',
  TOOL = 'tool',
}

/** One entry of an invocation's span stack. */
export interface SpanRecord {
  spanId: string;
  traceId: string;
  startTimeMs: number;
  kind: SpanKind;
  firstTokenTimeMs?: number;
}

/** A 32-hex-character identifier. */
export function newHexId(): string {
  return randomUUID().replaceAll('-', '');
}

/** A 16-hex-character identifier, the shape OpenTelemetry uses for a span id. */
function newSpanId(): string {
  return newHexId().slice(0, 16);
}

/**
 * The ambient OpenTelemetry ids, when a valid span is active, keyed as the
 * `attributes.otel` object writes them.
 *
 * This is a best-effort join key onto a Cloud Trace export, not a foreign key:
 * a span the exporter did not sample is absent from it.
 */
export function ambientOtelIds():
  | {span_id: string; trace_id: string}
  | undefined {
  const context = trace.getActiveSpan()?.spanContext();
  return context !== undefined && isSpanContextValid(context)
    ? {span_id: context.spanId, trace_id: context.traceId}
    : undefined;
}

/** Milliseconds since `span` started, or undefined when there is no span. */
export function elapsedSince(span: SpanRecord | undefined): number | undefined {
  return span === undefined ? undefined : Date.now() - span.startTimeMs;
}

/** Milliseconds from a span's start to its first token, when one was seen. */
export function timeToFirstToken(
  span: SpanRecord | undefined,
): number | undefined {
  return span?.firstTokenTimeMs === undefined
    ? undefined
    : span.firstTokenTimeMs - span.startTimeMs;
}

/** A stack of open spans per invocation, bounded in the invocations it keeps. */
export class SpanTracker {
  private readonly stacks = new Map<string, SpanRecord[]>();

  /** Seeds the invocation's root span, unless one already exists. */
  ensureInvocation(invocationId: string): void {
    if (this.stackFor(invocationId).length > 0) {
      return;
    }
    this.push(invocationId, SpanKind.INVOCATION);
  }

  /**
   * Pushes a span. Its trace id comes from the span below it, then from the
   * ambient OpenTelemetry span, then from a fresh value — so every row of one
   * invocation shares one trace id.
   */
  push(invocationId: string, kind: SpanKind): SpanRecord {
    const stack = this.stackFor(invocationId);
    const record: SpanRecord = {
      spanId: newSpanId(),
      traceId:
        stack.at(-1)?.traceId ?? ambientOtelIds()?.trace_id ?? newHexId(),
      startTimeMs: Date.now(),
      kind,
    };
    stack.push(record);
    return record;
  }

  /**
   * Pops the top span, leaving the stack untouched when `expectedKind` does
   * not match. Error callbacks pass a kind so they never pop a span that
   * belongs to an enclosing agent or invocation.
   */
  pop(invocationId: string, expectedKind?: SpanKind): SpanRecord | undefined {
    const stack = this.stacks.get(invocationId) ?? [];
    const top = stack.at(-1);
    if (top === undefined) {
      return undefined;
    }
    if (expectedKind !== undefined && top.kind !== expectedKind) {
      return undefined;
    }
    stack.pop();
    return top;
  }

  /** The invocation's innermost open span. */
  current(invocationId: string): SpanRecord | undefined {
    return this.stacks.get(invocationId)?.at(-1);
  }

  /** The span enclosing the invocation's innermost open span. */
  parentSpanId(invocationId: string): string | undefined {
    return this.stacks.get(invocationId)?.at(-2)?.spanId;
  }

  /** The invocation's trace id, falling back to the ambient span then its id. */
  traceId(invocationId: string): string {
    return (
      this.current(invocationId)?.traceId ??
      ambientOtelIds()?.trace_id ??
      invocationId
    );
  }

  /** Drops the invocation's stack once its run is over. */
  forget(invocationId: string): void {
    this.stacks.delete(invocationId);
  }

  /** Drops every stack. */
  clear(): void {
    this.stacks.clear();
  }

  /**
   * Returns the invocation's span stack, creating it and evicting the oldest
   * tracked invocations once the cap is reached.
   */
  private stackFor(invocationId: string): SpanRecord[] {
    const existing = this.stacks.get(invocationId);
    if (existing !== undefined) {
      return existing;
    }
    for (const oldest of this.stacks.keys()) {
      if (this.stacks.size < MAX_TRACKED_INVOCATIONS) {
        break;
      }
      this.stacks.delete(oldest);
    }
    const stack: SpanRecord[] = [];
    this.stacks.set(invocationId, stack);
    return stack;
  }
}
