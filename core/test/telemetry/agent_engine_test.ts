/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getPropagatedContext,
  isAgentEngine,
  TopSpanProcessor,
} from '@google/adk';
import {
  Context,
  context,
  propagation,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const AE_TRACEPARENT_HEADER = 'google-agent-engine-traceparent';
const TRACEPARENT_HEADER = 'traceparent';
const SUPPORT_ID_ATTRIBUTE = 'supportID';
const SUPPORT_ID_VALUE = 'support-id-value';
const TOP_SPAN = 'invocation';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const REMOTE_SPAN_ID = '00f067aa0ba902b7';
const WELL_FORMED_TRACEPARENT = `00-${TRACE_ID}-${REMOTE_SPAN_ID}-01`;
const CALLER_TRACE_ID = '11111111111111111111111111111111';
const CALLER_SPAN_ID = '2222222222222222';

const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
  context.disable();
  contextManager.disable();
});

/** Records one root span in `ctx`, with the processor under test attached. */
function recordTopSpan(ctx: Context): ReadableSpan {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new TopSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  provider
    .getTracer('agent_engine_test')
    .startSpan(TOP_SPAN, undefined, ctx)
    .end();

  const span = exporter.getFinishedSpans().at(0);
  if (!span) {
    expect.fail('the tracer recorded no span');
  }
  return span;
}

function baggageValue(ctx: Context, key: string): string | undefined {
  return propagation.getBaggage(ctx)?.getEntry(key)?.value;
}

describe('isAgentEngine', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true when the Agent Engine id is set', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    expect(isAgentEngine()).toBe(true);
  });

  it('is false when the Agent Engine id is empty', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '');

    expect(isAgentEngine()).toBe(false);
  });

  it('is false when the Agent Engine id is unset', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);

    expect(isAgentEngine()).toBe(false);
  });
});

describe('getPropagatedContext', () => {
  it('uses the first value of a repeated header', () => {
    const span = recordTopSpan(
      getPropagatedContext({
        [TRACEPARENT_HEADER]: [SUPPORT_ID_VALUE, 'second-value'],
      }),
    );

    expect(span.attributes[SUPPORT_ID_ATTRIBUTE]).toBe(SUPPORT_ID_VALUE);
  });

  it('produces a root top span when no header is present', () => {
    const ctx = getPropagatedContext({});

    const span = recordTopSpan(ctx);

    expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBeUndefined();
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.attributes).not.toHaveProperty(SUPPORT_ID_ATTRIBUTE);
  });

  it('lets the propagated parent win over an active span', () => {
    const active = trace.setSpanContext(context.active(), {
      traceId: CALLER_TRACE_ID,
      spanId: CALLER_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
    });

    const ctx = context.with(active, () =>
      getPropagatedContext({
        [AE_TRACEPARENT_HEADER]: WELL_FORMED_TRACEPARENT,
      }),
    );

    expect(trace.getSpanContext(ctx)?.spanId).toBe(REMOTE_SPAN_ID);
    expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBe(WELL_FORMED_TRACEPARENT);
  });

  it('keeps the active span when the header is rejected', () => {
    // The propagator returns the context unchanged for a rejected header, so
    // an active span must not be read as acceptance.
    const active = trace.setSpanContext(context.active(), {
      traceId: CALLER_TRACE_ID,
      spanId: CALLER_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
    });

    const ctx = context.with(active, () =>
      getPropagatedContext({[AE_TRACEPARENT_HEADER]: 'x'}),
    );

    expect(trace.getSpanContext(ctx)?.spanId).toBe(CALLER_SPAN_ID);
    expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBeUndefined();
  });
});

describe('TopSpanProcessor', () => {
  it('resolves forceFlush and shutdown', async () => {
    const processor = new TopSpanProcessor();

    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });

  it('ignores a span end', () => {
    const processor = new TopSpanProcessor();

    expect(processor.onEnd()).toBeUndefined();
  });
});
