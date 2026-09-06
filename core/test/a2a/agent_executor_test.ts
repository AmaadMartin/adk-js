/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  AgentExecutorConfig,
  BaseSessionService,
  createEvent,
  createEventActions,
  createSession,
  ExecutorContext,
  InMemorySessionService,
  Runner,
  RunnerConfig,
  Session,
} from '@google/adk';
import {beforeEach, describe, expect, it, Mocked, vi} from 'vitest';
import {A2AMetadataKeys} from '../../src/a2a/metadata_converter_utils.js';

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

  it('should fail cancelTask because it is not implemented', async () => {
    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      } as unknown as RunnerConfig,
    });

    await expect(executor.cancelTask('any-task-id')).rejects.toThrow(
      'Task cancellation is not supported yet.',
    );
  });

  describe('session resolution', () => {
    const modelEvent = () =>
      createEvent({
        author: 'model',
        content: {role: 'model', parts: [{text: 'response'}]},
        partial: false,
        actions: createEventActions(),
      });

    const stubRunAsync = (adkEvents: AdkEvent[]) => {
      const runAsync = vi.fn<Runner['runAsync']>(async function* () {
        for (const adkEvent of adkEvents) {
          yield adkEvent;
        }
      });
      vi.mocked(Runner).mockImplementation(
        (config: RunnerConfig) =>
          ({
            appName: config?.appName,
            sessionService: config?.sessionService,
            runAsync,
          }) as unknown as Runner,
      );

      return runAsync;
    };

    const createExecutor = (config: Partial<AgentExecutorConfig> = {}) =>
      new A2AAgentExecutor({
        runner: {appName: 'test-app', sessionService: mockSessionService},
        ...config,
      });

    const existingSession = () =>
      createSession({
        id: 'existing-session-id',
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        state: {topic: 'billing'},
      });

    it('probes for an existing session with a zero-event config', async () => {
      mockSessionService.getSession.mockResolvedValue(existingSession());
      stubRunAsync([]);

      await createExecutor().execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.getSession).toHaveBeenCalledTimes(1);
      expect(mockSessionService.getSession).toHaveBeenCalledWith({
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
        config: {numRecentEvents: 0},
      });
    });

    it('returns the probed session instead of recreating it', async () => {
      mockSessionService.getSession.mockResolvedValue(existingSession());
      stubRunAsync([modelEvent()]);

      await createExecutor().execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.createSession).not.toHaveBeenCalled();
      // Task + working + artifact update + final status.
      expect(mockEventBus.publish).toHaveBeenCalledTimes(4);
      const artifactEvent = mockEventBus.publish.mock
        .calls[2][0] as TaskArtifactUpdateEvent;
      expect(artifactEvent.metadata?.[A2AMetadataKeys.SESSION_ID]).toBe(
        'existing-session-id',
      );
    });

    it('creates a session when the probe misses, without the probe config', async () => {
      mockSessionService.getSession.mockResolvedValue(undefined);
      mockSessionService.createSession.mockResolvedValue(
        createSession({
          id: 'test-context',
          appName: 'test-app',
          userId: 'A2A_USER_test-context',
        }),
      );
      const runAsync = stubRunAsync([modelEvent()]);

      await createExecutor().execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.createSession).toHaveBeenCalledWith({
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
      });
      expect(
        mockSessionService.createSession.mock.calls[0][0],
      ).not.toHaveProperty('config');
      expect(runAsync).toHaveBeenCalledTimes(1);
      // Task + working + artifact update + final status.
      expect(mockEventBus.publish).toHaveBeenCalledTimes(4);
      const finalEvent = mockEventBus.publish.mock
        .calls[3][0] as TaskStatusUpdateEvent;
      expect(finalEvent.status.state).toBe('completed');
    });

    it('resolves a real InMemorySessionService session with no event history', async () => {
      const sessionService = new InMemorySessionService();
      const session = await sessionService.createSession({
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
      });
      await sessionService.appendEvent({session, event: modelEvent()});
      const getSession = vi.spyOn(sessionService, 'getSession');
      stubRunAsync([modelEvent()]);
      const executor = new A2AAgentExecutor({
        runner: {appName: 'test-app', sessionService},
      });

      await executor.execute(createRequestContext(), mockEventBus);

      const resolvedSession = await getSession.mock.results[0].value;
      expect(resolvedSession?.id).toBe('test-context');
      expect(resolvedSession?.events).toEqual([]);
    });

    it('keeps the executor context and event metadata intact without event history', async () => {
      mockSessionService.getSession.mockResolvedValue(existingSession());
      stubRunAsync([modelEvent()]);

      let eventContext: ExecutorContext | undefined;
      let executeContext: ExecutorContext | undefined;
      let finalEvent: TaskStatusUpdateEvent | undefined;
      const executor = createExecutor({
        afterEventCallback: async (ctx) => {
          eventContext = ctx;
        },
        afterExecuteCallback: async (ctx, a2aEvent) => {
          executeContext = ctx;
          finalEvent = a2aEvent;
        },
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(eventContext).toMatchObject({
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'existing-session-id',
        readonlyState: {topic: 'billing'},
        userContent: {role: 'user', parts: [{text: 'hello'}]},
      });
      expect(executeContext).toBe(eventContext);
      expect(finalEvent?.metadata).toMatchObject({
        [A2AMetadataKeys.APP_NAME]: 'test-app',
        [A2AMetadataKeys.USER_ID]: 'A2A_USER_test-context',
        [A2AMetadataKeys.SESSION_ID]: 'existing-session-id',
      });
    });

    it('leaves the agent run unbounded', async () => {
      mockSessionService.getSession.mockResolvedValue(existingSession());
      const runAsync = stubRunAsync([modelEvent()]);

      await createExecutor().execute(createRequestContext(), mockEventBus);

      expect(runAsync).toHaveBeenCalledWith({
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
        newMessage: {role: 'user', parts: [{text: 'hello', thought: false}]},
        runConfig: undefined,
      });
    });
  });
});
