/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from adk-python main:
 * `tests/unittests/a2a/executor/test_a2a_agent_executor_impl.py`.
 *
 * Each `it()` keeps the Python test name so the two suites line up by name.
 * These cases drive real collaborators — a real `Runner`, a real
 * `InMemorySessionService` and a real event bus — so they also serve as the
 * end-to-end proof that the executor works without mocks.
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
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
  Runner,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {getAdkRunner} from '../../src/a2a/agent_executor.js';

const APP_NAME = 'test-app';
const TASK_ID = 'test-task-id';
const CONTEXT_ID = 'test-context-id';

/** An agent that replays a fixed list of events. */
class ScriptedAgent extends BaseAgent {
  constructor(private readonly events: AdkEvent[]) {
    super({name: 'test-agent'});
  }

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    for (const event of this.events) {
      yield event;
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    for (const event of this.events) {
      yield event;
    }
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

  it('test_resolve_runner_rejects_invalid_factory_result', async () => {
    await expect(getAdkRunner(() => ({}))).rejects.toThrow(TypeError);
    await expect(getAdkRunner(() => ({}))).rejects.toThrow(
      'Runner factory must return a Runner instance, got Object',
    );
  });

  it('test_resolve_runner_invalid_type', async () => {
    await expect(getAdkRunner('invalid')).rejects.toThrow(TypeError);
    await expect(getAdkRunner('invalid')).rejects.toThrow(
      'Runner must be a Runner instance or a callable that returns a Runner, got string',
    );
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

    const finalEvent = published[published.length - 1] as TaskStatusUpdateEvent;
    expect(finalEvent.kind).toBe('status-update');
    expect(finalEvent.status.state).toBe('failed');
    expect((finalEvent.status.message!.parts[0] as TextPart).text).toContain(
      'Test Error Message',
    );
    expect(finalEvent.metadata).toEqual(
      expect.objectContaining({
        'adk_app_name': APP_NAME,
        'adk_user_id': `A2A_USER_${CONTEXT_ID}`,
        'adk_session_id': CONTEXT_ID,
        [NEW_A2A_ADK_INTEGRATION_EXTENSION]: {adk_agent_executor_v2: true},
      }),
    );
  });

  it('test_resolve_session_creates_new_session', async () => {
    const sessionService = new InMemorySessionService();
    const getSession = vi.spyOn(sessionService, 'getSession');
    const createSession = vi.spyOn(sessionService, 'createSession');
    const executor = new A2AAgentExecutor({
      runner: createRunner([], sessionService),
    });

    await executor.execute(
      createRequestContext(),
      new DefaultExecutionEventBus(),
    );

    // The runner looks the session up again once it starts, so pin the
    // executor's own probe by position rather than by call count.
    expect(getSession).toHaveBeenNthCalledWith(1, {
      appName: APP_NAME,
      userId: `A2A_USER_${CONTEXT_ID}`,
      sessionId: CONTEXT_ID,
      config: {numRecentEvents: 0},
    });
    expect(createSession).toHaveBeenCalledWith({
      appName: APP_NAME,
      userId: `A2A_USER_${CONTEXT_ID}`,
      sessionId: CONTEXT_ID,
    });
  });
});
