/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converter-wiring tests ported from adk-python.
 *
 * Reference: google/adk-python@44e0b2a8b1215aa98f057c4a781ddc24bae220da
 * - tests/unittests/a2a/executor/test_a2a_agent_executor_impl.py
 * - tests/unittests/a2a/executor/test_a2a_agent_executor.py
 *
 * The `it(...)` strings keep the Python test names so a reviewer can grep
 * them. adk-python has two executor classes and adk-js has one, so the impl
 * tests drive `adkEventConverter` and the legacy tests drive `eventConverter`
 * on the same `A2AAgentExecutor`.
 *
 * The request-converter half of the legacy `test_execute_success_new_task` is
 * not ported: `requestConverter` is out of scope on this branch.
 */

import {
  Part as A2APart,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
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
  GenAIPartToA2APartConverter,
  Runner,
  RunnerConfig,
  Session,
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

describe('A2AAgentExecutor converter config (adk-python parity)', () => {
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

    const session = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(session);
  });

  const createRequestContext = (overrides = {}): RequestContext =>
    ({
      contextId: CONTEXT_ID,
      taskId: TASK_ID,
      userMessage: {role: 'user', parts: [{kind: 'text', text: 'hello'}]},
      ...overrides,
    }) as unknown as RequestContext;

  const runnerConfig = () =>
    ({
      appName: 'test-app',
      sessionService: mockSessionService,
    }) as unknown as RunnerConfig;

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

  const existingTask = (): Task => ({
    kind: 'task',
    id: TASK_ID,
    contextId: CONTEXT_ID,
    status: {state: 'working'},
    history: [],
  });

  it('test_execute_success_new_task (impl: adk_event_converter arguments)', async () => {
    const adkEvent = modelEvent('response');
    stubRunnerWith([adkEvent]);

    const genAiPartConverter = stubPartConverter();
    const converted = workingStatusEvent();
    const adkEventConverter: AdkEventToA2AEventsConverterImpl = vi.fn(() => [
      converted,
    ]);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      genAiPartConverter,
      adkEventConverter,
    });
    await executor.execute(createRequestContext(), mockEventBus);

    expect(adkEventConverter).toHaveBeenCalledTimes(1);
    expect(adkEventConverter).toHaveBeenCalledWith(
      adkEvent,
      new Map(),
      TASK_ID,
      CONTEXT_ID,
      genAiPartConverter,
    );

    // Task + working + the converted event + the final status update.
    expect(mockEventBus.publish).toHaveBeenCalledTimes(4);
    expect(mockEventBus.publish).toHaveBeenNthCalledWith(3, converted);
    expect(converted.metadata).toMatchObject({
      'adk_app_name': 'test-app',
      'adk_user_id': 'test-user',
      'adk_session_id': 'session-id',
      'adk_author': 'model',
    });
  });

  it('test_execute_success_new_task (legacy: event_converter arguments)', async () => {
    const adkEvent = modelEvent('response');
    stubRunnerWith([adkEvent]);

    const genAiPartConverter = stubPartConverter();
    const eventConverter: AdkEventToA2AEventsConverter = vi.fn(() => []);
    const adkEventConverter: AdkEventToA2AEventsConverterImpl = vi.fn(() => []);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      genAiPartConverter,
      eventConverter,
      adkEventConverter,
    });
    await executor.execute(createRequestContext(), mockEventBus);

    expect(eventConverter).toHaveBeenCalledTimes(1);
    expect(eventConverter).toHaveBeenCalledWith(
      adkEvent,
      expect.objectContaining({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'session-id',
      }),
      TASK_ID,
      CONTEXT_ID,
      genAiPartConverter,
    );
    expect(adkEventConverter).not.toHaveBeenCalled();
  });

  it('test_execute_existing_task (legacy: converter arguments on a resumed task)', async () => {
    const adkEvent = modelEvent('response');
    stubRunnerWith([adkEvent]);

    const genAiPartConverter = stubPartConverter();
    const converted = workingStatusEvent();
    const eventConverter: AdkEventToA2AEventsConverter = vi.fn(() => [
      converted,
    ]);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      genAiPartConverter,
      eventConverter,
    });
    await executor.execute(
      createRequestContext({task: existingTask()}),
      mockEventBus,
    );

    // No submitted Task is published for a task that already exists.
    const published = mockEventBus.publish.mock.calls.map((call) => call[0]);
    expect(published.map((event) => event.kind)).toEqual([
      'status-update',
      'status-update',
      'status-update',
    ]);

    expect(eventConverter).toHaveBeenCalledWith(
      adkEvent,
      expect.objectContaining({appName: 'test-app'}),
      TASK_ID,
      CONTEXT_ID,
      genAiPartConverter,
    );
  });

  it('test_execute_existing_task (impl: the artifact map is not reset between chunks)', async () => {
    stubRunnerWith([
      modelEvent('chunk 1', true),
      modelEvent('chunk 2', true),
      modelEvent('chunk 3'),
    ]);

    const executor = new A2AAgentExecutor({runner: runnerConfig()});
    await executor.execute(
      createRequestContext({task: existingTask()}),
      mockEventBus,
    );

    const artifactUpdates = mockEventBus.publish.mock.calls
      .map((call) => call[0])
      .filter(
        (event): event is TaskArtifactUpdateEvent =>
          event.kind === 'artifact-update',
      );
    expect(artifactUpdates).toHaveLength(3);

    const artifactIds = new Set(
      artifactUpdates.map((event) => event.artifact.artifactId),
    );
    expect(artifactIds.size).toBe(1);
    expect(artifactUpdates.map((event) => event.append)).toEqual([
      true,
      true,
      false,
    ]);
    expect(artifactUpdates.map((event) => event.lastChunk)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('test_handle_request_integration (impl: the default converter publishes the run)', async () => {
    stubRunnerWith([modelEvent('the answer')]);

    const executor = new A2AAgentExecutor({runner: runnerConfig()});
    await executor.execute(createRequestContext(), mockEventBus);

    const published = mockEventBus.publish.mock.calls.map((call) => call[0]);
    expect(published.map((event) => event.kind)).toEqual([
      'task',
      'status-update',
      'artifact-update',
      'status-update',
    ]);

    const artifactUpdate = published[2] as TaskArtifactUpdateEvent;
    expect(artifactUpdate.taskId).toBe(TASK_ID);
    expect(artifactUpdate.contextId).toBe(CONTEXT_ID);
    expect((artifactUpdate.artifact.parts[0] as TextPart).text).toBe(
      'the answer',
    );
    expect(artifactUpdate.metadata).toMatchObject({
      'adk_app_name': 'test-app',
      'adk_user_id': 'test-user',
      'adk_session_id': 'session-id',
    });

    // The legacy `test_handle_request_integration` differs only in which
    // converter field it reads, which the two tests above already pin.
  });
});
