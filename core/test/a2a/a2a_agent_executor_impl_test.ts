/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/a2a/executor/test_a2a_agent_executor_impl.py (branch: main).
// The `it(...)` strings keep the Python test names so the two suites can be
// matched by grep. A case with a plain description pins adk-js behaviour the
// reference has no counterpart for.

import {Message, TaskStatusUpdateEvent, TextPart} from '@a2a-js/sdk';
import {
  AgentExecutionEvent,
  DefaultExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  BaseAgent,
  createEvent,
  InMemorySessionService,
  Runner,
  RunnerOrRunnerConfig,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const APP_NAME = 'test-app';
const CONTEXT_ID = 'test-context';
const TASK_ID = 'test-task';

/** The executor derives both from the A2A context id. */
const USER_ID = `A2A_USER_${CONTEXT_ID}`;
const SESSION_ID = CONTEXT_ID;

const A2A_EXTENSION_URL =
  'https://google.github.io/adk-docs/a2a/a2a-extension/';

/** `expected_metadata` from the reference suite, with this suite's ids. */
const expectedMetadata = {
  adk_app_name: APP_NAME,
  adk_user_id: USER_ID,
  adk_session_id: SESSION_ID,
  [A2A_EXTENSION_URL]: {adk_agent_executor_v2: true},
};

/** Stands in for a model turn by yielding a fixed list of ADK events. */
class FixedEventsAgent extends BaseAgent {
  runCount = 0;

  constructor(private readonly events: AdkEvent[]) {
    super({name: 'test_agent'});
  }

  protected async *runAsyncImpl(): AsyncGenerator<AdkEvent, void, void> {
    this.runCount++;
    for (const event of this.events) {
      yield event;
    }
  }

  protected async *runLiveImpl(): AsyncGenerator<AdkEvent, void, void> {
    yield* this.runAsyncImpl();
  }
}

/**
 * Builds an executor around a value the declared type rejects. The resolver
 * guards against JavaScript callers, whom `RunnerOrRunnerConfig` cannot bind,
 * so a test of that guard has to cross the type boundary exactly once.
 */
function executorWithUnvalidatedRunner(runner: unknown): A2AAgentExecutor {
  return new A2AAgentExecutor({runner: runner as RunnerOrRunnerConfig});
}

describe('A2AAgentExecutor parity with adk-python', () => {
  let sessionService: InMemorySessionService;
  let agent: FixedEventsAgent;
  let runner: Runner;
  let eventBus: DefaultExecutionEventBus;
  let published: AgentExecutionEvent[];

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    agent = new FixedEventsAgent([]);
    runner = new Runner({appName: APP_NAME, agent, sessionService});
    published = [];
    eventBus = new DefaultExecutionEventBus();
    eventBus.on('event', (event) => {
      published.push(event);
    });
  });

  /** Sets the events the agent yields on its next run. */
  function willYield(events: AdkEvent[]): void {
    agent = new FixedEventsAgent(events);
    runner = new Runner({appName: APP_NAME, agent, sessionService});
  }

  const userMessage: Message = {
    kind: 'message',
    messageId: 'msg-1',
    role: 'user',
    parts: [{kind: 'text', text: 'hi'}],
  };

  function requestContext(): RequestContext {
    return new RequestContext(userMessage, TASK_ID, CONTEXT_ID);
  }

  /** The terminal status update, which every execution publishes last. */
  function terminalEvent(): TaskStatusUpdateEvent {
    const last = published.at(-1);
    if (last?.kind !== 'status-update') {
      return expect.fail(`last published event is ${last?.kind}`);
    }
    return last;
  }

  it('test_execute_success_new_task', async () => {
    willYield([
      createEvent({
        author: 'test_agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      }),
    ]);

    await new A2AAgentExecutor({runner}).execute(requestContext(), eventBus);

    expect(published).toHaveLength(4);
    const [submitted, working, artifact, terminal] = published;
    expect(submitted.kind).toBe('task');
    expect(submitted.metadata).toEqual(expectedMetadata);
    expect(working.metadata).toEqual(expectedMetadata);
    // The artifact update keeps its own richer per-event keys as well.
    expect(artifact.kind).toBe('artifact-update');
    expect(artifact.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
    expect(terminal.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
    expect((terminal as TaskStatusUpdateEvent).status.state).toBe('completed');
  });

  it('test_handle_request_with_error_message', async () => {
    willYield([
      createEvent({author: 'test_agent', errorMessage: 'Test Error Message'}),
    ]);

    await new A2AAgentExecutor({runner}).execute(requestContext(), eventBus);

    const terminal = terminalEvent();
    expect(terminal.status.state).toBe('failed');
    expect((terminal.status.message!.parts[0] as TextPart).text).toBe(
      'Test Error Message',
    );
    expect(terminal.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
  });

  it('reports the default text when the ADK event names only an error code', async () => {
    willYield([
      createEvent({author: 'test_agent', errorCode: 'MALFORMED_FUNCTION_CALL'}),
    ]);

    await new A2AAgentExecutor({runner}).execute(requestContext(), eventBus);

    const terminal = terminalEvent();
    expect((terminal.status.message!.parts[0] as TextPart).text).toBe(
      'An error occurred during processing',
    );
    expect(terminal.metadata).toEqual(
      expect.objectContaining({adk_error_code: 'MALFORMED_FUNCTION_CALL'}),
    );
  });

  it('test_resolve_session_creates_new_session', async () => {
    const getSession = vi.spyOn(sessionService, 'getSession');
    const createSession = vi.spyOn(sessionService, 'createSession');
    willYield([]);

    await new A2AAgentExecutor({runner}).execute(requestContext(), eventBus);

    // Divergence from the reference, which passes
    // `GetSessionConfig(num_recent_events=0)` because it only probes for
    // existence. adk-js feeds these events to `getUnansweredRequestEvent`, so
    // the executor's own lookup, the first one, must ask for the history. The
    // runner looks the session up again later, which is why this pins call 1.
    expect(getSession).toHaveBeenNthCalledWith(1, {
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(createSession).toHaveBeenCalledWith({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  it('holds an unanswered session request open, with the history the lookup returned', async () => {
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    await sessionService.appendEvent({
      session: (await sessionService.getSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      }))!,
      event: createEvent({
        author: 'test_agent',
        longRunningToolIds: ['req-1'],
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'req-1',
                name: 'adk_request_confirmation',
                args: {},
              },
            },
          ],
        },
      }),
    });
    willYield([]);

    await new A2AAgentExecutor({runner}).execute(requestContext(), eventBus);

    expect(agent.runCount).toBe(0);
    const terminal = terminalEvent();
    expect(terminal.status.state).toBe('input-required');
  });

  it('test_long_running_functions_final_event', async () => {
    willYield([
      createEvent({
        author: 'test_agent',
        longRunningToolIds: ['call-1'],
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-1', name: 'ask_human', args: {}}}],
        },
      }),
    ]);

    await new A2AAgentExecutor({runner}).execute(requestContext(), eventBus);

    const terminal = terminalEvent();
    expect(terminal.status.state).toBe('input-required');
    expect(terminal.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
  });

  it('converts published artifact parts with the configured converter', async () => {
    willYield([
      createEvent({
        author: 'test_agent',
        content: {role: 'model', parts: [{text: 'original'}]},
      }),
    ]);

    await new A2AAgentExecutor({
      runner,
      genAiPartConverter: () => ({kind: 'text', text: 'converted'}),
    }).execute(requestContext(), eventBus);

    const artifact = published[2];
    if (artifact?.kind !== 'artifact-update') {
      return expect.fail(`third published event is ${artifact?.kind}`);
    }
    expect((artifact.artifact.parts[0] as TextPart).text).toBe('converted');
  });

  it('publishes every part when the converter expands one into several', async () => {
    willYield([
      createEvent({
        author: 'test_agent',
        content: {role: 'model', parts: [{text: 'original'}]},
      }),
    ]);

    await new A2AAgentExecutor({
      runner,
      genAiPartConverter: () => [
        {kind: 'text', text: 'first'},
        {kind: 'text', text: 'second'},
      ],
    }).execute(requestContext(), eventBus);

    const artifact = published[2];
    if (artifact?.kind !== 'artifact-update') {
      return expect.fail(`third published event is ${artifact?.kind}`);
    }
    expect(
      artifact.artifact.parts.map((part) => (part as TextPart).text),
    ).toEqual(['first', 'second']);
  });

  it('drops an artifact whose parts the configured converter discards', async () => {
    willYield([
      createEvent({
        author: 'test_agent',
        content: {role: 'model', parts: [{text: 'original'}]},
      }),
    ]);

    await new A2AAgentExecutor({
      runner,
      genAiPartConverter: () => undefined,
    }).execute(requestContext(), eventBus);

    // Submitted task, working, terminal: the artifact update had no parts.
    expect(published).toHaveLength(3);
  });

  it('test_resolve_runner_direct_instance', async () => {
    willYield([]);

    await new A2AAgentExecutor({runner}).execute(requestContext(), eventBus);

    expect(agent.runCount).toBe(1);
  });

  it('test_resolve_runner_sync_callable', async () => {
    willYield([]);

    await new A2AAgentExecutor({runner: () => runner}).execute(
      requestContext(),
      eventBus,
    );

    expect(agent.runCount).toBe(1);
  });

  it('test_resolve_runner_async_callable', async () => {
    willYield([]);

    await new A2AAgentExecutor({runner: async () => runner}).execute(
      requestContext(),
      eventBus,
    );

    expect(agent.runCount).toBe(1);
  });

  it('test_resolve_runner_future', async () => {
    willYield([]);
    const pending = Promise.resolve(runner);

    await new A2AAgentExecutor({runner: () => pending}).execute(
      requestContext(),
      eventBus,
    );

    expect(agent.runCount).toBe(1);
  });

  it('resolves a runner config into a Runner', async () => {
    const executor = new A2AAgentExecutor({
      runner: {appName: APP_NAME, agent, sessionService},
    });

    await expect(
      executor.execute(requestContext(), eventBus),
    ).resolves.toBeUndefined();
    expect(terminalEvent().status.state).toBe('completed');
  });

  it('test_resolve_runner_rejects_invalid_factory_result', async () => {
    const executor = executorWithUnvalidatedRunner(() => ({}));

    await expect(executor.execute(requestContext(), eventBus)).rejects.toThrow(
      new TypeError('Runner factory must return a Runner instance, got object'),
    );
  });

  it('test_resolve_runner_invalid_type', async () => {
    const executor = executorWithUnvalidatedRunner('invalid');

    await expect(executor.execute(requestContext(), eventBus)).rejects.toThrow(
      new TypeError(
        'Runner must be a Runner instance or a callable that returns a Runner, got string',
      ),
    );
  });

  it('names null rather than reporting it as an object', async () => {
    const executor = executorWithUnvalidatedRunner(null);

    await expect(executor.execute(requestContext(), eventBus)).rejects.toThrow(
      /got null$/,
    );
  });

  it('reports the type only, never the rejected value', async () => {
    const executor = executorWithUnvalidatedRunner('super-secret-token');

    await expect(executor.execute(requestContext(), eventBus)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('super-secret-token'),
      }),
    );
  });
});
