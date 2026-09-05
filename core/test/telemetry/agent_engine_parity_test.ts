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

import {
  clearAgentEngineMetricsSetupCache,
  getAgentEngineMetricsSetup,
  getPropagatedContext,
  maybeInstallRequestMetricsMiddleware,
  MetricsFlushingMiddleware,
  MiddlewareCapableApp,
  RequestDrivenMetricReader,
  RequestDrivenMetricReaderHooks,
  TopSpanProcessor,
} from '@google/adk';
import {Context, context, metrics, propagation} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {
  MeterProvider as SdkMeterProvider,
  PushMetricExporter,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {EventEmitter} from 'node:events';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  drainMetrics,
  metricsFlushingMiddleware,
} from '../../src/telemetry/agent_engine.js';
import {logger} from '../../src/utils/logger.js';

const {createGcpMetricExporter} = vi.hoisted(() => ({
  createGcpMetricExporter: vi.fn<() => Promise<PushMetricExporter>>(),
}));
vi.mock('../../src/telemetry/gcp_metric_exporter.js', () => ({
  createGcpMetricExporter,
}));

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

/** Records the order of hook and submit calls the middleware makes. */
class SpyReader implements RequestDrivenMetricReaderHooks {
  readonly events: string[] = [];

  noteRequestStart(): boolean {
    this.events.push('start');
    return true;
  }

  noteRequestEnd(): boolean {
    this.events.push('end');
    return true;
  }

  noteGenerateContentStart(): boolean {
    this.events.push('generate_content');
    return false;
  }

  submitCollect(): Promise<void> | undefined {
    this.events.push('submit');
    return undefined;
  }
}

/** Counts the middleware an app is given. */
class StubApp implements MiddlewareCapableApp {
  readonly middlewares: MetricsFlushingMiddleware[] = [];

  use(middleware: MetricsFlushingMiddleware): unknown {
    this.middlewares.push(middleware);
    return this;
  }
}

/** A push exporter that accepts everything, standing in for Cloud Monitoring. */
class StubExporter implements PushMetricExporter {
  export(
    _metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): void {
    resultCallback({code: ExportResultCode.SUCCESS});
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe('request-path metric flushing', () => {
  /**
   * adk-python drains after Starlette's response body iterator finishes.
   * Express has no such handle, so the drain rides on the response's 'close'
   * event, which also covers an aborted connection.
   */
  function drive(reader: RequestDrivenMetricReaderHooks): {
    res: EventEmitter;
    next: () => void;
  } {
    const res = new EventEmitter();
    const next = vi.fn();
    metricsFlushingMiddleware(reader)({}, res, next);
    return {res, next};
  }

  it('test_middleware_glue', () => {
    const spy = new SpyReader();

    const {res} = drive(spy);
    // The response has not closed yet: no request-end drain.
    expect(spy.events).toEqual(['start', 'submit']);
    res.emit('close');

    expect(spy.events).toEqual(['start', 'submit', 'end', 'submit']);
  });

  it('test_metrics_drained_on_request_end', () => {
    const spy = new SpyReader();

    const {res} = drive(spy);
    expect(spy.events).not.toContain('end');
    res.emit('close');
    res.emit('close');

    expect(spy.events.filter((event) => event === 'end')).toHaveLength(1);
  });

  it('test_drain_failure_does_not_break_response', () => {
    const spy = new SpyReader();
    const boom = new Error('boom');
    vi.spyOn(spy, 'noteRequestEnd').mockImplementation(() => {
      throw boom;
    });
    const error = vi.spyOn(logger, 'error');

    const {res, next} = drive(spy);

    expect(() => res.emit('close')).not.toThrow();
    expect(next).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      'Failed to flush metrics on request end',
      boom,
    );
  });

  it('test_call_next_exception_drains_and_reraises', () => {
    const spy = new SpyReader();
    const res = new EventEmitter();
    const middleware = metricsFlushingMiddleware(spy);

    expect(() =>
      middleware({}, res, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // Express still closes the response, so the start stays balanced.
    res.emit('close');

    expect(spy.events).toEqual(['start', 'submit', 'end', 'submit']);
  });

  it('logs a request-start failure and still calls next', () => {
    const spy = new SpyReader();
    const boom = new Error('boom');
    vi.spyOn(spy, 'noteRequestStart').mockImplementation(() => {
      throw boom;
    });
    const error = vi.spyOn(logger, 'error');

    const {next} = drive(spy);

    expect(next).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Metrics request-start hook failed', boom);
  });

  it('drainMetrics tolerates a reader that submits nothing', async () => {
    const spy = new SpyReader();

    await expect(drainMetrics(spy)).resolves.toBeUndefined();

    expect(spy.events).toEqual(['end', 'submit']);
  });
});

describe('the memoized Agent Engine metric setup', () => {
  beforeEach(() => {
    clearAgentEngineMetricsSetupCache();
    createGcpMetricExporter.mockResolvedValue(new StubExporter());
  });

  afterEach(() => {
    clearAgentEngineMetricsSetupCache();
    metrics.disable();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('test_agent_engine_metrics_skipped_off_agent_engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);

    await expect(getAgentEngineMetricsSetup()).resolves.toBeUndefined();
  });

  it('test_agent_engine_metrics_skipped_when_meter_provider_installed', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    metrics.setGlobalMeterProvider(new SdkMeterProvider());
    const warn = vi.spyOn(logger, 'warn');

    await expect(getAgentEngineMetricsSetup()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('test_agent_engine_metrics_built_on_agent_engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    const state = await getAgentEngineMetricsSetup();

    expect(state?.reader).toBeInstanceOf(RequestDrivenMetricReader);
    expect(state?.spanProcessor).toBeDefined();
  });

  it('test_agent_engine_metrics_memoized', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    const first = await getAgentEngineMetricsSetup();
    const second = await getAgentEngineMetricsSetup();

    expect(first).toBe(second);
    expect(createGcpMetricExporter).toHaveBeenCalledOnce();
  });

  it('test_agent_engine_metrics_none_when_exporter_unavailable', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    createGcpMetricExporter.mockRejectedValue(new Error('peer not installed'));
    const warn = vi.spyOn(logger, 'warn');

    await expect(getAgentEngineMetricsSetup()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('test_agent_engine_metrics_builder_takes_no_args', () => {
    // The memo is shared between the exporter setup and the middleware
    // install, which only holds while the builder takes no arguments.
    expect(getAgentEngineMetricsSetup.length).toBe(0);
  });

  it.each([
    // Google Cloud telemetry never ran: the reader is on no MeterProvider.
    {otelToCloud: false, onAgentEngine: true, expected: 0},
    // Not on Agent Engine, or the setup failed: nothing to drive.
    {otelToCloud: true, onAgentEngine: false, expected: 0},
    {otelToCloud: true, onAgentEngine: true, expected: 1},
  ])(
    'test_maybe_install_request_metrics_middleware [%j]',
    async ({otelToCloud, onAgentEngine, expected}) => {
      vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, onAgentEngine ? '123' : undefined);
      const app = new StubApp();

      await maybeInstallRequestMetricsMiddleware(app, {otelToCloud});

      expect(app.middlewares).toHaveLength(expected);
    },
  );
});
