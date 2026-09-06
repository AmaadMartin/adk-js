/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TextPart,
} from '@a2a-js/sdk';
import {
  DefaultExecutionEventBus,
  ExecutionEventBus,
  RequestContext,
  ServerCallContext,
} from '@a2a-js/sdk/server';
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
  InMemorySessionService,
  LlmAgent,
  Runner,
  RunnerConfig,
  Session,
  TaskState,
  toGenAIPart,
} from '@google/adk';
import {beforeEach, describe, expect, it, MockInstance, vi} from 'vitest';
import {getAdkRunner} from '../../src/a2a/agent_executor.js';
import {NEW_A2A_ADK_INTEGRATION_EXTENSION} from '../../src/a2a/metadata_converter_utils.js';

const DEFAULT_USER_MESSAGE: Message = {
  kind: 'message',
  messageId: 'test-message',
  role: 'user',
  parts: [{kind: 'text', text: 'hello'}],
};

/**
 * A request the SDK's own type forbids: `userMessage` is required there, and
 * the guard under test exists for the context that arrives without one.
 */
const createMessagelessRequestContext = (): RequestContext =>
  new RequestContext(
    undefined as unknown as Message,
    'test-task',
    'test-context',
  );

/** A real session service whose lookups the tests drive. */
class MockSessionService extends InMemorySessionService {
  override getSession = vi.fn<BaseSessionService['getSession']>();
  override createSession = vi.fn<BaseSessionService['createSession']>();
}

/** The unmocked class, for the test that passes a real `Runner` through. */
const {Runner: ActualRunner} = await vi.importActual<
  typeof import('../../src/runner/runner.js')
>('../../src/runner/runner.js');

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
  let mockSessionService: MockSessionService;
  let mockEventBus: DefaultExecutionEventBus;
  let publishSpy: MockInstance<ExecutionEventBus['publish']>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionService = new MockSessionService();

    mockEventBus = new DefaultExecutionEventBus();
    publishSpy = vi.spyOn(mockEventBus, 'publish');
  });

  const createRequestContext = ({
    userMessage = DEFAULT_USER_MESSAGE,
    taskId = 'test-task',
    contextId = 'test-context',
    task,
    context,
  }: {
    userMessage?: Message;
    taskId?: string;
    contextId?: string;
    task?: Task;
    context?: ServerCallContext;
  } = {}): RequestContext =>
    new RequestContext(
      userMessage,
      taskId,
      contextId,
      task,
      undefined,
      context,
    );

  it('should throw an error if no message is provided', async () => {
    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      },
    });

    const ctx = createMessagelessRequestContext();
    await expect(executor.execute(ctx, mockEventBus)).rejects.toThrow(
      'message not provided',
    );
  });

  it('should get or create a session, run the agent, and publish working and final status events', async () => {
    const mockSession = testSession();
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

    mockRunner(mockRunAsync);

    let beforeExecutedCalled = false;
    let afterEventCount = 0;
    let afterExecuteCalled = false;

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      },
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
        JSON.stringify(publishSpy.mock.calls, null, 2),
      );
    }

    expect(beforeExecutedCalled).toBe(true);
    expect(afterEventCount).toBe(2);
    expect(afterExecuteCalled).toBe(true);

    // Verify event bus payload counts
    // Task + Working + 2 task artifact updates + 1 final task status
    expect(publishSpy).toHaveBeenCalledTimes(5);

    // Assert that the second published event is the "Working" event
    expect(publishSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'status-update',
      }),
    );
  });

  it('should return early with input required event if task needs input', async () => {
    const mockSession = testSession();
    mockSessionService.getSession.mockResolvedValue(mockSession);

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      },
    });

    const ctx = createRequestContext({
      task: {
        kind: 'task',
        id: 'test-task',
        contextId: 'test-context',
        status: {
          state: 'input-required',
          message: {
            kind: 'message',
            messageId: 'gate-message',
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
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0][0] as TaskStatusUpdateEvent;
    expect(event.kind).toBe('status-update');
    expect(event.status.state).toBe('input-required');
  });

  it('should handle unrecoverable runner errors properly', async () => {
    const mockSession = testSession();
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

    mockRunner(mockRunAsyncWithError);

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      },
    });

    const ctx = createRequestContext();
    await executor.execute(ctx, mockEventBus);

    // Task + Working + Artifact update (1) + Failed TaskStatusUpdate (1) = 4 calls
    if (publishSpy.mock.calls.length < 4) {
      console.error(
        'PUBLISHED EVENTS in error test:',
        JSON.stringify(publishSpy.mock.calls, null, 2),
      );
    }
    expect(publishSpy).toHaveBeenCalledTimes(4);

    const lastCallArg = publishSpy.mock.calls[3][0] as TaskStatusUpdateEvent;
    expect(lastCallArg.kind).toBe('status-update');
    expect(lastCallArg.status.state).toBe('failed');
    const firstPart = lastCallArg.status.message!.parts[0] as TextPart;
    expect(firstPart.text).toContain('LLM failed');
  });

  it('marks the run as remote-delivered, preserving the configured run config', async () => {
    // A human-in-the-loop gate is not answerable by the peer on the other end
    // of the transport; the run has to know where its message came from.
    const mockSession = testSession();
    mockSessionService.getSession.mockResolvedValue(mockSession);

    const mockRunAsync = vi.fn(async function* () {});
    mockRunner(mockRunAsync);

    const executor = new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      },
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
    vi.mocked(Runner).mockImplementation((config: RunnerConfig) => {
      // A Runner has far more surface than a test needs; the executor reads
      // only these three members.
      return {
        appName: config?.appName,
        sessionService: config?.sessionService,
        runAsync,
      } as unknown as Runner;
    });
  };

  const createExecutor = (config: Partial<AgentExecutorConfig> = {}) =>
    new A2AAgentExecutor({
      runner: {
        appName: 'test-app',
        sessionService: mockSessionService,
      },
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

  const publishedEvents = () => publishSpy.mock.calls.map((call) => call[0]);

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
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('rejects a task this executor never started', async () => {
      const executor = createExecutor();

      await expect(
        executor.cancelTask('unknown-task', mockEventBus),
      ).rejects.toThrow('No active A2A task unknown-task to cancel');
      expect(publishSpy).not.toHaveBeenCalled();
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

    it('forgets the task once the run is over', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      await expect(
        executor.cancelTask('test-task', mockEventBus),
      ).rejects.toThrow('No active A2A task test-task to cancel');
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

    it('merges the run config the converter supplied over the configured one', async () => {
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

    it('seeds the run with the state delta the converter supplied', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const runAsync = vi.fn(async function* () {});
      mockRunner(runAsync);

      const executor = createExecutor({
        requestConverter: (request) => ({
          userId: 'u',
          sessionId: request.contextId,
          newMessage: {role: 'user', parts: [{text: 'x'}]},
          stateDelta: {tenant: 'acme'},
        }),
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(runAsync).toHaveBeenCalledWith(
        expect.objectContaining({stateDelta: {tenant: 'acme'}}),
      );
    });

    it('runs against the resolved session, not the requested session id', async () => {
      mockSessionService.getSession.mockResolvedValue(undefined);
      mockSessionService.createSession.mockResolvedValue(testSession());
      const runAsync = vi.fn(async function* () {});
      mockRunner(runAsync);

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.createSession).toHaveBeenCalledWith({
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
      });
      expect(runAsync).toHaveBeenCalledWith(
        expect.objectContaining({sessionId: 'session-id'}),
      );
    });

    it('hands the configured a2a part converter to the request converter', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});
      const a2aPartConverter = vi.fn(() => ({text: 'converted'}));
      const requestConverter = vi.fn(() => ({
        userId: 'u',
        sessionId: 'test-context',
        newMessage: {role: 'user', parts: [{text: 'x'}]},
      }));

      const executor = createExecutor({a2aPartConverter, requestConverter});
      const ctx = createRequestContext();
      await executor.execute(ctx, mockEventBus);

      expect(requestConverter).toHaveBeenCalledWith(ctx, a2aPartConverter);
    });

    it('defaults the part converter to toGenAIPart', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});
      const requestConverter = vi.fn(() => ({
        userId: 'u',
        sessionId: 'test-context',
        newMessage: {role: 'user', parts: [{text: 'x'}]},
      }));

      const executor = createExecutor({requestConverter});
      await executor.execute(createRequestContext(), mockEventBus);

      expect(requestConverter).toHaveBeenCalledWith(
        expect.anything(),
        toGenAIPart,
      );
    });
  });

  describe('event converter', () => {
    it('receives the ADK event, the executor context and the part converter', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const adkEvent = modelEvent('hello');
      mockRunner(async function* () {
        yield adkEvent;
      });
      const genAiPartConverter = vi.fn(
        () => ({kind: 'text', text: 'x'}) as Part,
      );
      const eventConverter = vi.fn(() => []);

      const executor = createExecutor({eventConverter, genAiPartConverter});
      await executor.execute(createRequestContext(), mockEventBus);

      expect(eventConverter).toHaveBeenCalledWith(
        adkEvent,
        expect.objectContaining({appName: 'test-app', sessionId: 'session-id'}),
        genAiPartConverter,
      );
    });

    it('lets a custom gen-ai part converter shape the default artifact update', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });

      const executor = createExecutor({
        genAiPartConverter: () => ({kind: 'text', text: 'rewritten'}),
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const artifact = publishedEvents()[2] as TaskArtifactUpdateEvent;
      expect(artifact.artifact.parts).toEqual([
        {kind: 'text', text: 'rewritten'},
      ]);
    });

    it('publishes a failed terminal event when the converter throws', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });

      const executor = createExecutor({
        eventConverter: () => {
          throw new Error('converter exploded');
        },
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const failed = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(failed.status.state).toBe('failed');
      expect((failed.status.message!.parts[0] as TextPart).text).toBe(
        'Agent run failed: converter exploded',
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

      // Published as a copy of it: the executor stamps the invocation
      // metadata onto the terminal event.
      expect(publishedEvents().at(-1)).toMatchObject(rewritten);
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

    it('settles on auth-required without an aggregated artifact update', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {
        yield modelEvent('hello');
      });

      const executor = createExecutor({
        eventConverter: () => [
          statusUpdate(TaskState.AUTH_REQUIRED, [
            {kind: 'text', text: 'log in first'},
          ]),
        ],
      });
      await executor.execute(createRequestContext(), mockEventBus);

      const kinds = publishedEvents().map((event) => event.kind);
      expect(kinds).toEqual([
        'task',
        'status-update',
        'status-update',
        'status-update',
      ]);

      const terminal = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(terminal.status.state).toBe('auth-required');
      expect(terminal.status.message?.parts).toEqual([
        {kind: 'text', text: 'log in first'},
      ]);
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
    it('completes a run that produced no event, with no last-event keys', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});

      const executor = createExecutor();
      await executor.execute(createRequestContext(), mockEventBus);

      const terminal = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(terminal.status.state).toBe('completed');
      expect(terminal.metadata).toEqual({
        adk_app_name: 'test-app',
        adk_user_id: 'test-user',
        adk_session_id: 'session-id',
        [NEW_A2A_ADK_INTEGRATION_EXTENSION]: {adk_agent_executor_v2: true},
      });
      expect(terminal.metadata).not.toHaveProperty('adk_event_id');
    });

    it('puts the session metadata on the working event and the last event ids on the terminal one', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const firstEvent = modelEvent('hello');
      const lastEvent = modelEvent('goodbye');
      mockRunner(async function* () {
        yield firstEvent;
        yield lastEvent;
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
        [NEW_A2A_ADK_INTEGRATION_EXTENSION]: {adk_agent_executor_v2: true},
      });

      const terminal = publishedEvents().at(-1) as TaskStatusUpdateEvent;
      expect(terminal.metadata).toEqual({
        adk_app_name: 'test-app',
        adk_user_id: 'test-user',
        adk_session_id: 'session-id',
        adk_invocation_id: lastEvent.invocationId,
        adk_author: 'model',
        adk_event_id: lastEvent.id,
        [NEW_A2A_ADK_INTEGRATION_EXTENSION]: {adk_agent_executor_v2: true},
      });
      expect(lastEvent.id).not.toBe(firstEvent.id);
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
    it('runs a Runner instance as it is', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const runner = new ActualRunner({
        appName: 'test-app',
        agent: new LlmAgent({name: 'test-agent'}),
        sessionService: mockSessionService,
      });
      const runAsync = vi
        .spyOn(runner, 'runAsync')
        .mockImplementation(async function* () {});

      await new A2AAgentExecutor({runner}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(runAsync).toHaveBeenCalledTimes(1);
      expect(vi.mocked(Runner)).not.toHaveBeenCalled();
    });

    it('resolves a runner returned by a sync factory', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const runAsync = vi.fn(async function* () {});
      mockRunner(runAsync);
      const executor = new A2AAgentExecutor({
        runner: () => ({
          appName: 'test-app',
          sessionService: mockSessionService,
        }),
      });
      await executor.execute(createRequestContext(), mockEventBus);

      expect(runAsync).toHaveBeenCalledTimes(1);
    });

    it('resolves a runner returned by an async factory', async () => {
      mockSessionService.getSession.mockResolvedValue(testSession());
      const runAsync = vi.fn(async function* () {});
      mockRunner(runAsync);
      const executor = new A2AAgentExecutor({
        runner: async () => ({
          appName: 'test-app',
          sessionService: mockSessionService,
        }),
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

      expect(publishSpy).toHaveBeenCalledTimes(2);
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
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('rejects a request with no context id', async () => {
      const executor = createExecutor();

      await expect(
        executor.execute(createRequestContext({contextId: ''}), mockEventBus),
      ).rejects.toThrow('A2A request must have a context ID');
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('does not run a beforeAgent interceptor on a request with no message', async () => {
      const beforeAgent = vi.fn(async (ctx: RequestContext) => ctx);
      const executor = createExecutor({executeInterceptors: [{beforeAgent}]});

      await expect(
        executor.execute(createMessagelessRequestContext(), mockEventBus),
      ).rejects.toThrow('message not provided');
      expect(beforeAgent).not.toHaveBeenCalled();
    });

    it('rejects when a beforeAgent interceptor strips the task id', async () => {
      const executor = createExecutor({
        executeInterceptors: [
          {
            beforeAgent: async (ctx) =>
              ({...ctx, taskId: ''}) as RequestContext,
          },
        ],
      });

      await expect(
        executor.execute(createRequestContext(), mockEventBus),
      ).rejects.toThrow('A2A request must have a task ID');
      expect(publishSpy).not.toHaveBeenCalled();
    });
  });

  describe('parity gap closures', () => {
    const EXTENSION_FLAG = {adk_agent_executor_v2: true};

    /** A config the executor accepts, wired to the mocked session service. */
    function runnerConfig(): RunnerConfig {
      return {appName: 'test-app', sessionService: mockSessionService};
    }

    function publishedEvent(index: number): TaskStatusUpdateEvent {
      return publishSpy.mock.calls[index][0] as TaskStatusUpdateEvent;
    }

    beforeEach(() => {
      mockSessionService.getSession.mockResolvedValue(testSession());
    });

    it('publishes the last error of the run, not the first', async () => {
      mockRunner(async function* () {
        yield createEvent({author: 'model', errorMessage: 'first failure'});
        yield createEvent({author: 'model', errorMessage: 'second failure'});
      });

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      const finalEvent = publishedEvent(publishSpy.mock.calls.length - 1);
      expect(finalEvent.status.state).toBe('failed');
      expect((finalEvent.status.message!.parts[0] as TextPart).text).toContain(
        'second failure',
      );
    });

    it('reports the default text and keeps the error code when the event carries no message', async () => {
      mockRunner(async function* () {
        yield createEvent({author: 'model', errorCode: 'SAFETY_BLOCK'});
      });

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      const finalEvent = publishedEvent(publishSpy.mock.calls.length - 1);
      expect(finalEvent.status.state).toBe('failed');
      // The text matches adk-python's `DEFAULT_ERROR_MESSAGE`, and the code
      // reaches the client on the metadata rather than in the text.
      expect((finalEvent.status.message!.parts[0] as TextPart).text).toContain(
        'An error occurred during processing',
      );
      expect(finalEvent.metadata).toEqual(
        expect.objectContaining({adk_error_code: 'SAFETY_BLOCK'}),
      );
    });

    it('publishes the artifact of an errored event before the terminal failure', async () => {
      mockRunner(async function* () {
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
      expect(publishSpy).toHaveBeenCalledTimes(4);
      expect(publishSpy.mock.calls[2][0].kind).toBe('artifact-update');
      expect(publishedEvent(3).status.state).toBe('failed');
    });

    it('stamps the integration extension on every published event', async () => {
      mockRunner(async function* () {
        yield createEvent({
          author: 'model',
          content: {role: 'model', parts: [{text: 'hello back'}]},
        });
      });

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(publishSpy).toHaveBeenCalledTimes(4);
      for (const [event] of publishSpy.mock.calls) {
        expect(event.metadata).toMatchObject({
          [NEW_A2A_ADK_INTEGRATION_EXTENSION]: EXTENSION_FLAG,
          'adk_app_name': 'test-app',
          'adk_session_id': 'session-id',
        });
      }
    });

    it('keeps the per-event metadata on an artifact update', async () => {
      mockRunner(async function* () {
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

      expect(publishSpy.mock.calls[2][0].metadata).toMatchObject({
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
                kind: 'message',
                messageId: 'gate-message',
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

      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(publishedEvent(0).metadata).toMatchObject({
        [NEW_A2A_ADK_INTEGRATION_EXTENSION]: EXTENSION_FLAG,
      });
    });

    it('looks the session up with its event history, after the probe', async () => {
      mockRunner(async function* () {});

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      // The probe skips the history, so the second read is the one that must
      // carry it: `getUnansweredRequestEvent` reads those events.
      expect(mockSessionService.getSession).toHaveBeenCalledTimes(2);
      expect(mockSessionService.getSession).toHaveBeenLastCalledWith({
        appName: 'test-app',
        userId: 'A2A_USER_test-context',
        sessionId: 'test-context',
      });
      expect(mockSessionService.createSession).not.toHaveBeenCalled();
    });

    it('creates the session only when the lookup misses', async () => {
      mockSessionService.getSession.mockReset();
      mockSessionService.getSession.mockResolvedValue(undefined);
      mockSessionService.createSession.mockResolvedValue(testSession());
      mockRunner(async function* () {});

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

    it('keeps a pause recorded only in the session history open', async () => {
      // The gate is not on the incoming A2A task, so the executor has to read
      // it out of the session the lookup returns.
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
      mockSessionService.getSession.mockResolvedValue(
        createSession({
          id: 'session-id',
          userId: 'test-user',
          appName: 'test-app',
          events: [pendingCall],
        }),
      );

      await new A2AAgentExecutor({runner: runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      // The leading submitted task precedes the gate's status update.
      expect(publishSpy).toHaveBeenCalledTimes(2);
      expect(publishedEvent(1).status.state).toBe('input-required');
    });

    it('names null and a prototype-less object in the runner error', async () => {
      await expect(getAdkRunner(null)).rejects.toThrow(
        'Runner must be a Runner instance or a callable that returns a Runner, got null',
      );
      await expect(getAdkRunner(Object.create(null))).rejects.toThrow(
        'Runner must be a Runner instance or a callable that returns a Runner, got object',
      );
    });

    it('resolves a runner config returned by a factory', async () => {
      mockRunner(async function* () {});

      await new A2AAgentExecutor({runner: () => runnerConfig()}).execute(
        createRequestContext(),
        mockEventBus,
      );

      expect(publishSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('session lookup', () => {
    const PROBE_REQUEST = {
      appName: 'test-app',
      userId: 'A2A_USER_test-context',
      sessionId: 'test-context',
      config: {numRecentEvents: 0},
    };
    const FULL_READ_REQUEST = {
      appName: 'test-app',
      userId: 'A2A_USER_test-context',
      sessionId: 'test-context',
    };

    /** An open `adk_request_confirmation` call, which holds the task open. */
    const unansweredRequest = () =>
      createEvent({
        author: 'model',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'fc-open',
                name: 'adk_request_confirmation',
                args: {},
              },
            },
          ],
        },
        actions: createEventActions(),
      });

    const session = (events: AdkEvent[]): Session =>
      createSession({
        id: 'test-context',
        userId: 'A2A_USER_test-context',
        appName: 'test-app',
        events,
      });

    function executor(): A2AAgentExecutor {
      const runner: RunnerConfig = {
        appName: 'test-app',
        sessionService: mockSessionService,
      };
      return new A2AAgentExecutor({runner});
    }

    it('probes without event history, then reads the history it skipped', async () => {
      // VertexAiSessionService honours `numRecentEvents: 0` by returning no
      // events, so the pending-request scan must read the second result.
      mockSessionService.getSession
        .mockResolvedValueOnce(session([]))
        .mockResolvedValueOnce(session([unansweredRequest()]));

      await executor().execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.getSession).toHaveBeenCalledTimes(2);
      expect(mockSessionService.getSession).toHaveBeenNthCalledWith(
        1,
        PROBE_REQUEST,
      );
      expect(mockSessionService.getSession).toHaveBeenNthCalledWith(
        2,
        FULL_READ_REQUEST,
      );
      expect(mockSessionService.createSession).not.toHaveBeenCalled();

      expect(publishedStates()).toEqual(['input-required']);
    });

    it('creates the session and skips the second read when the probe finds none', async () => {
      mockSessionService.getSession.mockResolvedValue(undefined);
      mockSessionService.createSession.mockResolvedValue(session([]));

      await executor().execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.getSession).toHaveBeenCalledTimes(1);
      expect(mockSessionService.getSession).toHaveBeenCalledWith(PROBE_REQUEST);
      expect(mockSessionService.createSession).toHaveBeenCalledWith(
        FULL_READ_REQUEST,
      );
    });

    it('creates the session when it is deleted between the two reads', async () => {
      // The probe returns no events, as Vertex does, so reusing its result
      // would hand the pending-request scan an empty history.
      mockSessionService.getSession
        .mockResolvedValueOnce(session([]))
        .mockResolvedValueOnce(undefined);
      mockSessionService.createSession.mockResolvedValue(session([]));

      await executor().execute(createRequestContext(), mockEventBus);

      expect(mockSessionService.getSession).toHaveBeenCalledTimes(2);
      expect(mockSessionService.createSession).toHaveBeenCalledWith(
        FULL_READ_REQUEST,
      );
    });
  });
});
