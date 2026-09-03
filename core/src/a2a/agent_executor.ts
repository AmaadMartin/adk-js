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
 *
 * Returning an empty array publishes nothing for that ADK event.
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

  /** Converts one inbound A2A part. Defaults to `toGenAIPart`. */
  a2aPartConverter?: A2APartToGenAIPartConverter;

  /** Converts one outbound GenAI part. Defaults to `toA2APart`. */
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
}

/**
 * The events that close out a run, in publication order.
 */
interface RunResultEvents {
  artifactUpdate?: TaskArtifactUpdateEvent;
  finalEvent: TaskStatusUpdateEvent;
}

/**
 * AgentExecutor invokes an ADK agent and translates session events to A2A events.
 */
export class A2AAgentExecutor implements AgentExecutor {
  private agentPartialArtifactIdsMap: Record<string, string> = {};

  /**
   * The context id each in-flight task runs under, so `cancelTask` can address
   * the right context from a task id alone. An entry lives for the duration of
   * one `execute` call.
   */
  private readonly contextIdsByTaskId = new Map<string, string>();

  constructor(private readonly config: AgentExecutorConfig) {}

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    // Validated before the failure guard below: a request with no message, task
    // id or context id names no task to report a failure against, so it has to
    // reject rather than publish one.
    requireRequestContext(ctx);

    const reqCtx = await executeBeforeAgentInterceptors(
      ctx,
      this.config.executeInterceptors,
    );
    const {taskId, contextId} = requireRequestContext(reqCtx);
    this.contextIdsByTaskId.set(taskId, contextId);

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

      await this.handleRequest(runner, runRequest, executorContext, eventBus);
    } catch (e: unknown) {
      const error = toError(e);
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
      this.contextIdsByTaskId.delete(taskId);
    }
  }

  /**
   * Publishes the terminal `canceled` status update the A2A cancellation
   * contract requires. The request handler drains the event bus until it sees a
   * terminal event, so a cancellation that publishes nothing never completes.
   *
   * The run itself keeps going: adk-js cannot abort an invocation in flight, so
   * the agent's own terminal event follows the cancellation.
   *
   * @throws {Error} When the task id is empty, or when this executor has no
   *   execution in flight for it.
   */
  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    if (!taskId) {
      throw new Error('A2A cancellation must have a task ID');
    }

    const contextId = this.contextIdsByTaskId.get(taskId);
    if (!contextId) {
      throw new Error(`No active A2A task ${taskId} to cancel`);
    }
    this.contextIdsByTaskId.delete(taskId);

    eventBus.publish(
      createFinalTaskStatusEvent({
        taskId,
        contextId,
        state: TaskState.CANCELED,
      }),
    );
  }

  private async handleRequest(
    runner: Runner,
    runRequest: AgentRunRequest,
    executorContext: ExecutorContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const ctx = executorContext.requestContext;
    const {taskId, contextId} = ctx;
    const a2aMetadata = executorContext.a2aMetadata;

    await this.config.beforeExecuteCallback?.(ctx, a2aMetadata);

    enqueueSubmittedSignal(ctx, eventBus);

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
    let lastAdkEvent: AdkEvent | undefined;

    for await (const adkEvent of runner.runAsync({
      userId: runRequest.userId,
      sessionId: executorContext.sessionId,
      newMessage: runRequest.newMessage,
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

      for (const converted of this.convertAdkEvent(adkEvent, executorContext)) {
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

    const {artifactUpdate, finalEvent} = buildRunResultEvents({
      aggregator,
      adkEvents,
      executorContext,
      finalMetadata: {
        ...getA2ASessionMetadata(executorContext),
        ...(lastAdkEvent ? getLastEventMetadata(lastAdkEvent) : {}),
      },
    });
    if (artifactUpdate) {
      eventBus.publish(artifactUpdate);
    }

    return this.publishFinalTaskStatus({
      executorContext,
      eventBus,
      event: await executeAfterAgentInterceptors(
        executorContext,
        finalEvent,
        this.config.executeInterceptors,
      ),
    });
  }

  private convertAdkEvent(
    adkEvent: AdkEvent,
    executorContext: ExecutorContext,
  ): A2AEvent[] {
    const genAiPartConverter = this.config.genAiPartConverter ?? toA2APart;
    if (this.config.eventConverter) {
      return this.config.eventConverter(
        adkEvent,
        executorContext,
        genAiPartConverter,
      );
    }

    return this.convertAdkEventToArtifactUpdate(
      adkEvent,
      executorContext,
      genAiPartConverter,
    );
  }

  private convertAdkEventToArtifactUpdate(
    adkEvent: AdkEvent,
    executorContext: ExecutorContext,
    genAiPartConverter: GenAIPartToA2APartConverter,
  ): A2AEvent[] {
    const a2aParts = toA2AParts(
      adkEvent.content?.parts,
      adkEvent.longRunningToolIds,
      genAiPartConverter,
    );
    if (a2aParts.length === 0) {
      return [];
    }

    const artifactId =
      this.agentPartialArtifactIdsMap[adkEvent.author!] || randomUUID();

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
      this.agentPartialArtifactIdsMap[adkEvent.author!] = artifactId;
    } else {
      delete this.agentPartialArtifactIdsMap[adkEvent.author!];
    }

    return [a2aEvent];
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
 * Decides how a finished run closes out.
 *
 * The aggregated state wins over anything the last event happened to say. A run
 * that nothing settled and that produced status message parts republishes those
 * parts as the final artifact, so a client that reads only artifacts still gets
 * the answer.
 */
function buildRunResultEvents({
  aggregator,
  adkEvents,
  executorContext,
  finalMetadata,
}: {
  aggregator: TaskResultAggregator;
  adkEvents: AdkEvent[];
  executorContext: ExecutorContext;
  finalMetadata: Record<string, unknown>;
}): RunResultEvents {
  const {taskId, contextId} = executorContext.requestContext;

  if (aggregator.taskState !== TaskState.WORKING) {
    return {
      finalEvent: createFinalTaskStatusEvent({
        taskId,
        contextId,
        state: aggregator.taskState,
        message: aggregator.taskStatusMessage,
        metadata: finalMetadata,
      }),
    };
  }

  const statusParts = aggregator.taskStatusMessage?.parts;
  if (!statusParts?.length) {
    return {finalEvent: getFinalTaskStatusUpdate(adkEvents, executorContext)};
  }

  return {
    artifactUpdate: createTaskArtifactUpdateEvent({
      taskId,
      contextId,
      parts: statusParts,
      metadata: finalMetadata,
      lastChunk: true,
    }),
    finalEvent: createTaskCompletedEvent({
      taskId,
      contextId,
      metadata: finalMetadata,
    }),
  };
}

/**
 * The invocation, author and event ids of the last ADK event a run produced, so
 * a client can tie the terminal event back to it. An absent value is left out
 * rather than written as `undefined`.
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
