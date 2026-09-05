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
  createMetricsFlushingMiddleware,
  getAgentEngineMetricsSetup,
  getPropagatedContext,
  maybeInstallRequestMetricsMiddleware,
  TopSpanProcessor,
  type AgentEngineMetricsState,
} from '@google/adk';
import {Context, context, metrics, propagation} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {MeterProvider} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import express from 'express';
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

// Not part of the package's public surface, so imported from the module.
import {resetAgentEngineMetricsSetup} from '../../src/telemetry/agent_engine.js';
import {logger} from '../../src/utils/logger.js';
import {countEvents, serve, SpyReader} from './agent_engine_test_utils.js';

const AE_TRACEPARENT_HEADER = 'google-agent-engine-traceparent';
const TRACEPARENT_HEADER = 'traceparent';
const SUPPORT_ID_ATTRIBUTE = 'supportID';
const SUPPORT_ID_VALUE = 'support-id-value';
const TOP_SPAN = 'invocation';
const CHILD_SPAN = 'child';
const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

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

describe('metrics flushing middleware', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_middleware_glue', async () => {
    const spy = new SpyReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    let eventsAtCallNext: string[] = [];
    app.get('/', (_req, res) => {
      spy.events.push('call_next');
      eventsAtCallNext = [...spy.events];
      res.end('ab');
    });

    await serve(app, async (url) => {
      expect(await (await fetch(url)).text()).toBe('ab');
    });

    // The handler stands in for Python's `call_next`: the request-end drain
    // must not have run by the time it writes the body.
    expect(eventsAtCallNext).toEqual(['start', 'submit', 'call_next']);
    expect(spy.events).toEqual([
      'start',
      'submit',
      'call_next',
      'end',
      'submit',
    ]);
  });

  it('test_metrics_drained_on_request_end', async () => {
    const spy = new SpyReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    let drainedBeforeBody = true;
    app.get('/', (_req, res) => {
      drainedBeforeBody = spy.events.includes('end');
      res.end('x');
    });

    await serve(app, async (url) => {
      await (await fetch(url)).text();
    });

    expect(drainedBeforeBody).toBe(false);
    expect(countEvents(spy, 'end')).toBe(1);
  });

  it('test_drain_failure_does_not_break_response', async () => {
    class BoomReader extends SpyReader {
      override noteRequestEnd(): boolean {
        throw new Error('boom');
      }
    }
    const spy = new BoomReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    app.get('/', (_req, res) => {
      res.end('ab');
    });

    await serve(app, async (url) => {
      expect(await (await fetch(url)).text()).toBe('ab');
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to flush metrics on request end',
      expect.any(Error),
    );
  });

  it('test_call_next_exception_drains_and_reraises', async () => {
    const spy = new SpyReader();
    const middleware = createMetricsFlushingMiddleware(spy);
    const app = express();
    let thrown: unknown;
    // Express turns a handler's throw into an error route, so the middleware
    // is driven directly here to reach its rethrow. `req` and `res` are still
    // the real objects of a live request.
    app.get('/', (req, res) => {
      try {
        middleware(req, res, () => {
          throw new Error('boom');
        });
      } catch (e: unknown) {
        thrown = e;
        res.end('handled');
      }
    });

    await serve(app, async (url) => {
      await (await fetch(url)).text();
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toHaveProperty('message', 'boom');
    // start balanced by end even though the response was never written by the
    // handler that threw.
    expect(spy.events).toEqual(['start', 'submit', 'end', 'submit']);
  });
});

describe('request metrics middleware install', () => {
  beforeEach(() => {
    resetAgentEngineMetricsSetup();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetAgentEngineMetricsSetup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const installCases = [
    // GCP telemetry setup never ran: the reader is on no MeterProvider.
    {otelToCloud: false, withState: true, installed: false},
    // Not on Agent Engine (or setup failed): nothing to drive.
    {otelToCloud: true, withState: false, installed: false},
    {otelToCloud: true, withState: true, installed: true},
  ];

  it.each(installCases)(
    'test_maybe_install_request_metrics_middleware [%j]',
    async ({otelToCloud, withState, installed}) => {
      vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
      const spy = new SpyReader();
      const state: AgentEngineMetricsState = {
        reader: spy,
        spanProcessor: new TopSpanProcessor(),
      };
      const app = express();

      maybeInstallRequestMetricsMiddleware(app, {
        otelToCloud,
        buildMetrics: () => (withState ? state : undefined),
      });
      app.get('/', (_req, res) => {
        res.end('ok');
      });

      // Express keeps its middleware stack private, so installation is
      // asserted by whether a request reaches the reader. Python counts
      // `app.user_middleware` instead.
      await serve(app, async (url) => {
        expect(await (await fetch(url)).text()).toBe('ok');
      });

      expect(spy.events.length > 0).toBe(installed);
    },
  );
});

describe('agent engine metrics setup', () => {
  beforeEach(() => {
    resetAgentEngineMetricsSetup();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetAgentEngineMetricsSetup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    metrics.disable();
  });

  function fakeState(): AgentEngineMetricsState {
    return {reader: new SpyReader(), spanProcessor: new TopSpanProcessor()};
  }

  it('test_agent_engine_metrics_skipped_off_agent_engine', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);

    expect(getAgentEngineMetricsSetup(fakeState)).toBeUndefined();
  });

  it('test_agent_engine_metrics_skipped_when_meter_provider_installed', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    metrics.setGlobalMeterProvider(new MeterProvider());

    expect(getAgentEngineMetricsSetup(fakeState)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('A MeterProvider is already installed'),
    );
  });

  it('test_agent_engine_metrics_built_on_agent_engine', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    const state = fakeState();

    expect(getAgentEngineMetricsSetup(() => state)).toBe(state);
  });

  it('test_agent_engine_metrics_memoized', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    const state = fakeState();
    const build = vi.fn(() => state);

    const first = getAgentEngineMetricsSetup(build);
    const second = getAgentEngineMetricsSetup(build);

    expect(first).toBe(state);
    expect(second).toBe(state);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('test_agent_engine_metrics_none_when_exporter_unavailable', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    expect(getAgentEngineMetricsSetup(() => undefined)).toBeUndefined();
  });

  it('test_agent_engine_metrics_builder_takes_no_args', () => {
    // Python asserts the cached function is nullary, because `functools.cache`
    // keys on its arguments. The adk-js memo ignores the argument outright, so
    // the equivalent property is asserted directly.
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    const state = fakeState();
    const buildB = vi.fn(() => fakeState());

    const first = getAgentEngineMetricsSetup(() => state);
    const second = getAgentEngineMetricsSetup(buildB);

    expect(first).toBe(state);
    expect(second).toBe(state);
    expect(buildB).not.toHaveBeenCalled();
  });
});
