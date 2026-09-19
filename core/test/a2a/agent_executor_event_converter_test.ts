/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the legacy `eventConverter` slot on the A2A executor config.
 *
 * Reference: google/adk-python@a3bd1115
 * - src/google/adk/a2a/executor/config.py declares `event_converter` and
 *   `adk_event_converter` as two slots with different signatures.
 * - tests/unittests/a2a/executor/test_a2a_agent_executor.py asserts the
 *   arguments the legacy executor passes to `event_converter`.
 *
 * Divergence: adk-python passes `(event, invocation_context, task_id,
 * context_id, gen_ai_part_converter)`. adk-js passes `(adkEvent,
 * executorContext, genAiPartConverter)`, and `executorContext.requestContext`
 * carries both ids. adk-python has one executor class per slot; adk-js has one
 * executor class, so `eventConverter` wins when both slots are set.
 */

import {
  Part as A2APart,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  AdkEventToA2AEventsConverter,
  AdkEventToA2AEventsConverterImpl,
  BaseSessionService,
  createEvent,
  createEventActions,
  createSession,
  ExecutorContext,
  GenAIPartToA2APartConverter,
  Runner,
  RunnerConfig,
} from '@google/adk';
import {beforeEach, describe, expect, it, Mocked, vi} from 'vitest';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation((config: RunnerConfig) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: vi.fn(),
    })),
  };
});

const TASK_ID = 'test-task';
const CONTEXT_ID = 'test-context';

describe('A2AAgentExecutor eventConverter slot', () => {
  let mockSessionService: Mocked<BaseSessionService>;
  let mockEventBus: Mocked<ExecutionEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionService = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      getOrCreateSession: vi.fn(),
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
      appendEvent: vi.fn(),
    } as unknown as Mocked<BaseSessionService>;

    mockEventBus = {publish: vi.fn()} as unknown as Mocked<ExecutionEventBus>;

    mockSessionService.getSession.mockResolvedValue(
      createSession({
        id: 'session-id',
        userId: 'test-user',
        appName: 'test-app',
      }),
    );
  });

  const createRequestContext = (): RequestContext =>
    ({
      contextId: CONTEXT_ID,
      taskId: TASK_ID,
      userMessage: {role: 'user', parts: [{kind: 'text', text: 'hello'}]},
    }) as unknown as RequestContext;

  const runnerConfig = (): RunnerConfig => ({
    appName: 'test-app',
    sessionService: mockSessionService,
  });

  const stubRunnerWith = (adkEvents: AdkEvent[]) => {
    async function* runAsync() {
      for (const adkEvent of adkEvents) {
        yield adkEvent;
      }
    }
    vi.mocked(Runner).mockImplementation(
      ((config: RunnerConfig) =>
        ({
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync,
        }) as unknown as Runner) as unknown as () => Runner,
    );
  };

  const modelEvent = (text: string, partial = false): AdkEvent =>
    createEvent({
      author: 'model',
      content: {role: 'model', parts: [{text}]},
      partial,
      actions: createEventActions(),
    });

  const stubPartConverter = (): GenAIPartToA2APartConverter =>
    vi.fn((): A2APart => ({kind: 'text', text: 'converted'}));

  const workingStatusEvent = (): TaskStatusUpdateEvent => ({
    kind: 'status-update',
    taskId: TASK_ID,
    contextId: CONTEXT_ID,
    final: false,
    status: {state: 'working'},
  });

  /** Returns every artifact update the executor published. */
  const publishedArtifactUpdates = (): TaskArtifactUpdateEvent[] =>
    mockEventBus.publish.mock.calls
      .map(([event]) => event)
      .filter(
        (event): event is TaskArtifactUpdateEvent =>
          event.kind === 'artifact-update',
      );

  it('test_execute_success_new_task (legacy: event_converter arguments)', async () => {
    const adkEvent = modelEvent('response');
    stubRunnerWith([adkEvent]);

    const genAiPartConverter = stubPartConverter();
    const converted = workingStatusEvent();
    let seenContext: ExecutorContext | undefined;
    const eventConverter: AdkEventToA2AEventsConverter = vi.fn(
      (_adkEvent, ctx) => {
        seenContext = ctx;
        return [converted];
      },
    );

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      genAiPartConverter,
      eventConverter,
    });
    await executor.execute(createRequestContext(), mockEventBus);

    expect(eventConverter).toHaveBeenCalledTimes(1);
    expect(eventConverter).toHaveBeenCalledWith(
      adkEvent,
      expect.anything(),
      genAiPartConverter,
    );
    expect(seenContext?.requestContext.taskId).toBe(TASK_ID);
    expect(seenContext?.requestContext.contextId).toBe(CONTEXT_ID);
    expect(seenContext?.appName).toBe('test-app');

    expect(mockEventBus.publish).toHaveBeenNthCalledWith(3, converted);
    expect(converted.metadata).toMatchObject({
      'adk_app_name': 'test-app',
      'adk_user_id': 'test-user',
      'adk_session_id': 'session-id',
      'adk_author': 'model',
    });
  });

  it('prefers eventConverter over adkEventConverter when both are set', async () => {
    stubRunnerWith([modelEvent('response')]);

    const eventConverter: AdkEventToA2AEventsConverter = vi.fn(() => []);
    const adkEventConverter: AdkEventToA2AEventsConverterImpl = vi.fn(() => []);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      eventConverter,
      adkEventConverter,
    });
    await executor.execute(createRequestContext(), mockEventBus);

    expect(eventConverter).toHaveBeenCalledTimes(1);
    expect(adkEventConverter).not.toHaveBeenCalled();
  });

  it('publishes nothing for an ADK event its eventConverter drops', async () => {
    stubRunnerWith([modelEvent('response')]);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      eventConverter: () => [],
    });
    await executor.execute(createRequestContext(), mockEventBus);

    expect(publishedArtifactUpdates()).toEqual([]);
    const kinds = mockEventBus.publish.mock.calls.map(([event]) => event.kind);
    expect(kinds).toEqual(['task', 'status-update', 'status-update']);
  });

  it('passes every event its eventConverter returns to afterEventCallback', async () => {
    const adkEvent = modelEvent('response');
    stubRunnerWith([adkEvent]);

    const first = workingStatusEvent();
    const second = workingStatusEvent();
    const afterEventCallback = vi.fn(async () => {});

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      eventConverter: () => [first, second],
      afterEventCallback,
    });
    await executor.execute(createRequestContext(), mockEventBus);

    expect(afterEventCallback).toHaveBeenCalledTimes(2);
    // A status update is not an artifact update, so the third argument is
    // undefined for both.
    expect(afterEventCallback).toHaveBeenCalledWith(
      expect.anything(),
      adkEvent,
      undefined,
    );
    expect(mockEventBus.publish).toHaveBeenNthCalledWith(3, first);
    expect(mockEventBus.publish).toHaveBeenNthCalledWith(4, second);
  });

  it('runs the default adkEventConverter when eventConverter is unset', async () => {
    stubRunnerWith([modelEvent('chunk 1', true), modelEvent('chunk 2')]);

    const executor = new A2AAgentExecutor({runner: runnerConfig()});
    await executor.execute(createRequestContext(), mockEventBus);

    const updates = publishedArtifactUpdates();
    expect(updates).toHaveLength(2);
    expect(updates[0].artifact.artifactId).toBe(updates[1].artifact.artifactId);
    expect(updates[0].append).toBe(true);
    expect(updates[1].lastChunk).toBe(true);
  });

  it('rejects an eventConverter that is not a function when it is constructed', () => {
    expect(
      () =>
        new A2AAgentExecutor({
          runner: runnerConfig(),
          eventConverter: null as unknown as AdkEventToA2AEventsConverter,
        }),
    ).toThrow(
      'A2A executor config field "eventConverter" must be a function, received null',
    );
  });
});
