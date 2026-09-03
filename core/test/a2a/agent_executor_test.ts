/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  A2AEvent,
  Event as AdkEvent,
  AgentExecutorConfig,
  BaseSessionService,
  createEvent,
  createEventActions,
  createSession,
  ExecutorContext,
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
  Runner,
  RunnerConfig,
  Session,
  TaskState,
} from '@google/adk';
import {beforeEach, describe, expect, it, Mocked, vi} from 'vitest';

// Mock the Runner to control its async generator
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

describe('A2AAgentExecutor', () => {
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

    mockEventBus = {
      publish: vi.fn(),
    } as unknown as Mocked<ExecutionEventBus>;
  });

  const createRequestContext = (overrides = {}): RequestContext => {
    return {
      contextId: 'test-context',
      taskId: 'test-task',
      userMessage: {role: 'user', parts: [{kind: 'text', text: 'hello'}]}, // a2a UserMessage
      ...overrides,
    } as unknown as RequestContext;
  };

  it('should throw an error if no message is provided', async () => {
    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    const ctx = createRequestContext({userMessage: undefined});
    await expect(executor.execute(ctx, mockEventBus)).rejects.toThrow(
      'message not provided',
    );
  });

  it('should get or create a session, run the agent, and publish working and final status events', async () => {
    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(mockSession);

    const adkEvents: AdkEvent[] = [
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'response part 1'}]},
        partial: true,
        actions: createEventActions(),
      }),
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'response part 2'}]},
        partial: false,
        actions: createEventActions(),
      }),
    ];

    async function* mockRunAsync() {
      for (const e of adkEvents) {
        yield e;
      }
    }

    vi.mocked(Runner).mockImplementation(((config: RunnerConfig) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    }) as unknown as () => Runner);

    let beforeExecutedCalled = false;
    let afterEventCount = 0;
    let afterExecuteCalled = false;

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
      beforeExecuteCallback: async () => {
        beforeExecutedCalled = true;
      },
      afterEventCallback: async () => {
        afterEventCount++;
      },
      afterExecuteCallback: async () => {
        afterExecuteCalled = true;
      },
    });

    const ctx = createRequestContext();
    await executor.execute(ctx, mockEventBus);

    if (afterEventCount !== 2) {
      console.error(
        'PUBLISHED EVENTS:',
        JSON.stringify(mockEventBus.publish.mock.calls, null, 2),
      );
    }

    expect(beforeExecutedCalled).toBe(true);
    expect(afterEventCount).toBe(2);
    expect(afterExecuteCalled).toBe(true);

    // Verify event bus payload counts
    // Task + Working + 2 task artifact updates + 1 final task status
    expect(mockEventBus.publish).toHaveBeenCalledTimes(5);

    // Assert that the second published event is the "Working" event
    expect(mockEventBus.publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'status-update',
      }),
    );
  });

  it('should return early with input required event if task needs input', async () => {
    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(mockSession);

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    const ctx = createRequestContext({
      task: {
        kind: 'task',
        id: 'test-task',
        contextId: 'test-context',
        status: {
          state: 'input-required',
          message: {
            role: 'agent',
            parts: [
              {
                kind: 'data',
                metadata: {'adk_type': 'function_call'},
                data: {id: 'fc-123', name: 'mockFunction'},
              },
            ],
          },
        },
      },
    });

    await executor.execute(ctx, mockEventBus);

    // No runner execution should happen, just publish input required event
    expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
    const event = mockEventBus.publish.mock
      .calls[0][0] as TaskStatusUpdateEvent;
    expect(event.kind).toBe('status-update');
    expect(event.status.state).toBe('input-required');
  });

  it('should handle unrecoverable runner errors properly', async () => {
    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(mockSession);

    async function* mockRunAsyncWithError() {
      yield createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'some part'}]},
        partial: false,
        actions: createEventActions(),
      });
      throw new Error('LLM failed');
    }

    vi.mocked(Runner).mockImplementation(((config: RunnerConfig) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsyncWithError,
      } as unknown as Runner;
    }) as unknown as () => Runner);

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    const ctx = createRequestContext();
    await executor.execute(ctx, mockEventBus);

    // Task + Working + Artifact update (1) + Failed TaskStatusUpdate (1) = 4 calls
    if (mockEventBus.publish.mock.calls.length < 4) {
      console.error(
        'PUBLISHED EVENTS in error test:',
        JSON.stringify(mockEventBus.publish.mock.calls, null, 2),
      );
    }
    expect(mockEventBus.publish).toHaveBeenCalledTimes(4);

    const lastCallArg = mockEventBus.publish.mock
      .calls[3][0] as TaskStatusUpdateEvent;
    expect(lastCallArg.kind).toBe('status-update');
    expect(lastCallArg.status.state).toBe('failed');
    const firstPart = lastCallArg.status.message!.parts[0] as TextPart;
    expect(firstPart.text).toContain('LLM failed');
  });

  it('marks the run as remote-delivered, preserving the configured run config', async () => {
    // A human-in-the-loop gate is not answerable by the peer on the other end
    // of the transport; the run has to know where its message came from.
    const mockSession = {
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session;
    mockSessionService.getSession.mockResolvedValue(mockSession);

    const mockRunAsync = vi.fn(async function* () {});
    vi.mocked(Runner).mockImplementation(((config: RunnerConfig) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync: mockRunAsync,
      } as unknown as Runner;
    }) as unknown as () => Runner);

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
      runConfig: {maxLlmCalls: 7},
    });

    await executor.execute(createRequestContext(), mockEventBus);

    expect(mockRunAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        runConfig: {maxLlmCalls: 7, remoteDelivered: true},
      }),
    );
  });

  const testSession = (): Session =>
    createSession({
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
    });

  const mockRunner = (
    runAsync: (params: {
      abortSignal?: AbortSignal;
    }) => AsyncGenerator<AdkEvent, void, undefined>,
  ) => {
    vi.mocked(Runner).mockImplementation(((config: RunnerConfig) => {
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync,
      } as unknown as Runner;
    }) as unknown as () => Runner);
  };

  const createExecutor = (config: Partial<AgentExecutorConfig> = {}) =>
    new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
      ...config,
    });

  const modelEvent = (text: string): AdkEvent =>
    createEvent({
      author: 'model',
      content: {role: 'model', parts: [{text}]},
      partial: false,
      actions: createEventActions(),
    });

  const statusUpdate = (
    state: TaskState,
    parts: Part[] = [],
  ): TaskStatusUpdateEvent => ({
    kind: 'status-update',
    taskId: 'test-task',
    contextId: 'test-context',
    final: true,
    status: {
      state,
      message: {
        kind: 'message',
        messageId: 'status-message',
        role: 'agent',
        parts,
      },
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  });

  const publishedEvents = () =>
    mockEventBus.publish.mock.calls.map((call) => call[0]);

  const publishedStates = () =>
    publishedEvents()
      .filter(
        (event): event is TaskStatusUpdateEvent =>
          event.kind === 'status-update',
      )
      .map((event) => event.status.state);

  /**
   * A run parked until the test releases it, so a cancellation lands while it
   * is still in flight. The generator stops on an aborted signal, as the real
   * runner does.
   */
  const parkedRun = () => {
    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const runStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    return {
      runStarted,
      release,
      generator: async function* ({abortSignal}: {abortSignal?: AbortSignal}) {
        started();
        await parked;
        if (abortSignal?.aborted) {
          return;
        }
        yield modelEvent('done');
      },
    };
  };

  describe('cancelTask', () => {
    it('publishes a canceled final status update for the running task', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      let releaseRun: () => void = () => {};
      const runStarted = new Promise<void>((resolveStarted) => {
        mockRunner(async function* () {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          yield modelEvent('done');
        });
      });

      const executor = createExecutor();
      const running = executor.execute(createRequestContext(), mockEventBus);
      await runStarted;

      await executor.cancelTask('test-task', mockEventBus);

      const canceled = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(canceled.kind).toBe('status-update');
      expect(canceled.status.state).toBe('canceled');
      expect(canceled.final).toBe(true);
      expect(canceled.contextId).toBe('test-context');

      releaseRun();
      await running;
    });

    it('rejects an empty task id and publishes nothing', async () => {
      const executor = createExecutor();

      await expect(executor.cancelTask('', mockEventBus)).rejects.toThrow(
        'A2A cancellation must have a task ID',
      );
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('rejects a task this executor never started', async () => {
      const executor = createExecutor();

      await expect(
        executor.cancelTask('unknown-task', mockEventBus),
      ).rejects.toThrow('No active A2A task unknown-task to cancel');
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('rejects a second cancellation of the same task', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      let releaseRun: () => void = () => {};
      const runStarted = new Promise<void>((resolveStarted) => {
        mockRunner(async function* () {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          yield modelEvent('done');
        });
      });

      const executor = createExecutor();
      const running = executor.execute(createRequestContext(), mockEventBus);
      await runStarted;
      await executor.cancelTask('test-task', mockEventBus);

      await expect(
        executor.cancelTask('test-task', mockEventBus),
      ).rejects.toThrow('No active A2A task test-task to cancel');

      releaseRun();
      await running;
    });

    it('aborts the run it cancels', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      let runSignal: AbortSignal | undefined;
      const run = parkedRun();
      mockRunner(async function* (params) {
        runSignal = params.abortSignal;
        yield* run.generator(params);
      });

      const executor = createExecutor();
      const running = executor.execute(createRequestContext(), mockEventBus);
      await run.runStarted;
      expect(runSignal?.aborted).toBe(false);

      await executor.cancelTask('test-task', mockEventBus);
      expect(runSignal?.aborted).toBe(true);

      run.release();
      await running;
    });

    it('publishes no terminal event of its own once the task is canceled', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const run = parkedRun();
      mockRunner(run.generator);

      const executor = createExecutor();
      const running = executor.execute(createRequestContext(), mockEventBus);
      await run.runStarted;
      await executor.cancelTask('test-task', mockEventBus);
      run.release();
      await running;

      expect(publishedStates()).toEqual(['working', 'canceled']);
    });

    it('publishes no failed event when the canceled run throws', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const run = parkedRun();
      mockRunner(async function* (params) {
        yield* run.generator(params);
        throw new Error('the model client rejected the aborted request');
      });

      const executor = createExecutor();
      const running = executor.execute(createRequestContext(), mockEventBus);
      await run.runStarted;
      await executor.cancelTask('test-task', mockEventBus);
      run.release();
      await running;

      expect(publishedStates()).toEqual(['working', 'canceled']);
    });
  });

  describe('new-version routing', () => {
    const newVersionExecutor = () => ({
      execute: vi.fn(async () => {}),
      cancelTask: vi.fn(async () => {}),
    });

    const requestWithExtension = (activated: string[]) =>
      createRequestContext({
        context: {
          requestedExtensions: [NEW_A2A_ADK_INTEGRATION_EXTENSION],
          addActivatedExtension: (uri: string) => activated.push(uri),
        },
      });

    it('routes to the new executor and activates the extension', async () => {
      const activated: string[] = [];
      const newVersion = newVersionExecutor();

      const executor = createExecutor({newVersionExecutor: newVersion});
      await executor.execute(requestWithExtension(activated), mockEventBus);

      expect(newVersion.execute).toHaveBeenCalledTimes(1);
      expect(activated).toEqual([NEW_A2A_ADK_INTEGRATION_EXTENSION]);
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('stays on the legacy path when useLegacy is set', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});
      const activated: string[] = [];
      const newVersion = newVersionExecutor();

      const executor = createExecutor({
        newVersionExecutor: newVersion,
        useLegacy: true,
      });
      await executor.execute(requestWithExtension(activated), mockEventBus);

      expect(newVersion.execute).not.toHaveBeenCalled();
      expect(activated).toEqual([]);
      expect(publishedStates()).toContain('completed');
    });

    it('routes to the new executor when forceNewVersion is set without the extension', async () => {
      const newVersion = newVersionExecutor();

      const executor = createExecutor({
        newVersionExecutor: newVersion,
        forceNewVersion: true,
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(newVersion.execute).toHaveBeenCalledTimes(1);
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('stays on the legacy path without the extension or a flag', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});
      const newVersion = newVersionExecutor();

      const executor = createExecutor({newVersionExecutor: newVersion});
      await executor.execute(createRequestContext(), mockEventBus);

      expect(newVersion.execute).not.toHaveBeenCalled();
      expect(publishedStates()).toContain('completed');
    });

    it('activates nothing when the extension has no executor to serve it', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});
      const activated: string[] = [];

      const executor = createExecutor();
      await executor.execute(requestWithExtension(activated), mockEventBus);

      expect(activated).toEqual([]);
      expect(publishedStates()).toContain('completed');
    });

    it('rejects forceNewVersion with no executor to route to', async () => {
      const executor = createExecutor({forceNewVersion: true});

      await expect(
        executor.execute(createRequestContext(), mockEventBus),
      ).rejects.toThrow(
        'forceNewVersion is set but no newVersionExecutor is configured.',
      );
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });
  });

  describe('request converter', () => {
    it('drives the user id and session id into the runner and the session lookup', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const runAsync = vi.fn(async function* () {});
      mockRunner(runAsync);

      const executor = createExecutor({
        requestConverter: (request) => ({
          userId: 'principal@example.com',
          sessionId: `session-of-${request.contextId}`,
          newMessage: {role: 'user', parts: [{text: 'converted'}]},
        }),
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.getSession).toHaveBeenCalledWith({
        appName: 'test-app',
        userId: 'principal@example.com',
        sessionId: 'session-of-test-context',
      });
      expect(runAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'principal@example.com',
          sessionId: 'session-of-test-context',
          newMessage: {role: 'user', parts: [{text: 'converted'}]},
        }),
      );
    });

    it('merges the run config the converter supplied under the configured one', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const runAsync = vi.fn(async function* () {});
      mockRunner(runAsync);

      const executor = createExecutor({
        runConfig: {maxLlmCalls: 7},
        requestConverter: (request) => ({
          userId: 'u',
          sessionId: request.contextId,
          newMessage: {role: 'user', parts: [{text: 'x'}]},
          runConfig: {maxLlmCalls: 3},
        }),
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(runAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          runConfig: {maxLlmCalls: 3, remoteDelivered: true},
        }),
      );
    });
  });

  describe('interceptors', () => {
    it('lets beforeAgent replace the request context', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});

      const executor = createExecutor({
        executeInterceptors: [
          {
            beforeAgent: async (ctx) =>
              ({...ctx, taskId: 'rewritten-task'}) as RequestContext,
          },
        ],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const working = publishedEvents()[1] as TaskStatusUpdateEvent;
      expect(working.taskId).toBe('rewritten-task');
    });

    it('gives afterEvent the executor context, the A2A event and the ADK event', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const adkEvent = modelEvent('hello');
      mockRunner(async function* () {
        yield adkEvent;
      });
      const seen: Array<[ExecutorContext, A2AEvent, AdkEvent]> = [];

      const executor = createExecutor({
        executeInterceptors: [
          {
            afterEvent: async (ctx, event, event2) => {
              seen.push([ctx, event, event2]);
              return event;
            },
          },
        ],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(seen).toHaveLength(1);
      const [ctx, a2aEvent, receivedAdkEvent] = seen[0];
      expect(ctx.appName).toBe('test-app');
      expect(ctx.sessionId).toBe('session-id');
      expect(a2aEvent.kind).toBe('artifact-update');
      expect(receivedAdkEvent).toBe(adkEvent);
    });

    it('publishes both events when afterEvent fans one out', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });
      const extra = statusUpdate(TaskState.WORKING);

      const executor = createExecutor({
        executeInterceptors: [{afterEvent: async (_ctx, e) => [e, extra]}],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const kinds = publishedEvents().map((event) => event.kind);
      expect(kinds).toEqual([
        'task',
        'status-update',
        'artifact-update',
        'status-update',
        'status-update',
      ]);
      expect(publishedEvents()[3]).toBe(extra);
    });

    it('publishes nothing for an event afterEvent dropped', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });

      const executor = createExecutor({
        executeInterceptors: [{afterEvent: async () => undefined}],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const kinds = publishedEvents().map((event) => event.kind);
      expect(kinds).toEqual(['task', 'status-update', 'status-update']);
    });

    it('publishes the terminal event afterAgent returned', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});
      const rewritten = statusUpdate(TaskState.REJECTED);

      const executor = createExecutor({
        executeInterceptors: [{afterAgent: async () => rewritten}],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(publishedEvents().at(-1)).toBe(rewritten);
    });
  });

  describe('aggregated task result', () => {
    it('settles the task as failed and rewrites the intermediate event to working', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });
      const failure = statusUpdate(TaskState.FAILED, [
        {kind: 'text', text: 'the tool refused'},
      ]);

      const executor = createExecutor({
        eventConverter: () => [failure],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const intermediate = publishedEvents()[2] as TaskStatusUpdateEvent;
      expect(intermediate.status.state).toBe('working');
      expect(intermediate.final).toBe(false);

      const terminal = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(terminal.status.state).toBe('failed');
      expect(terminal.final).toBe(true);
      expect(terminal.status.message?.parts).toEqual([
        {kind: 'text', text: 'the tool refused'},
      ]);
    });

    it('publishes the aggregated artifact update then completed', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });

      const executor = createExecutor({
        eventConverter: () => [
          statusUpdate(TaskState.WORKING, [{kind: 'text', text: 'partial'}]),
        ],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const artifact = publishedEvents().at(-2) as TaskArtifactUpdateEvent;
      expect(artifact.kind).toBe('artifact-update');
      expect(artifact.lastChunk).toBe(true);
      expect(artifact.artifact.parts).toEqual([
        {kind: 'text', text: 'partial'},
      ]);

      const terminal = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(terminal.status.state).toBe('completed');
      expect(terminal.final).toBe(true);
    });

    it('keeps the existing terminal event when no status update was published', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      const kinds = publishedEvents().map((event) => event.kind);
      expect(kinds).toEqual([
        'task',
        'status-update',
        'artifact-update',
        'status-update',
      ]);
      const terminal = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(terminal.status.state).toBe('completed');
    });
  });

  describe('event metadata', () => {
    it('puts the session metadata on the working event and the event ids on the terminal one', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const adkEvent = modelEvent('hello');
      mockRunner(async function* () {
        yield adkEvent;
      });

      const executor = createExecutor({
        eventConverter: () => [
          statusUpdate(TaskState.WORKING, [{kind: 'text', text: 'partial'}]),
        ],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const working = publishedEvents()[1] as TaskStatusUpdateEvent;
      expect(working.metadata).toEqual({
        adk_app_name: 'test-app',
        adk_user_id: 'test-user',
        adk_session_id: 'session-id',
      });

      const terminal = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(terminal.metadata).toEqual({
        adk_app_name: 'test-app',
        adk_user_id: 'test-user',
        adk_session_id: 'session-id',
        adk_invocation_id: adkEvent.invocationId,
        adk_author: 'model',
        adk_event_id: adkEvent.id,
      });
    });
  });

  describe('submitted signal', () => {
    it('publishes a leading submitted task for a new task', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      const first = publishedEvents()[0] as Task;
      expect(first.kind).toBe('task');
      expect(first.status.state).toBe('submitted');
    });

    it('publishes no submitted task when the request already carries one', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});

      const executor = createExecutor();
      await executor.execute(
        createRequestContext({
          task: {
            kind: 'task',
            id: 'test-task',
            contextId: 'test-context',
            status: {state: 'working'},
          },
        }),
        mockEventBus,
      );

      const kinds = publishedEvents().map((event) => event.kind);
      expect(kinds).toEqual(['status-update', 'status-update']);
    });

    it('precedes the event the unanswered-request gate publishes', async () => {
      const pendingCall = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'gate-1',
                name: 'adk_request_confirmation',
                args: {},
              },
            },
          ],
        },
        longRunningToolIds: ['gate-1'],
        actions: createEventActions(),
      });
      mockSessionService.getSession.mockResolvedValue(
        createSession({
          id: 'session-id',
          userId: 'test-user',
          appName: 'test-app',
          events: [pendingCall],
        }),
      );
      const runAsync = vi.fn(async function* () {});
      mockRunner(runAsync);

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      // Without the leading task, the SDK's result manager drops the gate's
      // status update: it belongs to a task the manager does not know.
      expect(publishedEvents().map((event) => event.kind)).toEqual([
        'task',
        'status-update',
      ]);
      expect(publishedStates()).toEqual(['input-required']);
      expect(runAsync).not.toHaveBeenCalled();
    });
  });

  describe('streaming artifact ids', () => {
    it('gives each execution its own partial artifact id', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield createEvent({
          author: 'model',
          content: {role: 'model', parts: [{text: 'chunk'}]},
          partial: true,
          actions: createEventActions(),
        });
      });

      const executor = createExecutor();
      await executor.execute(
        createRequestContext({taskId: 'task-a', contextId: 'context-a'}),
        mockEventBus,
      );
      await executor.execute(
        createRequestContext({taskId: 'task-b', contextId: 'context-b'}),
        mockEventBus,
      );

      const artifactIds = publishedEvents()
        .filter(
          (event): event is TaskArtifactUpdateEvent =>
            event.kind === 'artifact-update',
        )
        .map((event) => event.artifact.artifactId);
      expect(artifactIds).toHaveLength(2);
      expect(artifactIds[0]).not.toBe(artifactIds[1]);
    });
  });

  describe('afterEventCallback', () => {
    it('gets no A2A event when the published event is not an artifact update', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });
      const seen: Array<TaskArtifactUpdateEvent | undefined> = [];

      const executor = createExecutor({
        eventConverter: () => [statusUpdate(TaskState.WORKING)],
        afterEventCallback: async (_ctx, _adkEvent, a2aEvent) => {
          seen.push(a2aEvent);
        },
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(seen).toEqual([undefined]);
    });
  });

  describe('runner resolution', () => {
    it('resolves a runner returned by an async factory', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const runAsync = vi.fn(async function* () {});
      mockRunner(runAsync);
      const executor = new A2AAgentExecutor({
        runner: async () =>
          ({
            appName: 'test-app',
            sessionService: mockSessionService,
          }) as unknown as RunnerConfig,
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(runAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure paths', () => {
    it('publishes a failed terminal event when the session service throws', async () => {
      mockSessionService.getSession.mockRejectedValue(
        new Error('session store down'),
      );

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      expect(mockEventBus.publish).toHaveBeenCalledTimes(2);
      const failed = publishedEvents()[1] as TaskStatusUpdateEvent;
      expect(failed.status.state).toBe('failed');
      expect(failed.final).toBe(true);
      expect((failed.status.message!.parts[0] as TextPart).text).toContain(
        'session store down',
      );
      expect(failed.metadata).toBeUndefined();
    });

    it('publishes the submitted task before failing a run that never started', async () => {
      mockSessionService.getSession.mockRejectedValue(
        new Error('session store down'),
      );

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      expect(publishedEvents().map((event) => event.kind)).toEqual([
        'task',
        'status-update',
      ]);
      expect(publishedStates()).toEqual(['failed']);
    });

    it('publishes a failed terminal event when a thrown value is not an Error', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
        throw 'plain string failure';
      });

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      const failed = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(failed.status.state).toBe('failed');
      expect((failed.status.message!.parts[0] as TextPart).text).toContain(
        'plain string failure',
      );
    });

    it('still publishes the terminal event when afterExecuteCallback throws', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});

      const executor = createExecutor({
        afterExecuteCallback: async () => {
          throw new Error('callback exploded');
        },
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const terminal = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(terminal.status.state).toBe('completed');
    });

    it('rejects a request with no task id', async () => {
      const executor = createExecutor();

      await expect(
        executor.execute(createRequestContext({taskId: ''}), mockEventBus),
      ).rejects.toThrow('A2A request must have a task ID');
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });
  });
});
