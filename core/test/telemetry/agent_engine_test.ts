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
const CHILD_SPAN = 'child';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const REMOTE_SPAN_ID = '00f067aa0ba902b7';
const WELL_FORMED_TRACEPARENT = `00-${TRACE_ID}-${REMOTE_SPAN_ID}-01`;

const CALLER_TRACE_ID = '11111111111111111111111111111111';
const CALLER_SPAN_ID = '2222222222222222';

/**
 * Values the trace context propagator refuses, either because they do not
 * match the wire format or because the ids they carry are not usable.
 */
const REJECTED_TRACEPARENT_VALUES = [
  'x',
  '00-abc-zz-01',
  '',
  '00',
  '-',
  `00-${TRACE_ID}-${REMOTE_SPAN_ID}`,
  `00-${'0'.repeat(32)}-${REMOTE_SPAN_ID}-01`,
  `ff-${TRACE_ID}-${REMOTE_SPAN_ID}-01`,
];

const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
  context.disable();
  contextManager.disable();
});

/** Traces a child span under a top span in `ctx`, keyed by span name. */
function recordSpans(ctx: Context): Record<string, ReadableSpan> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new TopSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('agent_engine_test');

  const topSpan = tracer.startSpan(TOP_SPAN, undefined, ctx);
  const childSpan = tracer.startSpan(
    CHILD_SPAN,
    undefined,
    trace.setSpan(ctx, topSpan),
  );
  childSpan.end();
  topSpan.end();

  return Object.fromEntries(
    exporter.getFinishedSpans().map((span) => [span.name, span]),
  );
}

function baggageValue(ctx: Context, key: string): string | undefined {
  return propagation.getBaggage(ctx)?.getEntry(key)?.value;
}

function withBaggage(ctx: Context, key: string, value: string): Context {
  const baggage = propagation.getBaggage(ctx) ?? propagation.createBaggage();
  return propagation.setBaggage(ctx, baggage.setEntry(key, {value}));
}

describe('getPropagatedContext', () => {
  it.each(REJECTED_TRACEPARENT_VALUES)(
    'still produces both spans for rejected header %j',
    (headerValue) => {
      const spans = recordSpans(
        getPropagatedContext({[AE_TRACEPARENT_HEADER]: headerValue}),
      );

      expect(Object.keys(spans).sort()).toEqual([CHILD_SPAN, TOP_SPAN]);
    },
  );

  it.each(REJECTED_TRACEPARENT_VALUES)(
    'does not store rejected header %j in baggage',
    (headerValue) => {
      const ctx = getPropagatedContext({
        [AE_TRACEPARENT_HEADER]: headerValue,
      });

      expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBeUndefined();
    },
  );

  it('stores a well-formed header in baggage verbatim', () => {
    const ctx = getPropagatedContext({
      [AE_TRACEPARENT_HEADER]: WELL_FORMED_TRACEPARENT,
    });

    expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBe(WELL_FORMED_TRACEPARENT);
  });

  it('parents the top span onto the propagated span', () => {
    const spans = recordSpans(
      getPropagatedContext({
        [AE_TRACEPARENT_HEADER]: WELL_FORMED_TRACEPARENT,
        [TRACEPARENT_HEADER]: SUPPORT_ID_VALUE,
      }),
    );

    expect(spans[TOP_SPAN].parentSpanContext?.spanId).toBe(REMOTE_SPAN_ID);
    expect(spans[TOP_SPAN].spanContext().traceId).toBe(TRACE_ID);
    expect(spans[TOP_SPAN].attributes[SUPPORT_ID_ATTRIBUTE]).toBe(
      SUPPORT_ID_VALUE,
    );
    expect(spans[CHILD_SPAN].attributes).not.toHaveProperty(
      SUPPORT_ID_ATTRIBUTE,
    );
  });

  it('leaves the top span parentless when the header is rejected', () => {
    const spans = recordSpans(
      getPropagatedContext({
        [AE_TRACEPARENT_HEADER]: 'x',
        [TRACEPARENT_HEADER]: SUPPORT_ID_VALUE,
      }),
    );

    expect(spans[TOP_SPAN].parentSpanContext).toBeUndefined();
    expect(spans[TOP_SPAN].attributes[SUPPORT_ID_ATTRIBUTE]).toBe(
      SUPPORT_ID_VALUE,
    );
    expect(spans[CHILD_SPAN].attributes).not.toHaveProperty(
      SUPPORT_ID_ATTRIBUTE,
    );
  });

  it('uses the first value of a repeated header', () => {
    const spans = recordSpans(
      getPropagatedContext({
        [TRACEPARENT_HEADER]: [SUPPORT_ID_VALUE, 'second-value'],
      }),
    );

    expect(spans[TOP_SPAN].attributes[SUPPORT_ID_ATTRIBUTE]).toBe(
      SUPPORT_ID_VALUE,
    );
  });

  it('produces a root top span when no header is present', () => {
    const ctx = getPropagatedContext({});
    const spans = recordSpans(ctx);

    expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBeUndefined();
    expect(spans[TOP_SPAN].parentSpanContext).toBeUndefined();
    expect(spans[TOP_SPAN].attributes).not.toHaveProperty(SUPPORT_ID_ATTRIBUTE);
  });

  it('keeps the parent span when the header is rejected', () => {
    // The propagator returns the parent unchanged for a rejected header, so a
    // parent that already carries a valid span must not be read as acceptance.
    const parent = trace.setSpanContext(context.active(), {
      traceId: CALLER_TRACE_ID,
      spanId: CALLER_SPAN_ID,
      traceFlags: TraceFlags.SAMPLED,
    });

    const ctx = context.with(parent, () =>
      getPropagatedContext({[AE_TRACEPARENT_HEADER]: 'x'}),
    );

    expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBeUndefined();
    expect(trace.getSpanContext(ctx)?.spanId).toBe(CALLER_SPAN_ID);
  });

  it('builds on the active context', () => {
    const parent = withBaggage(context.active(), 'tenant', 'acme');

    const ctx = context.with(parent, () =>
      getPropagatedContext({[TRACEPARENT_HEADER]: SUPPORT_ID_VALUE}),
    );

    expect(baggageValue(ctx, 'tenant')).toBe('acme');
    expect(baggageValue(ctx, 'google_traceparent')).toBe(SUPPORT_ID_VALUE);
  });
});

describe('TopSpanProcessor', () => {
  it.each(REJECTED_TRACEPARENT_VALUES)(
    'still produces both spans for rejected baggage value %j',
    (baggageEntry) => {
      const spans = recordSpans(
        withBaggage(context.active(), TRACEPARENT_HEADER, baggageEntry),
      );

      expect(Object.keys(spans).sort()).toEqual([CHILD_SPAN, TOP_SPAN]);
    },
  );

  it.each(REJECTED_TRACEPARENT_VALUES)(
    'marks only the root span when baggage carries rejected value %j',
    (baggageEntry) => {
      const ctx = withBaggage(
        getPropagatedContext({[TRACEPARENT_HEADER]: SUPPORT_ID_VALUE}),
        TRACEPARENT_HEADER,
        baggageEntry,
      );

      const spans = recordSpans(ctx);

      expect(spans[TOP_SPAN].attributes[SUPPORT_ID_ATTRIBUTE]).toBe(
        SUPPORT_ID_VALUE,
      );
      expect(spans[CHILD_SPAN].attributes).not.toHaveProperty(
        SUPPORT_ID_ATTRIBUTE,
      );
    },
  );

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
