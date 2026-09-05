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
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {
  createTask,
  createTaskArtifactUpdateEvent,
  createTaskFailedEvent,
  createTaskWorkingEvent,
} from './a2a_event.js';
import {
  getFinalTaskStatusUpdate,
  getUnansweredRequestEvent,
} from './event_processor_utils.js';
import {createExecutorContext, ExecutorContext} from './executor_context.js';
import {
  getA2AEventMetadata,
  getInvocationMetadata,
} from './metadata_converter_utils.js';
import {toA2AParts, toGenAIContent} from './part_converter_utils.js';
import {getA2aRequestMetadata} from './request_metadata.js';

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
export interface AgentExecutorConfig {
  runner: RunnerOrRunnerConfig;
  runConfig?: RunConfig;
  beforeExecuteCallback?: BeforeExecuteCallback;
  afterEventCallback?: AfterEventCallback;
  afterExecuteCallback?: AfterExecuteCallback;
}

/**
 * AgentExecutor invokes an ADK agent and translates session events to A2A events.
 */
export class A2AAgentExecutor implements AgentExecutor {
  private agentPartialArtifactIdsMap: Record<string, string> = {};

  constructor(private readonly config: AgentExecutorConfig) {}

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const a2aUserMessage = ctx.userMessage;
    if (!a2aUserMessage) {
      throw new Error('message not provided');
    }

    const userId = `A2A_USER_${ctx.contextId}`;
    const sessionId = ctx.contextId;
    const genAIUserMessage = toGenAIContent(a2aUserMessage);
    const adkRunner = await getAdkRunner(this.config.runner);
    const session = await getAdkSession(
      userId,
      sessionId,
      adkRunner.sessionService,
      adkRunner.appName,
    );
    const a2aMetadata = getA2aRequestMetadata(ctx);
    const executorContext = createExecutorContext({
      session,
      userContent: genAIUserMessage,
      requestContext: ctx,
      a2aMetadata,
    });

    try {
      if (this.config.beforeExecuteCallback) {
        await this.config.beforeExecuteCallback(ctx, a2aMetadata);
      }

      const unansweredRequestEvent = getUnansweredRequestEvent({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        task: ctx.task,
        sessionEvents: session.events,
        genAIContent: genAIUserMessage,
      });
      if (unansweredRequestEvent) {
        await this.publishFinalTaskStatus({
          executorContext,
          eventBus,
          event: withInvocationMetadata(
            unansweredRequestEvent,
            executorContext,
          ),
        });

        return;
      }

      if (!ctx.task) {
        eventBus.publish(
          createTask({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            message: a2aUserMessage,
            metadata: getInvocationMetadata(executorContext),
          }),
        );
      }

      eventBus.publish(
        createTaskWorkingEvent({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          metadata: getInvocationMetadata(executorContext),
        }),
      );

      let errorStatusEvent: TaskStatusUpdateEvent | undefined;
      const adkEvents: AdkEvent[] = [];
      for await (const adkEvent of adkRunner.runAsync({
        userId,
        sessionId,
        newMessage: genAIUserMessage,
        // Marked remote so the run knows this message came from a peer rather
        // than from the operator: a human-in-the-loop gate is not answerable
        // over A2A unless the deployment opts in.
        runConfig: {
          ...this.config.runConfig,
          remoteDelivered: true,
          ...(a2aMetadata ? {a2aMetadata} : {}),
        },
      })) {
        adkEvents.push(adkEvent);

        // Reassigned rather than broken out of, so the last error wins.
        if (adkEvent.errorCode || adkEvent.errorMessage) {
          errorStatusEvent = createTaskFailedEvent({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            error: new Error(adkEvent.errorMessage || adkEvent.errorCode),
            metadata: getA2AEventMetadata(adkEvent, executorContext),
          });
        }

        const a2aEvent = this.convertAdkEventToA2AEvent(
          adkEvent,
          executorContext,
        );
        if (!a2aEvent) {
          continue;
        }

        await this.config.afterEventCallback?.(
          executorContext,
          adkEvent,
          a2aEvent,
        );

        eventBus.publish(a2aEvent);
      }

      await this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        event: withInvocationMetadata(
          errorStatusEvent ??
            getFinalTaskStatusUpdate(adkEvents, executorContext),
          executorContext,
        ),
      });
    } catch (e: unknown) {
      const error = e as Error;

      await this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        error,
        event: createTaskFailedEvent({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          error: new Error(`Agent run failed: ${error.message}`),
          metadata: getInvocationMetadata(executorContext),
        }),
      });
    }
  }

  // Task cancellation is not supported in this implementation yet.
  async cancelTask(_taskId: string): Promise<void> {
    throw new Error('Task cancellation is not supported yet.');
  }

  private convertAdkEventToA2AEvent(
    adkEvent: AdkEvent,
    executorContext: ExecutorContext,
  ): TaskArtifactUpdateEvent | undefined {
    const a2aParts = toA2AParts(
      adkEvent.content?.parts,
      adkEvent.longRunningToolIds,
    );
    if (a2aParts.length === 0) {
      return undefined;
    }

    const artifactId =
      this.agentPartialArtifactIdsMap[adkEvent.author!] || randomUUID();

    const a2aEvent = createTaskArtifactUpdateEvent({
      taskId: executorContext.requestContext.taskId,
      contextId: executorContext.requestContext.contextId,
      artifactId,
      parts: a2aParts,
      metadata: {
        ...getA2AEventMetadata(adkEvent, executorContext),
        ...getInvocationMetadata(executorContext),
      },
      append: adkEvent.partial,
      lastChunk: !adkEvent.partial,
    });

    if (adkEvent.partial) {
      this.agentPartialArtifactIdsMap[adkEvent.author!] = artifactId;
    } else {
      delete this.agentPartialArtifactIdsMap[adkEvent.author!];
    }

    return a2aEvent;
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
    executorContext: ExecutorContext;
    eventBus: ExecutionEventBus;
    event: TaskStatusUpdateEvent;
    error?: Error;
  }): Promise<void> {
    try {
      await this.config.afterExecuteCallback?.(executorContext, event, error);
    } catch (e: unknown) {
      logger.error('Error in afterExecuteCallback:', e);
    }

    eventBus.publish(event);
  }
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
 */
async function getAdkSession(
  userId: string,
  sessionId: string,
  sessionService: BaseSessionService,
  appName: string,
): Promise<Session> {
  const existing = await sessionService.getSession({
    appName,
    userId,
    sessionId,
    // Checking existence doesn't require event history.
    config: {numRecentEvents: 0},
  });
  if (!existing) {
    return sessionService.createSession({
      appName,
      userId,
      sessionId,
    });
  }

  // The pending human-in-the-loop scan reads the session history, which the
  // probe above deliberately did not load. `existing` covers a session deleted
  // between the two calls.
  return (
    (await sessionService.getSession({appName, userId, sessionId})) ?? existing
  );
}

/**
 * Resolves the runner from the provided runner or runner config.
 *
 * @param runnerOrConfig The runner, runner config, or factory for either.
 * @param fromFactory Whether this value came out of a factory, which decides
 *   which of the two error messages a bad value gets.
 * @throws {TypeError} If the value is neither a Runner nor a runner config.
 */
async function getAdkRunner(
  runnerOrConfig: RunnerOrRunnerConfig,
  fromFactory = false,
): Promise<Runner> {
  if (typeof runnerOrConfig === 'function') {
    return getAdkRunner(await runnerOrConfig(), true);
  }

  if (isRunner(runnerOrConfig)) {
    return runnerOrConfig;
  }

  if (!isRunnerConfig(runnerOrConfig)) {
    throw new TypeError(
      fromFactory
        ? `Runner factory must return a Runner instance, got ${describeType(runnerOrConfig)}`
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
