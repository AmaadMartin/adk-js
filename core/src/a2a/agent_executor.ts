/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import type {RunConfig} from '../agents/run_config.js';
import type {Event as AdkEvent} from '../events/event.js';
import type {RunnerConfig} from '../runner/runner.js';
import {isRunner, Runner} from '../runner/runner.js';
import type {BaseSessionService} from '../sessions/base_session_service.js';
import type {Session} from '../sessions/session.js';
import {logger} from '../utils/logger.js';
import {newUuid} from '../utils/uuid.js';
import {
  createTask,
  createTaskArtifactUpdateEvent,
  createTaskFailedEvent,
  createTaskWorkingEvent,
  isPausedTaskStatusUpdateEvent,
} from './a2a_event.js';
import {
  getFinalTaskStatusUpdate,
  getTaskInputRequiredEvent,
} from './event_processor_utils.js';
import type {ExecutorContext} from './executor_context.js';
import {createExecutorContext} from './executor_context.js';
import type {IntentVerification} from './intent_binding.js';
import {
  detectContextMutation,
  freezeIntent,
  verifyIntent,
} from './intent_binding.js';
import {
  getA2AEventMetadata,
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';
import {toA2AParts, toGenAIContent} from './part_converter_utils.js';
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
export type BeforeExecuteCallback = (reqCtx: RequestContext) => Promise<void>;

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
 * Callback called when the executor pauses a task to wait for a human.
 */
export type OnTaskPauseCallback = (
  ctx: ExecutorContext,
  pauseEvent: TaskStatusUpdateEvent,
) => Promise<void>;

/**
 * Callback called when the executor resumes a paused task, after verification.
 *
 * The frozen action and the pause-time context mutation are on `ctx`.
 */
export type OnTaskResumeCallback = (
  ctx: ExecutorContext,
  verification: IntentVerification,
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
  onTaskPauseCallback?: OnTaskPauseCallback;
  onTaskResumeCallback?: OnTaskResumeCallback;
  /**
   * Fail a resume whose incoming message does not match the action frozen when
   * the task paused, instead of running the agent. Defaults to `false` because
   * a resume message carrying extra parts alongside the approval is existing
   * supported traffic.
   */
  verifyResumeIntent?: boolean;
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
    const executorContext = createExecutorContext({
      session,
      userContent: genAIUserMessage,
      requestContext: ctx,
    });

    try {
      if (this.config.beforeExecuteCallback) {
        await this.config.beforeExecuteCallback(ctx);
      }

      if (ctx.task && isPausedTaskStatusUpdateEvent(ctx.task)) {
        const rejected = await this.rejectUnboundResume({
          task: ctx.task,
          executorContext,
          eventBus,
        });
        if (rejected) {
          return;
        }
      }

      if (ctx.task) {
        const inputRequiredEvent = getTaskInputRequiredEvent(
          ctx.task,
          genAIUserMessage,
        );
        if (inputRequiredEvent) {
          await this.publishFinalTaskStatus({
            executorContext,
            eventBus,
            event: inputRequiredEvent,
          });

          return;
        }
      }

      if (!ctx.task) {
        eventBus.publish(
          createTask({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            message: a2aUserMessage,
          }),
        );
      }

      eventBus.publish(
        createTaskWorkingEvent({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
        }),
      );

      const adkEvents: AdkEvent[] = [];
      const taskResultAggregator = new TaskResultAggregator();
      for await (const adkEvent of adkRunner.runAsync({
        userId,
        sessionId,
        newMessage: genAIUserMessage,
        runConfig: this.config.runConfig,
      })) {
        adkEvents.push(adkEvent);

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

        // simplicity: convertAdkEventToA2AEvent emits only artifact updates, so
        // the aggregator records nothing until that converter also emits the
        // intermediate auth-required / input-required status updates.
        taskResultAggregator.processEvent(a2aEvent);
        eventBus.publish(a2aEvent);
      }

      await this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        event: taskResultAggregator.resolveFinalStatus(
          getFinalTaskStatusUpdate(adkEvents, executorContext),
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
          metadata: getA2ASessionMetadata(executorContext),
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
      this.agentPartialArtifactIdsMap[adkEvent.author!] || newUuid();

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

    return a2aEvent;
  }

  /**
   * Binds a resume request to the action frozen when the task paused, and
   * records the outcome on the executor context.
   *
   * @returns `true` when the resume was rejected and the agent must not run.
   */
  private async rejectUnboundResume({
    task,
    executorContext,
    eventBus,
  }: {
    task: Task;
    executorContext: ExecutorContext;
    eventBus: ExecutionEventBus;
  }): Promise<boolean> {
    const userMessage = executorContext.requestContext.userMessage;
    executorContext.contextMutation = detectContextMutation(task, userMessage);

    // The frozen intent comes from the status message the server authored when
    // it paused, never from the incoming message, which the caller controls.
    const binding = freezeIntent(task);
    if (!binding) {
      return false;
    }
    executorContext.pausedIntent = binding;

    const verification = verifyIntent({
      binding,
      userMessage,
      strict: this.config.verifyResumeIntent,
    });

    try {
      await this.config.onTaskResumeCallback?.(executorContext, verification);
    } catch (e: unknown) {
      logger.error('Error in onTaskResumeCallback:', e);
    }

    if (verification.ok || !this.config.verifyResumeIntent) {
      return false;
    }

    await this.publishFinalTaskStatus({
      executorContext,
      eventBus,
      event: createTaskFailedEvent({
        taskId: task.id,
        contextId: task.contextId,
        error: new Error(
          `Resume rejected: ${verification.reason} (${verification.detail})`,
        ),
        metadata: getA2ASessionMetadata(executorContext),
      }),
    });

    return true;
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
    if (isPausedTaskStatusUpdateEvent(event)) {
      try {
        await this.config.onTaskPauseCallback?.(executorContext, event);
      } catch (e: unknown) {
        logger.error('Error in onTaskPauseCallback:', e);
      }
    }

    try {
      await this.config.afterExecuteCallback?.(executorContext, event, error);
    } catch (e: unknown) {
      logger.error('Error in afterExecuteCallback:', e);
    }

    eventBus.publish(event);
  }
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
