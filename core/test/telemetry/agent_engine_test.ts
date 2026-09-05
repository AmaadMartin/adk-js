/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createMetricsFlushingMiddleware,
  getAgentEngineMetricsSetup,
  getPropagatedContext,
  isAgentEngine,
  telemetryUserAgentHeaders,
  TopSpanProcessor,
  type RequestDrivenMetricReader,
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
import express, {type Response} from 'express';
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
  resetAgentEngineMetricsSetup,
} from '../../src/telemetry/agent_engine.js';
import {logger} from '../../src/utils/logger.js';
import {version} from '../../src/version.js';
import {countEvents, serve, SpyReader} from './agent_engine_test_utils.js';

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const AGENT_ENGINE_TELEMETRY_ENV_VAR =
  'GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY';
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

describe('telemetryUserAgentHeaders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is undefined when telemetry is unset', () => {
    vi.stubEnv(AGENT_ENGINE_TELEMETRY_ENV_VAR, undefined);

    expect(telemetryUserAgentHeaders()).toBeUndefined();
  });

  it('is undefined when telemetry is empty', () => {
    vi.stubEnv(AGENT_ENGINE_TELEMETRY_ENV_VAR, '');

    expect(telemetryUserAgentHeaders()).toBeUndefined();
  });

  it('reports the ADK version when telemetry is on', () => {
    vi.stubEnv(AGENT_ENGINE_TELEMETRY_ENV_VAR, 'true');

    expect(telemetryUserAgentHeaders()).toEqual({
      'User-Agent': `Vertex-Agent-Engine/${version}`,
    });
  });
});

describe('drainMetrics', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs and swallows a rejected collect', async () => {
    const reader: RequestDrivenMetricReader = {
      noteRequestStart: () => true,
      noteRequestEnd: () => true,
      submitCollect: () => Promise.reject(new Error('collect failed')),
    };

    await expect(drainMetrics(reader)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to flush metrics on request end',
      expect.any(Error),
    );
  });

  it('does not collect when the reader declines', async () => {
    const submitCollect = vi.fn(() => undefined);
    const reader: RequestDrivenMetricReader = {
      noteRequestStart: () => false,
      noteRequestEnd: () => false,
      submitCollect,
    };

    await drainMetrics(reader);

    expect(submitCollect).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('createMetricsFlushingMiddleware', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the final chunk before it drains', async () => {
    let responseUnderTest: Response | undefined;
    let stateAtDrain:
      | {headersSent: boolean; writableEnded: boolean}
      | undefined;

    class ProbeReader extends SpyReader {
      override noteRequestEnd(): boolean {
        if (responseUnderTest) {
          stateAtDrain = {
            headersSent: responseUnderTest.headersSent,
            writableEnded: responseUnderTest.writableEnded,
          };
        }
        return super.noteRequestEnd();
      }
    }

    const spy = new ProbeReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    app.get('/', (_req, res) => {
      responseUnderTest = res;
      res.end('payload');
    });

    await serve(app, async (url) => {
      expect(await (await fetch(url)).text()).toBe('payload');
    });

    // The client has every byte, and the response is not finalized yet: the
    // export runs while the request still holds CPU.
    expect(stateAtDrain).toEqual({headersSent: true, writableEnded: false});
  });

  it.each([
    {name: 'no argument', end: (res: Response) => res.end()},
    {name: 'a chunk', end: (res: Response) => res.end('body')},
    {
      name: 'a chunk and an encoding',
      end: (res: Response) => res.end('body', 'utf8'),
    },
  ])('finalizes a response ended with $name', async ({name, end}) => {
    const spy = new SpyReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    app.get('/', (_req, res) => {
      end(res);
    });

    await serve(app, async (url) => {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(name === 'no argument' ? '' : 'body');
    });

    expect(countEvents(spy, 'end')).toBe(1);
  });

  it('runs the callback a response was ended with', async () => {
    const spy = new SpyReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    let finished = false;
    app.get('/', (_req, res) => {
      res.end('body', () => {
        finished = true;
      });
    });

    await serve(app, async (url) => {
      await (await fetch(url)).text();
      await vi.waitFor(() => {
        expect(finished).toBe(true);
      });
    });

    expect(countEvents(spy, 'end')).toBe(1);
  });

  it('runs the callback of a chunkless end', async () => {
    const spy = new SpyReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    let finished = false;
    app.get('/', (_req, res) => {
      res.end(() => {
        finished = true;
      });
    });

    await serve(app, async (url) => {
      await (await fetch(url)).text();
      await vi.waitFor(() => {
        expect(finished).toBe(true);
      });
    });

    expect(countEvents(spy, 'end')).toBe(1);
  });

  it('drains once when the connection is aborted', async () => {
    const spy = new SpyReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    app.get('/', (_req, res) => {
      res.destroy();
    });

    await serve(app, async (url) => {
      await expect(fetch(url)).rejects.toThrow();
      await vi.waitFor(() => {
        expect(countEvents(spy, 'end')).toBe(1);
      });
    });

    expect(countEvents(spy, 'end')).toBe(1);
  });

  it('drains once when the response ends and the connection closes', async () => {
    const spy = new SpyReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    app.get('/', (_req, res) => {
      res.end('body');
    });

    await serve(app, async (url) => {
      expect(await (await fetch(url)).text()).toBe('body');
    });

    // `serve` closes every connection on the way out, so `close` has fired.
    expect(countEvents(spy, 'end')).toBe(1);
  });

  it('serves the request when the request-start hook throws', async () => {
    class BoomReader extends SpyReader {
      override noteRequestStart(): boolean {
        throw new Error('boom');
      }
    }
    const spy = new BoomReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    app.get('/', (_req, res) => {
      res.end('body');
    });

    await serve(app, async (url) => {
      expect(await (await fetch(url)).text()).toBe('body');
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Metrics request-start hook failed',
      expect.any(Error),
    );
  });

  it('does not collect on entry when the reader declines', async () => {
    class QuietReader extends SpyReader {
      override noteRequestStart(): boolean {
        this.events.push('start');
        return false;
      }
    }
    const spy = new QuietReader();
    const app = express();
    app.use(createMetricsFlushingMiddleware(spy));
    app.get('/', (_req, res) => {
      res.end('body');
    });

    await serve(app, async (url) => {
      expect(await (await fetch(url)).text()).toBe('body');
    });

    expect(spy.events).toEqual(['start', 'end', 'submit']);
  });
});

describe('getAgentEngineMetricsSetup', () => {
  beforeEach(() => {
    resetAgentEngineMetricsSetup();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetAgentEngineMetricsSetup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is undefined with no builder', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    expect(getAgentEngineMetricsSetup()).toBeUndefined();
  });

  it('logs and returns undefined when the builder throws', () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    const state = getAgentEngineMetricsSetup(() => {
      throw new Error('no exporter');
    });

    expect(state).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to set up request-driven metric export on Agent Engine.',
      expect.any(Error),
    );
  });
});
