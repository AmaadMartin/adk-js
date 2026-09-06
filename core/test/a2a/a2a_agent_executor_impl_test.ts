/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from adk-python main:
 * `tests/unittests/a2a/executor/test_a2a_agent_executor_impl.py`.
 *
 * Each `it()` keeps the Python test name so the two suites line up by name. A
 * case with a plain description pins adk-js behaviour the reference has no
 * counterpart for. These cases drive real collaborators — a real `Runner`, a
 * real `InMemorySessionService` and a real event bus — so they also serve as
 * the end-to-end proof that the executor works without mocks.
 */

import {TaskStatusUpdateEvent, TextPart} from '@a2a-js/sdk';
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
  InvocationContext,
  Runner,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {getAdkRunner} from '../../src/a2a/agent_executor.js';
import {NEW_A2A_ADK_INTEGRATION_EXTENSION} from '../../src/a2a/metadata_converter_utils.js';

const APP_NAME = 'test-app';
const TASK_ID = 'test-task-id';
const CONTEXT_ID = 'test-context-id';

/** The executor derives both from the A2A context id. */
const USER_ID = `A2A_USER_${CONTEXT_ID}`;
const SESSION_ID = CONTEXT_ID;

/** `expected_metadata` from the reference suite, with this suite's ids. */
const expectedMetadata = {
  'adk_app_name': APP_NAME,
  'adk_user_id': USER_ID,
  'adk_session_id': SESSION_ID,
  [NEW_A2A_ADK_INTEGRATION_EXTENSION]: {adk_agent_executor_v2: true},
};

/** An agent that replays a fixed list of events. */
class ScriptedAgent extends BaseAgent {
  runCount = 0;

  constructor(private readonly events: AdkEvent[]) {
    super({name: 'test-agent'});
  }

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    this.runCount++;
    for (const event of this.events) {
      yield event;
    }
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    yield* this.runAsyncImpl(context);
  }
}

function createRunner(
  events: AdkEvent[] = [],
  sessionService = new InMemorySessionService(),
): Runner {
  return new Runner({
    appName: APP_NAME,
    agent: new ScriptedAgent(events),
    sessionService,
  });
}

function createRequestContext(): RequestContext {
  return new RequestContext(
    {
      kind: 'message',
      messageId: 'msg-1',
      role: 'user',
      parts: [{kind: 'text', text: 'hello'}],
    },
    TASK_ID,
    CONTEXT_ID,
  );
}

/** Collects everything published on a real event bus. */
function recordPublishedEvents(
  bus: DefaultExecutionEventBus,
): AgentExecutionEvent[] {
  const published: AgentExecutionEvent[] = [];
  bus.on('event', (event) => published.push(event));

  return published;
}

/** The terminal status update, which every execution publishes last. */
function terminalEvent(
  published: AgentExecutionEvent[],
): TaskStatusUpdateEvent {
  const last = published.at(-1);
  if (last?.kind !== 'status-update') {
    return expect.fail(`last published event is ${last?.kind}`);
  }

  return last;
}

describe('a2a_agent_executor_impl parity', () => {
  it('test_resolve_runner_direct_instance', async () => {
    const runner = createRunner();

    await expect(getAdkRunner(runner)).resolves.toBe(runner);
  });

  it('test_resolve_runner_sync_callable', async () => {
    const runner = createRunner();

    await expect(getAdkRunner(() => runner)).resolves.toBe(runner);
  });

  it('test_resolve_runner_async_callable', async () => {
    const runner = createRunner();

    await expect(getAdkRunner(async () => runner)).resolves.toBe(runner);
  });

  it('test_resolve_runner_future', async () => {
    const runner = createRunner();
    const pending = Promise.resolve(runner);

    await expect(getAdkRunner(() => pending)).resolves.toBe(runner);
  });

  it('resolves a runner config into a Runner', async () => {
    await expect(
      getAdkRunner({
        appName: APP_NAME,
        agent: new ScriptedAgent([]),
        sessionService: new InMemorySessionService(),
      }),
    ).resolves.toBeInstanceOf(Runner);
  });

  it('test_resolve_runner_rejects_invalid_factory_result', async () => {
    await expect(getAdkRunner(() => ({}))).rejects.toThrow(TypeError);
    await expect(getAdkRunner(() => ({}))).rejects.toThrow(
      'Runner factory must return a Runner or a runner config, got Object',
    );
  });

  it('test_resolve_runner_invalid_type', async () => {
    await expect(getAdkRunner('invalid')).rejects.toThrow(TypeError);
    await expect(getAdkRunner('invalid')).rejects.toThrow(
      'Runner must be a Runner instance or a callable that returns a Runner, got string',
    );
  });

  it('names null rather than reporting it as an object', async () => {
    await expect(getAdkRunner(null)).rejects.toThrow(/got null$/);
  });

  it('reports the type only, never the rejected value', async () => {
    await expect(getAdkRunner('super-secret-token')).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('super-secret-token'),
      }),
    );
  });

  it('test_execute_success_new_task', async () => {
    const runner = createRunner([
      createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      }),
    ]);
    const bus = new DefaultExecutionEventBus();
    const published = recordPublishedEvents(bus);

    await new A2AAgentExecutor({runner}).execute(createRequestContext(), bus);

    const [submitted, working, artifact] = published;
    expect(submitted.kind).toBe('task');
    expect(submitted.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
    expect(working.metadata).toEqual(expect.objectContaining(expectedMetadata));
    // The artifact update keeps its own richer per-event keys as well.
    expect(artifact.kind).toBe('artifact-update');
    expect(artifact.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
    const terminal = terminalEvent(published);
    expect(terminal.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
    expect(terminal.status.state).toBe('completed');
  });

  it('test_handle_request_with_error_message', async () => {
    const sessionService = new InMemorySessionService();
    const runner = createRunner(
      [
        createEvent({
          author: 'test-agent',
          branch: 'main',
          partial: false,
          errorMessage: 'Test Error Message',
        }),
      ],
      sessionService,
    );
    const executor = new A2AAgentExecutor({runner});
    const bus = new DefaultExecutionEventBus();
    const published = recordPublishedEvents(bus);

    await executor.execute(createRequestContext(), bus);

    const finalEvent = terminalEvent(published);
    expect(finalEvent.status.state).toBe('failed');
    expect((finalEvent.status.message!.parts[0] as TextPart).text).toContain(
      'Test Error Message',
    );
    expect(finalEvent.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
  });

  it('reports the default text when the ADK event names only an error code', async () => {
    const runner = createRunner([
      createEvent({author: 'test-agent', errorCode: 'MALFORMED_FUNCTION_CALL'}),
    ]);
    const bus = new DefaultExecutionEventBus();
    const published = recordPublishedEvents(bus);

    await new A2AAgentExecutor({runner}).execute(createRequestContext(), bus);

    const terminal = terminalEvent(published);
    expect((terminal.status.message!.parts[0] as TextPart).text).toContain(
      'An error occurred during processing',
    );
    expect(terminal.metadata).toEqual(
      expect.objectContaining({adk_error_code: 'MALFORMED_FUNCTION_CALL'}),
    );
  });

  it('test_resolve_session_creates_new_session', async () => {
    const sessionService = new InMemorySessionService();
    const getSession = vi.spyOn(sessionService, 'getSession');
    const createSession = vi.spyOn(sessionService, 'createSession');
    const runner = createRunner([], sessionService);
    const bus = new DefaultExecutionEventBus();

    await new A2AAgentExecutor({runner}).execute(createRequestContext(), bus);

    // Matches the reference, which passes `GetSessionConfig(num_recent_events=0)`
    // because it only probes for existence.
    expect(getSession).toHaveBeenNthCalledWith(1, {
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      config: {numRecentEvents: 0},
    });
    expect(createSession).toHaveBeenCalledWith({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  it('holds an unanswered session request open, with the history the lookup returned', async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    await sessionService.appendEvent({
      session,
      event: createEvent({
        author: 'test-agent',
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
    const agent = new ScriptedAgent([]);
    const runner = new Runner({appName: APP_NAME, agent, sessionService});
    const bus = new DefaultExecutionEventBus();
    const published = recordPublishedEvents(bus);

    await new A2AAgentExecutor({runner}).execute(createRequestContext(), bus);

    expect(agent.runCount).toBe(0);
    expect(terminalEvent(published).status.state).toBe('input-required');
  });

  it('test_long_running_functions_final_event', async () => {
    const runner = createRunner([
      createEvent({
        author: 'test-agent',
        longRunningToolIds: ['call-1'],
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-1', name: 'ask_human', args: {}}}],
        },
      }),
    ]);
    const bus = new DefaultExecutionEventBus();
    const published = recordPublishedEvents(bus);

    await new A2AAgentExecutor({runner}).execute(createRequestContext(), bus);

    const terminal = terminalEvent(published);
    expect(terminal.status.state).toBe('input-required');
    expect(terminal.metadata).toEqual(
      expect.objectContaining(expectedMetadata),
    );
  });

  it('converts published artifact parts with the configured converter', async () => {
    const runner = createRunner([
      createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'original'}]},
      }),
    ]);
    const bus = new DefaultExecutionEventBus();
    const published = recordPublishedEvents(bus);

    await new A2AAgentExecutor({
      runner,
      genAiPartConverter: () => ({kind: 'text', text: 'converted'}),
    }).execute(createRequestContext(), bus);

    const artifact = published.find((e) => e.kind === 'artifact-update');
    if (artifact?.kind !== 'artifact-update') {
      return expect.fail('no artifact update was published');
    }
    expect((artifact.artifact.parts[0] as TextPart).text).toBe('converted');
  });

  it('publishes every part when the converter expands one into several', async () => {
    const runner = createRunner([
      createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'original'}]},
      }),
    ]);
    const bus = new DefaultExecutionEventBus();
    const published = recordPublishedEvents(bus);

    await new A2AAgentExecutor({
      runner,
      genAiPartConverter: () => [
        {kind: 'text', text: 'first'},
        {kind: 'text', text: 'second'},
      ],
    }).execute(createRequestContext(), bus);

    const artifact = published.find((e) => e.kind === 'artifact-update');
    if (artifact?.kind !== 'artifact-update') {
      return expect.fail('no artifact update was published');
    }
    expect(
      artifact.artifact.parts.map((part) => (part as TextPart).text),
    ).toEqual(['first', 'second']);
  });

  it('drops an artifact whose parts the configured converter discards', async () => {
    const runner = createRunner([
      createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'original'}]},
      }),
    ]);
    const bus = new DefaultExecutionEventBus();
    const published = recordPublishedEvents(bus);

    await new A2AAgentExecutor({
      runner,
      genAiPartConverter: () => undefined,
    }).execute(createRequestContext(), bus);

    expect(published.some((e) => e.kind === 'artifact-update')).toBe(false);
  });
});
