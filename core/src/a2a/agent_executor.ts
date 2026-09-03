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
import {isRunner, Runner, RunnerConfig} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {Session} from '../sessions/session.js';
import {randomUUID} from '../utils/env_aware_utils.js';
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
  getFinalTaskStatusUpdate,
  getUnansweredRequestEvent,
} from './event_processor_utils.js';
import {createExecutorContext, ExecutorContext} from './executor_context.js';
import {
  activateNewVersionExtension,
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
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';
import {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
  toA2APart,
  toA2AParts,
  toGenAIPart,
} from './part_converter_utils.js';
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
 * Converts one ADK event into the A2A events that represent it.
 */
export type AdkEventToA2AEventsConverter = (
  adkEvent: AdkEvent,
  ctx: ExecutorContext,
  genAiPartConverter: GenAIPartToA2APartConverter,
) => A2AEvent[];

/**
 * Configuration for the Executor.
 */
export interface AgentExecutorConfig {
  runner: RunnerOrRunnerConfig;
  runConfig?: RunConfig;
  beforeExecuteCallback?: BeforeExecuteCallback;
  afterEventCallback?: AfterEventCallback;
  afterExecuteCallback?: AfterExecuteCallback;

  /** Converts an inbound A2A part. Defaults to `toGenAIPart`. */
  a2aPartConverter?: A2APartToGenAIPartConverter;

  /** Converts an outbound GenAI part. Defaults to `toA2APart`. */
  genAiPartConverter?: GenAIPartToA2APartConverter;

  /**
   * Derives the runner arguments from the request. Defaults to
   * `convertA2aRequestToAgentRunRequest`.
   */
  requestConverter?: A2ARequestToAgentRunRequestConverter;

  /**
   * Converts each ADK event into A2A events. Defaults to a single artifact
   * update carrying the event's parts.
   */
  eventConverter?: AdkEventToA2AEventsConverter;

  /** Hooks that can rewrite the request, the events and the terminal event. */
  executeInterceptors?: ExecuteInterceptor[];

  /** Serves every request on the legacy path, ignoring the extension. */
  useLegacy?: boolean;

  /** Serves every request on the new path, without waiting for the extension. */
  forceNewVersion?: boolean;

  /**
   * The executor that serves the new ADK A2A integration. Without one, a
   * request that asks for the new path is served on the legacy path.
   */
  newVersionExecutor?: AgentExecutor;
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

  constructor(private readonly config: AgentExecutorConfig) {}

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    if (this.shouldUseNewVersion(ctx)) {
      const newVersionExecutor = this.config.newVersionExecutor;
      if (!newVersionExecutor) {
        throw new Error(
          'forceNewVersion is set but no newVersionExecutor is configured.',
        );
      }

      return newVersionExecutor.execute(ctx, eventBus);
    }

    const reqCtx = await executeBeforeAgentInterceptors(
      ctx,
      this.config.executeInterceptors,
    );
    const {taskId, contextId} = requireRequestContext(reqCtx);
    const abortController = new AbortController();
    this.inFlightExecutions.set(taskId, {contextId, abortController});

    // The submitted signal precedes every event this execution publishes,
    // including the terminal event of a run that failed while resolving the
    // runner or the session. The SDK's result manager drops a status update
    // for a task it has not seen, so the caller would receive no task at all.
    enqueueSubmittedSignal(reqCtx, eventBus);

    let executorContext: ExecutorContext | undefined;
    try {
      const runner = await getAdkRunner(this.config.runner);
      const runRequest = (
        this.config.requestConverter ?? convertA2aRequestToAgentRunRequest
      )(reqCtx, this.config.a2aPartConverter ?? toGenAIPart);
      const session = await getAdkSession(
        runRequest.userId,
        runRequest.sessionId,
        runner.sessionService,
        runner.appName,
      );
      executorContext = createExecutorContext({
        session,
        userContent: runRequest.newMessage,
        requestContext: reqCtx,
        a2aMetadata: getA2aRequestMetadata(reqCtx),
      });

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

      await this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        error,
        event: createTaskFailedEvent({
          taskId,
          contextId,
          error: new Error(`Agent run failed: ${error.message}`),
          metadata: executorContext
            ? getA2ASessionMetadata(executorContext)
            : undefined,
        }),
      });
    } finally {
      this.inFlightExecutions.delete(taskId);
    }
  }

  /**
   * Whether this request belongs to the new ADK A2A integration.
   *
   * The extension is activated only when a `newVersionExecutor` can serve it,
   * so the server never claims an extension it goes on to ignore.
   */
  private shouldUseNewVersion(ctx: RequestContext): boolean {
    if (this.config.useLegacy) {
      return false;
    }
    if (this.config.forceNewVersion) {
      return true;
    }

    return (
      this.config.newVersionExecutor !== undefined &&
      activateNewVersionExtension(ctx)
    );
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
        metadata: getA2ASessionMetadata(executorContext),
      }),
    );

    const aggregator = new TaskResultAggregator();
    const adkEvents: AdkEvent[] = [];
    // Held per execution: two concurrent requests to one executor must not
    // append their streamed parts to each other's artifact.
    const partialArtifactIds = new Map<string | undefined, string>();
    let lastAdkEvent: AdkEvent | undefined;

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
      ...getA2ASessionMetadata(executorContext),
      ...(lastAdkEvent ? getLastEventMetadata(lastAdkEvent) : {}),
    };

    return this.publishFinalTaskStatus({
      executorContext,
      eventBus,
      event: await executeAfterAgentInterceptors(
        executorContext,
        this.buildFinalEvent({
          aggregator,
          adkEvents,
          executorContext,
          eventBus,
          finalMetadata,
        }),
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
      return getFinalTaskStatusUpdate(adkEvents, executorContext);
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

  private convertAdkEvent(
    adkEvent: AdkEvent,
    executorContext: ExecutorContext,
    partialArtifactIds: Map<string | undefined, string>,
  ): A2AEvent[] {
    const genAiPartConverter = this.config.genAiPartConverter ?? toA2APart;
    if (this.config.eventConverter) {
      return this.config.eventConverter(
        adkEvent,
        executorContext,
        genAiPartConverter,
      );
    }

    return convertAdkEventToArtifactUpdate(
      adkEvent,
      executorContext,
      genAiPartConverter,
      partialArtifactIds,
    );
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
    try {
      if (executorContext) {
        await this.config.afterExecuteCallback?.(executorContext, event, error);
      }
    } catch (e: unknown) {
      logger.error('Error in afterExecuteCallback:', e);
    }

    eventBus.publish(event);
  }
}

/**
 * Converts one ADK event into the streaming artifact update that carries its
 * parts, or into nothing when it carries none.
 *
 * `partialArtifactIds` holds the artifact each author is still streaming into,
 * so the chunks of one response append to one artifact. It belongs to a single
 * execution.
 */
function convertAdkEventToArtifactUpdate(
  adkEvent: AdkEvent,
  executorContext: ExecutorContext,
  genAiPartConverter: GenAIPartToA2APartConverter,
  partialArtifactIds: Map<string | undefined, string>,
): A2AEvent[] {
  const a2aParts = toA2AParts(
    adkEvent.content?.parts,
    adkEvent.longRunningToolIds,
    genAiPartConverter,
  );
  if (a2aParts.length === 0) {
    return [];
  }

  const artifactId = partialArtifactIds.get(adkEvent.author) ?? randomUUID();

  const a2aEvent = createTaskArtifactUpdateEvent({
    taskId: executorContext.requestContext.taskId,
    contextId: executorContext.requestContext.contextId,
    artifactId,
    parts: a2aParts,
    metadata: getA2AEventMetadata(adkEvent, executorContext),
    append: adkEvent.partial,
    lastChunk: !adkEvent.partial,
  });

  if (adkEvent.partial) {
    partialArtifactIds.set(adkEvent.author, artifactId);
  } else {
    partialArtifactIds.delete(adkEvent.author);
  }

  return [a2aEvent];
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
 * Gets or creates new ADK session.
 */
async function getAdkSession(
  userId: string,
  sessionId: string,
  sessionService: BaseSessionService,
  appName: string,
): Promise<Session> {
  const session = await sessionService.getSession({
    appName,
    userId,
    sessionId,
  });
  if (session) {
    return session;
  }

  return sessionService.createSession({
    appName,
    userId,
    sessionId,
  });
}

/**
 * Resolves the runner from the provided runner or runner config.
 */
async function getAdkRunner(
  runnerOrConfig: RunnerOrRunnerConfig,
): Promise<Runner> {
  if (typeof runnerOrConfig === 'function') {
    const result = await runnerOrConfig();

    return getAdkRunner(result);
  }

  if (isRunner(runnerOrConfig)) {
    return runnerOrConfig;
  }

  return new Runner(runnerOrConfig);
}
