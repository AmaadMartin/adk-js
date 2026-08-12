/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  Context,
  createEvent,
  createSession,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
  Runner,
} from '@google/adk';
import {Content} from '@google/genai';
import {SpanStatusCode, trace} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const SESSION_ID = 'session_1';
const USER_MESSAGE: Content = {role: 'user', parts: [{text: 'hi'}]};

/** A subclass that never assigns `this.name`, so it pins `constructor.name`. */
class AgentFailure extends Error {}

/**
 * A generator that fails before it produces anything. The failure arrives
 * through the `yield`, because a body of only `throw` has no `yield` and the
 * `require-yield` lint rule rejects it.
 */
async function* failingGenerator<T>(
  failure: unknown,
): AsyncGenerator<T, void, void> {
  yield await Promise.reject(failure);
}

/** An agent whose text and live paths both throw. */
class ThrowingAgent extends BaseAgent {
  readonly asyncFailure = new AgentFailure('agent blew up');
  readonly liveFailure = new AgentFailure('live agent blew up');

  protected runAsyncImpl(): AsyncGenerator<Event, void, void> {
    return failingGenerator(this.asyncFailure);
  }

  protected runLiveImpl(): AsyncGenerator<Event, void, void> {
    return failingGenerator(this.liveFailure);
  }
}

/** An agent that succeeds, used to pin the unchanged success path. */
class OkAgent extends BaseAgent {
  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ok'}]},
    });
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ok live'}]},
    });
  }
}

/** Satisfies `BaseLlm.connect`; these tests never open a live connection. */
class UnusedLlmConnection implements BaseLlmConnection {
  async sendHistory(_history: Content[]): Promise<void> {}
  async sendContent(_content: Content): Promise<void> {}
  async sendRealtime(_blob: {data: string; mimeType: string}): Promise<void> {}
  async *receive(): AsyncGenerator<LlmResponse, void, void> {}
  async close(): Promise<void> {}
}

/** A model that throws a caller-supplied value. */
class ThrowingLlm extends BaseLlm {
  constructor(private readonly failure: unknown) {
    super({model: 'throwing-llm'});
  }

  generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    return failingGenerator(this.failure);
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new UnusedLlmConnection();
  }
}

/** A model that answers once, used to pin the unchanged success path. */
class OkLlm extends BaseLlm {
  constructor() {
    super({model: 'ok-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    yield {content: {role: 'model', parts: [{text: 'hello'}]}};
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new UnusedLlmConnection();
  }
}

/** A plugin whose model-error recovery hook itself throws. */
class FailingRecoveryPlugin extends BasePlugin {
  constructor() {
    super('failing_recovery_plugin');
  }

  override async onModelErrorCallback(_params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    throw new Error('recovery plugin failed');
  }
}

describe('span error recording', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  // The tracer in tracing.ts caches its delegate the first time a span is
  // created, so the provider is registered once for the whole file and only
  // the exporter is reset between tests.
  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  afterEach(() => {
    exporter.reset();
  });

  function spansNamed(name: string): ReadableSpan[] {
    return exporter.getFinishedSpans().filter((span) => span.name === name);
  }

  /** Returns the one exported span with this name. */
  function onlySpan(name: string): ReadableSpan {
    const spans = spansNamed(name);
    expect(spans).toHaveLength(1);
    return spans[0];
  }

  /** Asserts a span reports the failure that ended it. */
  function expectRecordedError(
    span: ReadableSpan,
    errorType: string,
  ): ReadableSpan {
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe(errorType);
    expect(span.attributes['error.type']).toBe(errorType);
    expect(span.events.filter((e) => e.name === 'exception')).toHaveLength(1);
    return span;
  }

  /** Returns the message carried by the span's single `exception` event. */
  function exceptionMessage(span: ReadableSpan): unknown {
    const exceptions = span.events.filter((e) => e.name === 'exception');
    expect(exceptions).toHaveLength(1);
    return exceptions[0].attributes?.['exception.message'];
  }

  /** Asserts a span is untouched by the error path. */
  function expectNoRecordedError(span: ReadableSpan): void {
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect('error.type' in span.attributes).toBe(false);
    expect(span.events.filter((e) => e.name === 'exception')).toHaveLength(0);
  }

  /** Builds the parent context `BaseAgent.runAsync`/`runLive` expects. */
  function parentContextFor(agent: BaseAgent): InvocationContext {
    return new InvocationContext({
      invocationId: 'inv_1',
      session: createSession({id: SESSION_ID, appName: APP_NAME}),
      agent,
      pluginManager: new PluginManager(),
    });
  }

  async function drain(events: AsyncGenerator<Event, void, void>) {
    for await (const _event of events) {
      // Only the spans are under test, not the events.
    }
  }

  /** Drives an agent through `Runner.runAsync`, the real production path. */
  async function drainRunner(
    agent: BaseAgent,
    options: {sessionExists?: boolean; plugins?: BasePlugin[]} = {},
  ): Promise<void> {
    const sessionService = new InMemorySessionService();
    if (options.sessionExists !== false) {
      await sessionService.createSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
    }
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      plugins: options.plugins,
    });
    await drain(
      runner.runAsync({
        userId: USER_ID,
        sessionId: SESSION_ID,
        newMessage: USER_MESSAGE,
      }),
    );
  }

  describe('invoke_agent span (runAsync)', () => {
    it('records the error and rethrows the same object', async () => {
      const agent = new ThrowingAgent({name: 'throwing_agent'});

      await expect(drain(agent.runAsync(parentContextFor(agent)))).rejects.toBe(
        agent.asyncFailure,
      );

      const span = expectRecordedError(
        onlySpan('invoke_agent throwing_agent'),
        'AgentFailure',
      );
      expect(exceptionMessage(span)).toBe('agent blew up');
    });

    it('leaves the span unmarked when the agent succeeds', async () => {
      const agent = new OkAgent({name: 'ok_agent'});

      await drain(agent.runAsync(parentContextFor(agent)));

      expectNoRecordedError(onlySpan('invoke_agent ok_agent'));
    });
  });

  describe('invoke_agent span (runLive)', () => {
    it('records the error and rethrows the same object', async () => {
      const agent = new ThrowingAgent({name: 'throwing_agent'});

      await expect(drain(agent.runLive(parentContextFor(agent)))).rejects.toBe(
        agent.liveFailure,
      );

      const span = expectRecordedError(
        onlySpan('invoke_agent throwing_agent'),
        'AgentFailure',
      );
      expect(exceptionMessage(span)).toBe('live agent blew up');
    });

    it('leaves the span unmarked when the agent succeeds', async () => {
      const agent = new OkAgent({name: 'ok_agent'});

      await drain(agent.runLive(parentContextFor(agent)));

      expectNoRecordedError(onlySpan('invoke_agent ok_agent'));
    });
  });

  describe('invocation span', () => {
    it('records the agent failure on every enclosing span', async () => {
      const agent = new ThrowingAgent({name: 'throwing_agent'});

      await expect(drainRunner(agent)).rejects.toBe(agent.asyncFailure);

      expectRecordedError(
        onlySpan('invoke_agent throwing_agent'),
        'AgentFailure',
      );
      expectRecordedError(onlySpan('invocation'), 'AgentFailure');
    });

    it('records a failure the runner itself raises', async () => {
      const agent = new ThrowingAgent({name: 'throwing_agent'});

      await expect(
        drainRunner(agent, {sessionExists: false}),
      ).rejects.toThrowError(`Session not found: ${SESSION_ID}`);

      expectRecordedError(onlySpan('invocation'), 'Error');
      expect(spansNamed('invoke_agent throwing_agent')).toHaveLength(0);
    });

    it('leaves the span unmarked when the run succeeds', async () => {
      await drainRunner(new OkAgent({name: 'ok_agent'}));

      expectNoRecordedError(onlySpan('invocation'));
    });
  });

  describe('call_llm span', () => {
    // A non-`Error` value is the only model failure `runAndHandleError`
    // rethrows; an `Error` is absorbed into an error event instead.
    const MODEL_FAILURE = 'MODEL_UNAVAILABLE';

    function agentWithModel(model: BaseLlm): LlmAgent {
      return new LlmAgent({name: 'llm_agent', model});
    }

    it('is exported at all when the model throws', async () => {
      const agent = agentWithModel(new ThrowingLlm(MODEL_FAILURE));

      await expect(drainRunner(agent)).rejects.toBe(MODEL_FAILURE);

      // Before the fix `span.end()` sat after the delegation, so a throw
      // skipped it and the span never reached the exporter: length 0.
      expect(spansNamed('call_llm')).toHaveLength(1);
    });

    it('records a non-Error model failure', async () => {
      const agent = agentWithModel(new ThrowingLlm(MODEL_FAILURE));

      await expect(drainRunner(agent)).rejects.toBe(MODEL_FAILURE);

      const span = expectRecordedError(onlySpan('call_llm'), MODEL_FAILURE);
      expect(exceptionMessage(span)).toBe(MODEL_FAILURE);
    });

    it('records a failure raised by the model-error plugin', async () => {
      const agent = agentWithModel(new ThrowingLlm(new Error('model down')));

      await expect(
        drainRunner(agent, {plugins: [new FailingRecoveryPlugin()]}),
      ).rejects.toThrowError('recovery plugin failed');

      const span = expectRecordedError(onlySpan('call_llm'), 'Error');
      expect(exceptionMessage(span)).toContain('onModelErrorCallback');
    });

    it('leaves the span unmarked when the model answers', async () => {
      await drainRunner(agentWithModel(new OkLlm()));

      expectNoRecordedError(onlySpan('call_llm'));
    });
  });
});
