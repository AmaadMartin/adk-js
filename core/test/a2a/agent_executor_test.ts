/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskStatusUpdateEvent, TextPart} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  BaseSessionService,
  createEvent,
  createEventActions,
  createSession,
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
  Runner,
  RunnerConfig,
  Session,
} from '@google/adk';
import {beforeEach, describe, expect, it, Mocked, vi} from 'vitest';
import {getFinalTaskStatusUpdate} from '../../src/a2a/event_processor_utils.js';

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

// Left as a pass-through so one test can make the final-status computation
// throw, which is how the long-running guard reaches the executor.
vi.mock('../../src/a2a/event_processor_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/a2a/event_processor_utils.js')
    >();
  return {
    ...actual,
    getFinalTaskStatusUpdate: vi.fn(actual.getFinalTaskStatusUpdate),
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

  describe('parity gap closures', () => {
    const EXTENSION_FLAG = {adk_agent_executor_v2: true};

    /** A config the executor accepts, wired to the mocked session service. */
    function runnerConfig(): RunnerConfig {
      return {appName: 'test-app', sessionService: mockSessionService};
    }

    /**
     * Points the mocked `Runner` constructor at a scripted `runAsync`.
     *
     * `Runner` is a class with no matching interface, so a stub carrying only
     * the three members the executor reads cannot be written structurally.
     * The whole file's tests share this one cast, matching the pattern the
     * file already uses above.
     */
    function useRunner(runAsync: Runner['runAsync']): void {
      vi.mocked(Runner).mockImplementation(((config: RunnerConfig) => {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync,
        } as unknown as Runner;
      }) as unknown as () => Runner);
    }

    function publishedEvent(index: number): TaskStatusUpdateEvent {
      return mockEventBus.publish.mock.calls[index][0] as TaskStatusUpdateEvent;
    }

    beforeEach(() => {
      mockSessionService.getSession.mockResolvedValue(
        createSession({id: 'session-id', appName: 'test-app'}),
      );
    });

    it('publishes the last error of the run, not the first', async () => {
      useRunner(async function* () {
        yield createEvent({author: 'model', errorMessage: 'first failure'});
        yield createEvent({author: 'model', errorMessage: 'second failure'});
      });

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      const finalEvent = publishedEvent(
        mockEventBus.publish.mock.calls.length - 1,
      );
      expect(finalEvent.status.state).toBe('failed');
      expect((finalEvent.status.message!.parts[0] as TextPart).text).toContain(
        'second failure',
      );
    });

    it('falls back to the error code when the event carries no message', async () => {
      useRunner(async function* () {
        yield createEvent({author: 'model', errorCode: 'SAFETY_BLOCK'});
      });

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      const finalEvent = publishedEvent(
        mockEventBus.publish.mock.calls.length - 1,
      );
      expect(finalEvent.status.state).toBe('failed');
      expect((finalEvent.status.message!.parts[0] as TextPart).text).toContain(
        'SAFETY_BLOCK',
      );
    });

    it('publishes the artifact of an errored event before the terminal failure', async () => {
      useRunner(async function* () {
        yield createEvent({
          author: 'model',
          content: {role: 'model', parts: [{text: 'partial answer'}]},
          errorMessage: 'stopped early',
        });
      });

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      // Task + working + artifact update + terminal failure.
      expect(mockEventBus.publish).toHaveBeenCalledTimes(4);
      expect(mockEventBus.publish.mock.calls[2][0].kind).toBe(
        'artifact-update',
      );
      expect(publishedEvent(3).status.state).toBe('failed');
    });

    it('stamps the integration extension on every published event', async () => {
      useRunner(async function* () {
        yield createEvent({
          author: 'model',
          content: {role: 'model', parts: [{text: 'hello back'}]},
        });
      });

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(mockEventBus.publish).toHaveBeenCalledTimes(4);
      for (const [event] of mockEventBus.publish.mock.calls) {
        expect(event.metadata).toMatchObject({
          [NEW_A2A_ADK_INTEGRATION_EXTENSION]: EXTENSION_FLAG,
          'adk_app_name': 'test-app',
          'adk_session_id': 'session-id',
        });
      }
    });

    it('keeps the per-event metadata on an artifact update', async () => {
      useRunner(async function* () {
        yield createEvent({
          author: 'model',
          branch: 'main',
          content: {role: 'model', parts: [{text: 'hello back'}]},
        });
      });

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(mockEventBus.publish.mock.calls[2][0].metadata).toMatchObject({
        [NEW_A2A_ADK_INTEGRATION_EXTENSION]: EXTENSION_FLAG,
        'adk_author': 'model',
        'adk_branch': 'main',
      });
    });

    it('stamps the integration extension on the unanswered-request event', async () => {
      const executor = new A2AAgentExecutor({runner: runnerConfig()});

      await executor.execute(
        createRequestContext({
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
        }),
        mockEventBus,
      );

      expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
      expect(publishedEvent(0).metadata).toMatchObject({
        [NEW_A2A_ADK_INTEGRATION_EXTENSION]: EXTENSION_FLAG,
      });
    });

    it('probes for the session without history, then loads the history', async () => {
      useRunner(async function* () {});

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(mockSessionService.getSession).toHaveBeenCalledTimes(2);
      expect(mockSessionService.getSession).toHaveBeenNthCalledWith(1, {
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
        config: {numRecentEvents: 0},
      });
      expect(mockSessionService.getSession).toHaveBeenNthCalledWith(2, {
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
      });
      expect(mockSessionService.createSession).not.toHaveBeenCalled();
    });

    it('creates the session only when the probe misses', async () => {
      mockSessionService.getSession.mockReset();
      mockSessionService.getSession.mockResolvedValue(undefined);
      mockSessionService.createSession.mockResolvedValue(
        createSession({id: 'session-id', appName: 'test-app'}),
      );
      useRunner(async function* () {});

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(mockSessionService.getSession).toHaveBeenCalledTimes(1);
      expect(mockSessionService.createSession).toHaveBeenCalledWith({
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
      });
    });

    it('keeps the session pause open when only the loaded session has history', async () => {
      // The probe deliberately carries no events, so the pending
      // human-in-the-loop scan has to read the session the second call loads.
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
      });
      mockSessionService.getSession.mockReset();
      mockSessionService.getSession
        .mockResolvedValueOnce(
          createSession({id: 'session-id', appName: 'test-app'}),
        )
        .mockResolvedValueOnce(
          createSession({
            id: 'session-id',
            appName: 'test-app',
            events: [pendingCall],
          }),
        );

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
      expect(publishedEvent(0).status.state).toBe('input-required');
    });

    it('falls back to the probed session when the history load misses', async () => {
      mockSessionService.getSession.mockReset();
      mockSessionService.getSession
        .mockResolvedValueOnce(
          createSession({id: 'session-id', appName: 'test-app'}),
        )
        .mockResolvedValueOnce(undefined);
      useRunner(async function* () {});

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(mockSessionService.createSession).not.toHaveBeenCalled();
      expect(publishedEvent(2).status.state).toBe('completed');
    });

    it('fails the task when the long-running parts convert to nothing', async () => {
      vi.mocked(getFinalTaskStatusUpdate).mockImplementationOnce(() => {
        throw new Error(
          'Long-running function calls produced no A2A response parts',
        );
      });
      useRunner(async function* () {});

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      const finalEvent = publishedEvent(2);
      expect(finalEvent.status.state).toBe('failed');
      expect((finalEvent.status.message!.parts[0] as TextPart).text).toContain(
        'Agent run failed: Long-running function calls produced no A2A response parts',
      );
    });

    it('resolves a runner config returned by a factory', async () => {
      useRunner(async function* () {});

      await new A2AAgentExecutor({runner: () => runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(mockEventBus.publish).toHaveBeenCalledTimes(3);
    });
  });
});
