/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Engine telemetry tests ported from adk-python
 * `tests/unittests/telemetry/test_agent_engine.py`.
 *
 * Every `it()` keeps the Python test name verbatim, so a reviewer can grep the
 * reference suite for it. Where the assertion is expressed differently, the
 * reason is on the test.
 */

import {getPropagatedContext, TopSpanProcessor} from '@google/adk';
import {Context, context, propagation} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const AE_TRACEPARENT_HEADER = 'google-agent-engine-traceparent';
const TRACEPARENT_HEADER = 'traceparent';
const SUPPORT_ID_ATTRIBUTE = 'supportID';
const SUPPORT_ID_VALUE = 'support-id-value';
const TOP_SPAN = 'invocation';
const CHILD_SPAN = 'child';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const REMOTE_SPAN_ID = '00f067aa0ba902b7';
const WELL_FORMED_TRACEPARENT = `00-${TRACE_ID}-${REMOTE_SPAN_ID}-01`;

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

/** The counterpart of adk-python's `_record_spans`. */
function recordSpans(ctx: Context): Record<string, ReadableSpan> {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new TopSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('agent_engine_parity_test');

  context.with(ctx, () => {
    tracer.startActiveSpan(TOP_SPAN, (topSpan) => {
      tracer.startActiveSpan(CHILD_SPAN, (childSpan) => {
        childSpan.end();
      });
      topSpan.end();
    });
  });

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

describe('trace context propagation', () => {
  it.each(REJECTED_TRACEPARENT_VALUES)(
    'test_rejected_header_still_produces_child_spans [%j]',
    (headerValue) => {
      const spans = recordSpans(
        getPropagatedContext({[AE_TRACEPARENT_HEADER]: headerValue}),
      );

      expect(Object.keys(spans).sort()).toEqual([CHILD_SPAN, TOP_SPAN]);
    },
  );

  it.each(REJECTED_TRACEPARENT_VALUES)(
    'test_rejected_header_is_not_stored_in_baggage [%j]',
    (headerValue) => {
      const ctx = getPropagatedContext({
        [AE_TRACEPARENT_HEADER]: headerValue,
      });

      expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBeUndefined();
    },
  );

  it.each(REJECTED_TRACEPARENT_VALUES)(
    'test_rejected_value_in_baggage_still_produces_child_spans [%j]',
    (baggageEntry) => {
      const spans = recordSpans(
        withBaggage(context.active(), TRACEPARENT_HEADER, baggageEntry),
      );

      expect(Object.keys(spans).sort()).toEqual([CHILD_SPAN, TOP_SPAN]);
    },
  );

  it('test_well_formed_header_is_stored_in_baggage', () => {
    const ctx = getPropagatedContext({
      [AE_TRACEPARENT_HEADER]: WELL_FORMED_TRACEPARENT,
    });

    expect(baggageValue(ctx, TRACEPARENT_HEADER)).toBe(WELL_FORMED_TRACEPARENT);
  });

  it('test_well_formed_header_marks_first_span_as_top_span', () => {
    const spans = recordSpans(
      getPropagatedContext({
        [AE_TRACEPARENT_HEADER]: WELL_FORMED_TRACEPARENT,
        [TRACEPARENT_HEADER]: SUPPORT_ID_VALUE,
      }),
    );

    // Python compares the parent span id as an integer; the JS SDK exposes it
    // as the hex string the header carried.
    expect(spans[TOP_SPAN].parentSpanContext?.spanId).toBe(REMOTE_SPAN_ID);
    expect(spans[TOP_SPAN].attributes[SUPPORT_ID_ATTRIBUTE]).toBe(
      SUPPORT_ID_VALUE,
    );
    expect(spans[CHILD_SPAN].attributes).not.toHaveProperty(
      SUPPORT_ID_ATTRIBUTE,
    );
  });

  it('test_first_span_is_parentless_when_header_is_rejected', () => {
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
});
