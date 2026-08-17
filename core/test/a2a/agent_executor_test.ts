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
  BaseSessionService,
  createEvent,
  createEventActions,
  createSession,
  ExecutorContext,
  Runner,
  RunnerConfig,
  Session,
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

  describe('converter slots and execute interceptors', () => {
    /**
     * Installs a mocked runner yielding `adkEvents`, then failing with `error`
     * if one is given. Returns the `runAsync` spy so a test can assert what the
     * executor passed to it. The module-level `vi.mock` above replaces the
     * `Runner` class, so the stand-in it returns cannot be a real instance.
     */
    const mockRunnerYielding = (adkEvents: AdkEvent[], error?: Error) => {
      const runAsync = vi.fn(async function* () {
        for (const adkEvent of adkEvents) {
          yield adkEvent;
        }
        if (error) {
          throw error;
        }
      });

      vi.mocked(Runner).mockImplementation(((config: RunnerConfig) => {
        return {
          appName: config?.appName,
          sessionService: config?.sessionService,
          runAsync,
        } as unknown as Runner;
      }) as unknown as () => Runner);

      return runAsync;
    };

    const runnerConfig = (): RunnerConfig => ({
      appName: 'test-app',
      sessionService: mockSessionService,
    });

    const modelEvent = (text: string, partial: boolean) =>
      createEvent({
        invocationId: 'inv1',
        author: 'model',
        content: {role: 'model', parts: [{text}]},
        partial,
        actions: createEventActions(),
      });

    const publishedEvents = () =>
      mockEventBus.publish.mock.calls.map(([event]) => event);

    beforeEach(() => {
      mockSessionService.getSession.mockResolvedValue(
        createSession({
          id: 'session-id',
          userId: 'test-user',
          appName: 'test-app',
        }),
      );
    });

    it('publishes the same event sequence as before when no config is supplied', async () => {
      mockRunnerYielding([
        modelEvent('response part 1', true),
        modelEvent('response part 2', false),
      ]);
      const executor = new A2AAgentExecutor({runner: runnerConfig()});

      await executor.execute(createRequestContext(), mockEventBus);

      const events = publishedEvents();
      expect(events.map((event) => event.kind)).toEqual([
        'task',
        'status-update',
        'artifact-update',
        'artifact-update',
        'status-update',
      ]);
      const [task, working, first, second, final] = events;
      expect(task).toMatchObject({
        id: 'test-task',
        contextId: 'test-context',
        status: {state: 'submitted'},
      });
      expect(working).toMatchObject({
        taskId: 'test-task',
        final: false,
        status: {state: 'working'},
      });
      expect(first).toMatchObject({
        taskId: 'test-task',
        contextId: 'test-context',
        append: true,
        lastChunk: false,
        artifact: {parts: [{kind: 'text', text: 'response part 1'}]},
        metadata: {
          'adk_app_name': 'test-app',
          'adk_user_id': 'test-user',
          'adk_session_id': 'session-id',
          'adk_invocation_id': 'inv1',
          'adk_author': 'model',
          'adk_partial': true,
          'adk_is_long_running': false,
        },
      });
      expect(second).toMatchObject({
        append: false,
        lastChunk: true,
        artifact: {parts: [{kind: 'text', text: 'response part 2'}]},
        metadata: {'adk_partial': false},
      });
      // Both chunks belong to one streamed artifact.
      const firstArtifactId = (first as TaskArtifactUpdateEvent).artifact
        .artifactId;
      expect((second as TaskArtifactUpdateEvent).artifact.artifactId).toBe(
        firstArtifactId,
      );
      expect(final).toMatchObject({
        taskId: 'test-task',
        final: true,
        status: {state: 'completed'},
      });
    });

    it('uses a custom requestConverter for the session and the runner call', async () => {
      const runAsync = mockRunnerYielding([]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        requestConverter: () => ({
          userId: 'custom-user',
          sessionId: 'custom-session',
          newMessage: {role: 'user', parts: [{text: 'custom message'}]},
        }),
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.getSession).toHaveBeenCalledWith({
        appName: 'test-app',
        userId: 'custom-user',
        sessionId: 'custom-session',
      });
      expect(runAsync).toHaveBeenCalledWith({
        userId: 'custom-user',
        sessionId: 'custom-session',
        newMessage: {role: 'user', parts: [{text: 'custom message'}]},
        runConfig: undefined,
      });
    });

    it('uses a custom a2aPartConverter for the content sent to the runner', async () => {
      const runAsync = mockRunnerYielding([]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        a2aPartConverter: (a2aPart) => ({text: `converted:${a2aPart.kind}`}),
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(runAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          newMessage: {role: 'user', parts: [{text: 'converted:text'}]},
        }),
      );
    });

    it('uses a custom genAIPartConverter for the published artifact parts', async () => {
      mockRunnerYielding([modelEvent('response', false)]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        genAIPartConverter: (part) => ({
          kind: 'text',
          text: `converted:${part.text}`,
        }),
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(publishedEvents()[2]).toMatchObject({
        kind: 'artifact-update',
        artifact: {parts: [{kind: 'text', text: 'converted:response'}]},
      });
    });

    it('uses a custom eventConverter for the published event', async () => {
      mockRunnerYielding([modelEvent('response', false)]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        eventConverter: (adkEvent, executorContext) => ({
          kind: 'artifact-update',
          taskId: executorContext.requestContext.taskId,
          contextId: executorContext.requestContext.contextId,
          artifact: {
            artifactId: 'converter-artifact',
            parts: [{kind: 'text', text: `converted:${adkEvent.author}`}],
          },
        }),
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(publishedEvents()[2]).toEqual({
        kind: 'artifact-update',
        taskId: 'test-task',
        contextId: 'test-context',
        artifact: {
          artifactId: 'converter-artifact',
          parts: [{kind: 'text', text: 'converted:model'}],
        },
      });
    });

    it('skips the ADK event when a custom eventConverter returns undefined', async () => {
      mockRunnerYielding([modelEvent('response', false)]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        eventConverter: () => undefined,
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(publishedEvents().map((event) => event.kind)).toEqual([
        'task',
        'status-update',
        'status-update',
      ]);
    });

    it('runs each hook once at its own point in the execution', async () => {
      mockRunnerYielding([modelEvent('response', false)]);
      const calls: string[] = [];
      const ctx = createRequestContext();

      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [
          {
            beforeAgent: async (requestContext) => {
              calls.push(`beforeAgent:${requestContext.taskId}`);
              return requestContext;
            },
            afterEvent: async (_executorContext, a2aEvent, adkEvent) => {
              calls.push(`afterEvent:${a2aEvent.kind}:${adkEvent.author}`);
              return a2aEvent;
            },
            afterAgent: async (_executorContext, finalEvent) => {
              calls.push(`afterAgent:${finalEvent.status.state}`);
              return finalEvent;
            },
          },
        ],
      });

      await executor.execute(ctx, mockEventBus);

      expect(calls).toEqual([
        'beforeAgent:test-task',
        'afterEvent:artifact-update:model',
        'afterAgent:completed',
      ]);
    });

    it('runs the rest of the execution against the context beforeAgent returned', async () => {
      const runAsync = mockRunnerYielding([]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [
          {
            beforeAgent: async () =>
              createRequestContext({
                contextId: 'replaced-context',
                taskId: 'replaced-task',
                userMessage: {
                  kind: 'message',
                  messageId: 'replaced-message',
                  role: 'user',
                  parts: [{kind: 'text', text: 'replaced'}],
                },
              }),
          },
        ],
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(runAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'A2A_USER_replaced-context',
          sessionId: 'replaced-context',
          newMessage: {
            role: 'user',
            parts: [{text: 'replaced', thought: false}],
          },
        }),
      );
      expect(publishedEvents()[0]).toMatchObject({
        kind: 'task',
        id: 'replaced-task',
        contextId: 'replaced-context',
      });
    });

    it('rejects and publishes nothing when beforeAgent throws', async () => {
      mockRunnerYielding([modelEvent('response', false)]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [
          {
            beforeAgent: async () => {
              throw new Error('interceptor rejected the request');
            },
          },
        ],
      });

      await expect(
        executor.execute(createRequestContext(), mockEventBus),
      ).rejects.toThrow('interceptor rejected the request');
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('throws when beforeAgent removes the user message', async () => {
      mockRunnerYielding([]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [
          {
            beforeAgent: async () =>
              createRequestContext({userMessage: undefined}),
          },
        ],
      });

      await expect(
        executor.execute(createRequestContext(), mockEventBus),
      ).rejects.toThrow('message not provided');
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('does not publish an event that afterEvent drops', async () => {
      mockRunnerYielding([modelEvent('response', false)]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [{afterEvent: async () => undefined}],
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(publishedEvents().map((event) => event.kind)).toEqual([
        'task',
        'status-update',
        'status-update',
      ]);
    });

    it('publishes every event afterEvent fans out, in order', async () => {
      mockRunnerYielding([modelEvent('response', false)]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [
          {
            afterEvent: async (_executorContext, a2aEvent) => [
              a2aEvent,
              {
                kind: 'artifact-update',
                taskId: 'test-task',
                contextId: 'test-context',
                artifact: {
                  artifactId: 'audit-artifact',
                  parts: [{kind: 'text', text: 'audit'}],
                },
              },
            ],
          },
        ],
      });

      await executor.execute(createRequestContext(), mockEventBus);

      const events = publishedEvents();
      expect(events.map((event) => event.kind)).toEqual([
        'task',
        'status-update',
        'artifact-update',
        'artifact-update',
        'status-update',
      ]);
      expect(events[3]).toMatchObject({
        artifact: {artifactId: 'audit-artifact'},
      });
    });

    it('publishes the terminal event that the reversed afterAgent chain returns', async () => {
      mockRunnerYielding([]);
      const seen: string[] = [];
      const stamp = (name: string) => ({
        afterAgent: async (
          _executorContext: ExecutorContext,
          finalEvent: TaskStatusUpdateEvent,
        ) => {
          seen.push(`${name}:${finalEvent.metadata?.['stamp'] ?? 'none'}`);
          return {
            ...finalEvent,
            metadata: {...finalEvent.metadata, stamp: name},
          };
        },
      });

      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [stamp('outer'), stamp('inner')],
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(seen).toEqual(['inner:none', 'outer:inner']);
      expect(publishedEvents().at(-1)).toMatchObject({
        status: {state: 'completed'},
        metadata: {stamp: 'outer'},
      });
    });

    it('does not run afterAgent on the input-required early return', async () => {
      mockRunnerYielding([]);
      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [
          {
            afterAgent: async () =>
              expect.fail('afterAgent must not run on the early return'),
          },
        ],
      });

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

      expect(publishedEvents()).toHaveLength(1);
      expect(publishedEvents()[0]).toMatchObject({
        status: {state: 'input-required'},
      });
    });

    it('does not run afterAgent when the runner throws', async () => {
      mockRunnerYielding([], new Error('LLM failed'));

      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        executeInterceptors: [
          {
            afterAgent: async () =>
              expect.fail('afterAgent must not run on the failure path'),
          },
        ],
      });

      await executor.execute(createRequestContext(), mockEventBus);

      const final = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(final.status.state).toBe('failed');
      expect((final.status.message!.parts[0] as TextPart).text).toContain(
        'LLM failed',
      );
    });

    it('runs the existing callbacks alongside the interceptors', async () => {
      mockRunnerYielding([modelEvent('response', false)]);
      const calls: string[] = [];
      const record = (name: string) => async () => {
        calls.push(name);
      };

      const executor = new A2AAgentExecutor({
        runner: runnerConfig(),
        beforeExecuteCallback: record('beforeExecuteCallback'),
        afterEventCallback: record('afterEventCallback'),
        afterExecuteCallback: record('afterExecuteCallback'),
        executeInterceptors: [
          {
            beforeAgent: async (requestContext) => {
              calls.push('beforeAgent');
              return requestContext;
            },
            afterEvent: async (_executorContext, a2aEvent) => {
              calls.push('afterEvent');
              return a2aEvent;
            },
            afterAgent: async (_executorContext, finalEvent) => {
              calls.push('afterAgent');
              return finalEvent;
            },
          },
        ],
      });

      await executor.execute(createRequestContext(), mockEventBus);

      expect(calls).toEqual([
        'beforeAgent',
        'beforeExecuteCallback',
        'afterEventCallback',
        'afterEvent',
        'afterAgent',
        'afterExecuteCallback',
      ]);
    });
  });
});
