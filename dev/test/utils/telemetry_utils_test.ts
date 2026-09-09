/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {
  BaseLlm,
  FunctionTool,
  getPropagatedContext,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import type {Part} from '@google/genai';
import {context, propagation, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import type {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
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
import {z} from 'zod';

import {
  ApiServerSpanExporter,
  setupTelemetry,
} from '../../src/utils/telemetry_utils.js';

/** Calls `getWeather` once, then answers with text. */
class WeatherCallingLlm extends BaseLlm {
  private calls = 0;

  constructor() {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const part: Part =
      this.calls++ === 0
        ? {functionCall: {id: 'fc_1', name: 'getWeather', args: {city: 'Oslo'}}}
        : {text: 'It is sunny in Oslo.'};
    yield {content: {role: 'model', parts: [part]}} as LlmResponse;
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('WeatherCallingLlm does not support live mode.');
  }
}

// `setupTelemetry` below installs its own OpenTelemetry providers, and the ADK
// tracer binds to the first provider it sees. This suite therefore runs first,
// so the tool span reaches the exporter under test.
describe('ApiServerSpanExporter', () => {
  const traceDict: Record<string, Record<string, unknown>> = {};
  const contextManager = new AsyncLocalStorageContextManager();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor(new ApiServerSpanExporter(traceDict)),
    ],
  });

  // The suite above disables the global providers after each of its tests, so
  // this describe installs its own here rather than at file scope.
  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    contextManager.disable();
  });

  it('stores a tool span under the id of the response event the runner emits', async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'trace_app',
      userId: 'u1',
    });
    const runner = new Runner({
      appName: 'trace_app',
      agent: new LlmAgent({
        name: 'weather_agent',
        model: new WeatherCallingLlm(),
        tools: [
          new FunctionTool({
            name: 'getWeather',
            description: 'reports the weather',
            parameters: z.object({city: z.string()}),
            execute: async ({city}) => ({forecast: `sunny in ${city}`}),
          }),
        ],
      }),
      sessionService,
    });

    const responseEventIds: string[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'weather in Oslo?'}]},
    })) {
      if (event.content?.parts?.[0]?.functionResponse) {
        responseEventIds.push(event.id);
      }
    }
    await provider.forceFlush();

    expect(responseEventIds).toHaveLength(1);
    // `/debug/trace/:eventId` reads exactly this map, so a missing key is the
    // 404 the dev UI shows for a tool call.
    expect(traceDict[responseEventIds[0]]).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'getWeather',
      'gen_ai.tool.call.id': 'fc_1',
      'gcp.vertex.agent.event_id': responseEventIds[0],
    });
  });
});

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const SUPPORT_ID_ATTRIBUTE = 'supportID';
const SUPPORT_ID_VALUE = 'support-id-value';

/**
 * Endpoint variables that would send `setupTelemetry` down its OTLP branch.
 * They are cleared so the test always exercises the same branch.
 */
const OTLP_ENDPOINT_ENV_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
];

describe('setupTelemetry top span processor', () => {
  const exporter = new InMemorySpanExporter();

  beforeEach(() => {
    for (const name of OTLP_ENDPOINT_ENV_VARS) {
      vi.stubEnv(name, undefined);
    }
    exporter.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Release the globals `maybeSetOtelProviders` registered, so the next test
    // installs its own providers.
    trace.disable();
    context.disable();
    propagation.disable();
  });

  /** Sets telemetry up, then records one root span carrying a support id. */
  async function recordTopSpan(): Promise<ReadableSpan> {
    await setupTelemetry(false, [new SimpleSpanProcessor(exporter)]);

    const ctx = getPropagatedContext({traceparent: SUPPORT_ID_VALUE});
    trace
      .getTracer('telemetry_utils_test')
      .startSpan('invocation', undefined, ctx)
      .end();

    const span = exporter.getFinishedSpans().at(0);
    if (!span) {
      expect.fail('setupTelemetry did not install the exporter');
    }
    return span;
  }

  it('records the support id on the top span on Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');

    const span = await recordTopSpan();

    expect(span.attributes[SUPPORT_ID_ATTRIBUTE]).toBe(SUPPORT_ID_VALUE);
  });

  it('installs no top span processor off Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);

    const span = await recordTopSpan();

    expect(span.attributes).not.toHaveProperty(SUPPORT_ID_ATTRIBUTE);
  });
});
