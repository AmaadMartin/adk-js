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
import {logger} from '../utils/logger.js';
import {
  createTask,
  createTaskFailedEvent,
  createTaskWorkingEvent,
} from './a2a_event.js';
import {
  getFinalTaskStatusUpdate,
  getTaskInputRequiredEvent,
} from './event_processor_utils.js';
import {
  A2AAgentExecutorConfig,
  resolveConverters,
  ResolvedConverters,
} from './executor_config.js';
import {createExecutorContext, ExecutorContext} from './executor_context.js';
import {
  runAfterAgentInterceptors,
  runAfterEventInterceptors,
  runBeforeAgentInterceptors,
} from './executor_interceptor_utils.js';
import {getA2ASessionMetadata} from './metadata_converter_utils.js';

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
 * Configuration for the Executor.
 */
export interface AgentExecutorConfig extends A2AAgentExecutorConfig {
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
  private readonly converters: ResolvedConverters;

  constructor(private readonly config: AgentExecutorConfig) {
    this.converters = resolveConverters(config);
  }

  async execute(
    ctx: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    // Runs outside the try block: a throwing hook must reach the caller
    // instead of being reported to the peer as a failed task.
    const reqCtx = await runBeforeAgentInterceptors(
      ctx,
      this.config.executeInterceptors,
    );
    const a2aUserMessage = reqCtx.userMessage;
    if (!a2aUserMessage) {
      throw new Error('message not provided');
    }

    const request = this.converters.requestConverter(
      reqCtx,
      this.converters.a2aPartConverter,
    );
    const adkRunner = await getAdkRunner(this.config.runner);
    const session = await getAdkSession(
      request.userId,
      request.sessionId,
      adkRunner.sessionService,
      adkRunner.appName,
    );
    const executorContext = createExecutorContext({
      session,
      userContent: request.newMessage,
      requestContext: reqCtx,
    });

    try {
      if (this.config.beforeExecuteCallback) {
        await this.config.beforeExecuteCallback(reqCtx);
      }

      if (reqCtx.task) {
        const inputRequiredEvent = getTaskInputRequiredEvent(
          reqCtx.task,
          request.newMessage,
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

      if (!reqCtx.task) {
        eventBus.publish(
          createTask({
            taskId: reqCtx.taskId,
            contextId: reqCtx.contextId,
            message: a2aUserMessage,
          }),
        );
      }

      eventBus.publish(
        createTaskWorkingEvent({
          taskId: reqCtx.taskId,
          contextId: reqCtx.contextId,
        }),
      );

      const adkEvents: AdkEvent[] = [];
      for await (const adkEvent of adkRunner.runAsync({
        ...request,
        runConfig: this.config.runConfig,
      })) {
        adkEvents.push(adkEvent);

        const a2aEvent = this.converters.eventConverter(
          adkEvent,
          executorContext,
          this.agentPartialArtifactIdsMap,
          this.converters.genAIPartConverter,
        );
        if (!a2aEvent) {
          continue;
        }

        await this.config.afterEventCallback?.(
          executorContext,
          adkEvent,
          a2aEvent,
        );

        const a2aEvents = await runAfterEventInterceptors(
          a2aEvent,
          executorContext,
          adkEvent,
          this.config.executeInterceptors,
        );
        for (const event of a2aEvents) {
          eventBus.publish(event);
        }
      }

      // `afterAgent` runs only on this path: a failed run and an
      // input-required return publish their terminal event unmodified.
      await this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        event: await runAfterAgentInterceptors(
          executorContext,
          getFinalTaskStatusUpdate(adkEvents, executorContext),
          this.config.executeInterceptors,
        ),
      });
    } catch (e: unknown) {
      const error = e as Error;

      await this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        error,
        event: createTaskFailedEvent({
          taskId: reqCtx.taskId,
          contextId: reqCtx.contextId,
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
