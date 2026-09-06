/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskArtifactUpdateEvent, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {RunConfig} from '../agents/run_config.js';
import {Event as AdkEvent} from '../events/event.js';
import {
  isRunner,
  isRunnerConfig,
  Runner,
  RunnerConfig,
} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {
  A2AEvent,
  createFinalTaskStatusEvent,
  createTaskArtifactUpdateEvent,
  createTaskCompletedEvent,
  createTaskFailedEvent,
  createTaskWorkingEvent,
  isTaskArtifactUpdateEvent,
  TaskState,
} from './a2a_event.js';
import {
  DEFAULT_ERROR_MESSAGE,
  getFinalTaskStatusUpdate,
  getUnansweredRequestEvent,
} from './event_processor_utils.js';
import {
  A2aAgentExecutorConverterConfig,
  resolveA2aAgentExecutorConfig,
  ResolvedA2aAgentExecutorConfig,
} from './executor_config.js';
import {createExecutorContext, ExecutorContext} from './executor_context.js';
import {
  enqueueSubmittedSignal,
  executeAfterAgentInterceptors,
  executeAfterEventInterceptors,
  executeBeforeAgentInterceptors,
  ExecuteInterceptor,
  requireRequestContext,
} from './executor_utils.js';
import {
  A2AMetadataKeys,
  getA2AEventMetadata,
  getInvocationMetadata,
} from './metadata_converter_utils.js';
import {
  A2ARequestToAgentRunRequestConverter,
  AgentRunRequest,
  convertA2aRequestToAgentRunRequest,
} from './request_converter_utils.js';
import {getA2aRequestMetadata} from './request_metadata.js';
import {TaskResultAggregator} from './task_result_aggregator.js';

/**
 * Represents a runner or a configuration for a runner.
 */
export type RunnerOrRunnerConfig =
  | Runner
  | RunnerConfig
  | (() => Runner | RunnerConfig)
  | (() => Promise<Runner | RunnerConfig>);

/**
 * Callback called before execution starts.
 */
export type BeforeExecuteCallback = (
  reqCtx: RequestContext,
  a2aMetadata?: Record<string, unknown>,
) => Promise<void>;

/**
 * Callback called after an ADK event is converted to an A2A event.
 */
export type AfterEventCallback = (
  ctx: ExecutorContext,
  adkEvent: AdkEvent,
  a2aEvent?: TaskArtifactUpdateEvent,
) => Promise<void>;

/**
 * Callback called after execution resolved into a completed or failed task.
 */
export type AfterExecuteCallback = (
  ctx: ExecutorContext,
  finalA2aEvent: TaskStatusUpdateEvent,
  err?: Error,
) => Promise<void>;

/**
 * Configuration for the Executor.
 */
export interface AgentExecutorConfig extends A2aAgentExecutorConverterConfig {
  // `genAiPartConverter` comes from A2aAgentExecutorConverterConfig: it
  // converts one GenAI part to an A2A part, and a part it converts to nothing
  // is dropped from the published event.
  runner: RunnerOrRunnerConfig;
  runConfig?: RunConfig;
  beforeExecuteCallback?: BeforeExecuteCallback;
  afterEventCallback?: AfterEventCallback;
  afterExecuteCallback?: AfterExecuteCallback;

  /**
   * Derives the runner arguments from the request. Defaults to
   * `convertA2aRequestToAgentRunRequest`.
   */
  requestConverter?: A2ARequestToAgentRunRequestConverter;

  // `eventConverter` also comes from A2aAgentExecutorConverterConfig: it
  // converts one ADK event with the whole executor context in hand, and takes
  // precedence over `adkEventConverter`, which receives the task and context
  // ids instead.

  /** Hooks that can rewrite the request, the events and the terminal event. */
  executeInterceptors?: ExecuteInterceptor[];
}

/**
 * What `cancelTask` needs to settle and stop one running execution, addressed
 * by the task id the A2A request handler gives it.
 */
interface InFlightExecution {
  contextId: string;
  abortController: AbortController;
}

/**
 * AgentExecutor invokes an ADK agent and translates session events to A2A events.
 */
export class A2AAgentExecutor implements AgentExecutor {
  /**
   * The executions this executor is running. An entry lives only for the
   * duration of one `execute` call.
   */
  private readonly inFlightExecutions = new Map<string, InFlightExecution>();

  /** Every converter slot, with the unset ones filled by their default. */
  private readonly converters: ResolvedA2aAgentExecutorConfig;

  constructor(private readonly config: AgentExecutorConfig) {
    this.converters = resolveA2aAgentExecutorConfig(config);
  }

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    // Validated before anything else runs: a request with no message, task id
    // or context id names no task to report a failure against, so it has to
    // reject rather than publish one.
    requireRequestContext(ctx);

    const reqCtx = await executeBeforeAgentInterceptors(
      ctx,
      this.config.executeInterceptors,
    );
    const {taskId, contextId} = requireRequestContext(reqCtx);
    const abortController = new AbortController();
    this.inFlightExecutions.set(taskId, {contextId, abortController});

    let executorContext: ExecutorContext | undefined;
    let submitted = false;

    // The submitted signal precedes every event this execution publishes,
    // including the terminal event of a run that failed while resolving the
    // runner or the session. The SDK's result manager drops a status update
    // for a task it has not seen, so the caller would receive no task at all.
    // It carries the invocation metadata once the session is resolved; a run
    // that failed before that point has no session to name.
    const publishSubmittedSignal = (): void => {
      if (submitted) {
        return;
      }
      submitted = true;
      enqueueSubmittedSignal(
        reqCtx,
        eventBus,
        executorContext ? getInvocationMetadata(executorContext) : undefined,
      );
    };

    try {
      const runner = await getAdkRunner(this.config.runner);
      let runRequest = (
        this.config.requestConverter ?? convertA2aRequestToAgentRunRequest
      )(reqCtx, this.converters.a2aPartConverter);
      const {session, created} = await getAdkSession(
        runRequest.userId,
        runRequest.sessionId,
        runner.sessionService,
        runner.appName,
      );
      if (created) {
        // The service can assign an id of its own to a session it creates, and
        // the run has to address the session that now exists rather than the
        // one that was asked for.
        runRequest = {...runRequest, sessionId: session.id};
      }
      executorContext = createExecutorContext({
        session,
        userContent: runRequest.newMessage,
        requestContext: reqCtx,
        a2aMetadata: getA2aRequestMetadata(reqCtx),
      });
      publishSubmittedSignal();

      await this.runLegacy(
        runner,
        runRequest,
        executorContext,
        eventBus,
        abortController.signal,
      );
    } catch (e: unknown) {
      const error = toError(e);
      // A cancelled run already published `canceled`, which is terminal. A
      // `failed` event after it makes the request handler reject the
      // cancellation it has already accepted.
      if (abortController.signal.aborted) {
        logger.debug(`A2A task ${taskId} was canceled while running:`, error);

        return;
      }
      logger.error('Error handling A2A request:', error);
      publishSubmittedSignal();

      await this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        error,
        event: createTaskFailedEvent({
          taskId,
          contextId,
          error: new Error(`Agent run failed: ${error.message}`),
        }),
      });
    } finally {
      this.inFlightExecutions.delete(taskId);
    }
  }

  /**
   * Stops the running execution and publishes the terminal `canceled` status
   * update the A2A cancellation contract requires. The request handler drains
   * events until it sees one, so a cancellation that publishes nothing never
   * completes.
   *
   * The run stops at the runner's next abort checkpoint, and the execution
   * publishes no terminal event of its own after that.
   *
   * @throws {Error} When the task id is empty, or when this executor has no
   *   execution in flight for it.
   */
  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    if (!taskId) {
      throw new Error('A2A cancellation must have a task ID');
    }

    const execution = this.inFlightExecutions.get(taskId);
    if (!execution) {
      throw new Error(`No active A2A task ${taskId} to cancel`);
    }
    this.inFlightExecutions.delete(taskId);
    execution.abortController.abort();

    eventBus.publish(
      createFinalTaskStatusEvent({
        taskId,
        contextId: execution.contextId,
        state: TaskState.CANCELED,
      }),
    );
  }

  private async runLegacy(
    runner: Runner,
    runRequest: AgentRunRequest,
    executorContext: ExecutorContext,
    eventBus: ExecutionEventBus,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const ctx = executorContext.requestContext;
    const {taskId, contextId} = ctx;
    const a2aMetadata = executorContext.a2aMetadata;

    if (this.config.beforeExecuteCallback) {
      await this.config.beforeExecuteCallback(ctx, a2aMetadata);
    }

    const unansweredRequestEvent = getUnansweredRequestEvent({
      taskId,
      contextId,
      task: ctx.task,
      sessionEvents: executorContext.events,
      genAIContent: runRequest.newMessage,
    });
    if (unansweredRequestEvent) {
      return this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        event: unansweredRequestEvent,
      });
    }

    eventBus.publish(
      createTaskWorkingEvent({
        taskId,
        contextId,
        metadata: getInvocationMetadata(executorContext),
      }),
    );

    const aggregator = new TaskResultAggregator();
    const adkEvents: AdkEvent[] = [];
    // Held per execution: two concurrent requests to one executor must not
    // append their streamed parts to each other's artifact.
    const partialArtifactIds = new Map<string, string>();
    let lastAdkEvent: AdkEvent | undefined;
    let errorStatusEvent: TaskStatusUpdateEvent | undefined;

    for await (const adkEvent of runner.runAsync({
      abortSignal,
      userId: runRequest.userId,
      sessionId: runRequest.sessionId,
      newMessage: runRequest.newMessage,
      stateDelta: runRequest.stateDelta,
      // Marked remote so the run knows this message came from a peer rather
      // than from the operator: a human-in-the-loop gate is not answerable
      // over A2A unless the deployment opts in.
      runConfig: {
        ...this.config.runConfig,
        ...runRequest.runConfig,
        remoteDelivered: true,
        ...(a2aMetadata ? {a2aMetadata} : {}),
      },
    })) {
      adkEvents.push(adkEvent);
      lastAdkEvent = adkEvent;

      // Reassigned rather than broken out of, so the last error wins.
      if (adkEvent.errorCode || adkEvent.errorMessage) {
        errorStatusEvent = createTaskFailedEvent({
          taskId,
          contextId,
          error: new Error(adkEvent.errorMessage || DEFAULT_ERROR_MESSAGE),
          metadata: getA2AEventMetadata(adkEvent, executorContext),
        });
      }

      for (const converted of this.convertAdkEvent(
        adkEvent,
        executorContext,
        partialArtifactIds,
      )) {
        const a2aEvents = await executeAfterEventInterceptors(
          converted,
          executorContext,
          adkEvent,
          this.config.executeInterceptors,
        );
        for (const a2aEvent of a2aEvents) {
          aggregator.processEvent(a2aEvent);
          await this.config.afterEventCallback?.(
            executorContext,
            adkEvent,
            isTaskArtifactUpdateEvent(a2aEvent) ? a2aEvent : undefined,
          );
          eventBus.publish(a2aEvent);
        }
      }
    }

    if (abortSignal.aborted) {
      logger.debug(
        `A2A task ${taskId} was canceled; the cancellation is its terminal event.`,
      );

      return;
    }

    const finalMetadata = {
      ...getInvocationMetadata(executorContext),
      ...(lastAdkEvent ? getLastEventMetadata(lastAdkEvent) : {}),
    };

    // Built even when an ADK event already reported an error, because it also
    // publishes the aggregated artifact update that carries the run's content.
    const aggregatedEvent = this.buildFinalEvent({
      aggregator,
      adkEvents,
      executorContext,
      eventBus,
      finalMetadata,
    });

    return this.publishFinalTaskStatus({
      executorContext,
      eventBus,
      // An ADK event that reported an error settles the task as failed,
      // whatever else the run produced.
      event: await executeAfterAgentInterceptors(
        executorContext,
        errorStatusEvent ?? aggregatedEvent,
        this.config.executeInterceptors,
      ),
    });
  }

  /**
   * Decides the terminal event, publishing the aggregated artifact update that
   * has to precede it when the run produced status message parts.
   */
  private buildFinalEvent({
    aggregator,
    adkEvents,
    executorContext,
    eventBus,
    finalMetadata,
  }: {
    aggregator: TaskResultAggregator;
    adkEvents: AdkEvent[];
    executorContext: ExecutorContext;
    eventBus: ExecutionEventBus;
    finalMetadata: Record<string, unknown>;
  }): TaskStatusUpdateEvent {
    const {taskId, contextId} = executorContext.requestContext;

    if (aggregator.taskState !== TaskState.WORKING) {
      return createFinalTaskStatusEvent({
        taskId,
        contextId,
        state: aggregator.taskState,
        message: aggregator.taskStatusMessage,
        metadata: finalMetadata,
      });
    }

    const statusParts = aggregator.taskStatusMessage?.parts;
    if (!statusParts?.length) {
      return getFinalTaskStatusUpdate(
        adkEvents,
        executorContext,
        this.converters.genAiPartConverter,
      );
    }

    eventBus.publish(
      createTaskArtifactUpdateEvent({
        taskId,
        contextId,
        parts: statusParts,
        metadata: finalMetadata,
        lastChunk: true,
      }),
    );

    return createTaskCompletedEvent({
      taskId,
      contextId,
      metadata: finalMetadata,
    });
  }

  /**
   * Converts one ADK event with whichever event converter the config selects.
   *
   * `eventConverter` wins over `adkEventConverter`, so a config that sets both
   * gets the one that reads the executor context.
   */
  private convertAdkEvent(
    adkEvent: AdkEvent,
    executorContext: ExecutorContext,
    partialArtifactIds: Map<string, string>,
  ): A2AEvent[] {
    const {taskId, contextId} = executorContext.requestContext;
    const {adkEventConverter, eventConverter, genAiPartConverter} =
      this.converters;
    const a2aEvents = eventConverter
      ? eventConverter(adkEvent, executorContext, genAiPartConverter)
      : adkEventConverter(
          adkEvent,
          partialArtifactIds,
          taskId,
          contextId,
          genAiPartConverter,
        );

    // A converter reports the run, not the ADK bookkeeping around it, so the
    // executor stamps that onto everything a converter returns.
    for (const a2aEvent of a2aEvents) {
      a2aEvent.metadata = {
        ...a2aEvent.metadata,
        ...getA2AEventMetadata(adkEvent, executorContext),
        ...getInvocationMetadata(executorContext),
      };
    }

    return a2aEvents;
  }

  /**
   * Writes the final status event to the queue.
   */
  private async publishFinalTaskStatus({
    executorContext,
    eventBus,
    event,
    error,
  }: {
    executorContext?: ExecutorContext;
    eventBus: ExecutionEventBus;
    event: TaskStatusUpdateEvent;
    error?: Error;
  }): Promise<void> {
    // A run that failed before it resolved its session names no invocation,
    // so its terminal event carries no metadata at all.
    const finalEvent = executorContext
      ? withInvocationMetadata(event, executorContext)
      : event;
    try {
      if (executorContext) {
        await this.config.afterExecuteCallback?.(
          executorContext,
          finalEvent,
          error,
        );
      }
    } catch (e: unknown) {
      logger.error('Error in afterExecuteCallback:', e);
    }

    eventBus.publish(finalEvent);
  }
}

/**
 * The invocation, author and event ids of the last ADK event a run produced,
 * so a client can tie the terminal event back to it. Absent values are left
 * out rather than written as `undefined`.
 */
function getLastEventMetadata(adkEvent: AdkEvent): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [
    [A2AMetadataKeys.INVOCATION_ID, adkEvent.invocationId],
    [A2AMetadataKeys.AUTHOR, adkEvent.author],
    [A2AMetadataKeys.EVENT_ID, adkEvent.id],
  ];

  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

/**
 * Narrows an unknown thrown value to an Error.
 */
function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Merges the invocation metadata into an already-built A2A event.
 *
 * Spreads on top of the event's own metadata rather than replacing it, so the
 * per-event keys survive.
 */
function withInvocationMetadata<T extends {metadata?: Record<string, unknown>}>(
  event: T,
  context: ExecutorContext,
): T {
  return {
    ...event,
    metadata: {...event.metadata, ...getInvocationMetadata(context)},
  };
}

/**
 * Gets or creates new ADK session.
 *
 * Reads an existing session twice. The first read only asks whether the
 * session exists, so it skips the event history, matching `_resolve_session`
 * in adk-python. The second read fetches that history, which
 * `getUnansweredRequestEvent` needs to decide whether a pending
 * human-in-the-loop request is still open. adk-python needs one read because
 * its `Runner` reloads the session itself and its executor never reads events.
 *
 * `created` reports whether this call created the session, because only a
 * created session can carry an id the service chose instead of the one that
 * was requested.
 *
 * @returns A session carrying its event history, never the probe result.
 */
async function getAdkSession(
  userId: string,
  sessionId: string,
  sessionService: BaseSessionService,
  appName: string,
): Promise<{session: Session; created: boolean}> {
  const exists = await sessionService.getSession({
    appName,
    userId,
    sessionId,
    // Checking existence does not require event history.
    config: {numRecentEvents: 0},
  });

  const sessionWithEvents = exists
    ? await sessionService.getSession({appName, userId, sessionId})
    : undefined;

  if (sessionWithEvents) {
    return {session: sessionWithEvents, created: false};
  }

  // A session deleted between the two reads is created fresh. Returning the
  // probe result instead would hand the pending-request scan the empty history
  // that `numRecentEvents: 0` asked for.
  return {
    session: await sessionService.createSession({
      appName,
      userId,
      sessionId,
    }),
    created: true,
  };
}

/**
 * Resolves the runner from the provided runner or runner config.
 *
 * Takes `unknown` because the value arrives unvalidated: a JavaScript caller,
 * or a factory whose declared return type does not match what it returns, can
 * hand over anything.
 *
 * @param runnerOrConfig The runner, runner config, or factory for either.
 * @param fromFactory Whether this value came out of a factory, which decides
 *   which of the two error messages a bad value gets.
 * @returns The resolved runner.
 * @throws {TypeError} If the value is neither a Runner nor a runner config.
 */
export async function getAdkRunner(
  runnerOrConfig: unknown,
  fromFactory = false,
): Promise<Runner> {
  if (typeof runnerOrConfig === 'function') {
    return getAdkRunner(await runnerOrConfig(), true);
  }

  if (isRunner(runnerOrConfig)) {
    return runnerOrConfig;
  }

  if (!isRunnerConfig(runnerOrConfig)) {
    // The type only: the value itself may carry credentials.
    throw new TypeError(
      fromFactory
        ? `Runner factory must return a Runner or a runner config, got ${describeType(runnerOrConfig)}`
        : `Runner must be a Runner instance or a callable that returns a Runner, got ${describeType(runnerOrConfig)}`,
    );
  }

  return new Runner(runnerOrConfig);
}

/**
 * Names the type of a value for an error message.
 */
function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value !== 'object') {
    return typeof value;
  }

  return value.constructor?.name ?? 'object';
}
