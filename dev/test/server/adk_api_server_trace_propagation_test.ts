/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  RunnableRoot,
} from '@google/adk';
import {context, trace} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';
const APP_NAME = 'testApp';
const INVOCATION_SPAN = 'invocation';
const AE_TRACEPARENT_HEADER = 'Google-Agent-Engine-Traceparent';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const REMOTE_SPAN_ID = '00f067aa0ba902b7';
const WELL_FORMED_TRACEPARENT = `00-${TRACE_ID}-${REMOTE_SPAN_ID}-01`;

class TestAgent extends LlmAgent {
  async *runAsyncImpl(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: invocationContext.invocationId,
      author: this.name,
      branch: invocationContext.branch,
      content: {parts: [{text: 'done'}], role: 'model'},
    });
  }
}

const TEST_AGENT = new TestAgent({
  name: 'testAgent',
  description: 'test agent',
});

/** Serves the agent from memory, so no file is compiled or cleaned up. */
class TestAgentFile extends AgentFile {
  constructor() {
    super('unused.ts');
  }

  override load(): Promise<RunnableRoot> {
    return Promise.resolve(TEST_AGENT);
  }
}

/** Serves {@link TestAgentFile} without touching the file system. */
class TestAgentLoader extends AgentLoader {
  override listAgents(): Promise<string[]> {
    return Promise.resolve([APP_NAME]);
  }

  override getAgentFile(): Promise<AgentFile> {
    return Promise.resolve(new TestAgentFile());
  }
}

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

// The test owns the global tracer provider, so it sees every span the run
// emits. The server still registers the context manager `context.with` needs,
// exactly as it does in production.
beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

async function startServer(): Promise<AdkApiServer> {
  const server = new AdkApiServer({
    agentLoader: new TestAgentLoader(),
    sessionService: new InMemorySessionService(),
    memoryService: new InMemoryMemoryService(),
    artifactService: new InMemoryArtifactService(),
  });
  await server.start();

  return server;
}

async function runAgent(
  server: AdkApiServer,
  headers: Record<string, string>,
): Promise<number> {
  const response = await fetch(`${server.url}/api/reasoning_engine`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify({
      input: {
        appName: APP_NAME,
        userId: 'user',
        sessionId: 'session',
        newMessage: {role: 'user', parts: [{text: 'hi'}]},
      },
    }),
  });

  return response.status;
}

/** Waits for the span the run raises, which ends after the response. */
function invocationSpan(): Promise<ReadableSpan> {
  return vi.waitFor(() => {
    const span = exporter
      .getFinishedSpans()
      .find((recorded) => recorded.name === INVOCATION_SPAN);
    if (!span) {
      expect.fail('the run did not record an invocation span');
    }
    return span;
  });
}

describe('Agent Engine trace propagation', () => {
  let server: AdkApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    vi.unstubAllEnvs();
    exporter.reset();
  });

  it('parents the run onto the propagated trace context', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    server = await startServer();

    const status = await runAgent(server, {
      [AE_TRACEPARENT_HEADER]: WELL_FORMED_TRACEPARENT,
    });

    expect(status).toBe(200);
    const span = await invocationSpan();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(REMOTE_SPAN_ID);
  });

  it('runs on a fresh trace when the header is rejected', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    server = await startServer();

    const status = await runAgent(server, {[AE_TRACEPARENT_HEADER]: 'x'});

    expect(status).toBe(200);
    const span = await invocationSpan();
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('ignores the header off Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);
    server = await startServer();

    const status = await runAgent(server, {
      [AE_TRACEPARENT_HEADER]: WELL_FORMED_TRACEPARENT,
    });

    expect(status).toBe(200);
    const span = await invocationSpan();
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span.parentSpanContext).toBeUndefined();
  });
});
