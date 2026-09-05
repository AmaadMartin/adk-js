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
  A2AEvent,
  createTask,
  createTaskFailedEvent,
  createTaskWorkingEvent,
  isTaskArtifactUpdateEvent,
} from './a2a_event.js';
import {
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
  getA2AEventMetadata,
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';
import {toGenAIContent} from './part_converter_utils.js';
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
export interface AgentExecutorConfig extends A2aAgentExecutorConverterConfig {
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
  private readonly converters: ResolvedA2aAgentExecutorConfig;

  constructor(private readonly config: AgentExecutorConfig) {
    this.converters = resolveA2aAgentExecutorConfig(config);
  }

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
    const genAIUserMessage = toGenAIContent(
      a2aUserMessage,
      this.converters.a2aPartConverter,
    );
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
          event: unansweredRequestEvent,
        });

        return;
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
      // One map per execution: two concurrent executions must not stream their
      // parts into each other's artifact.
      const agentsArtifacts = new Map<string, string>();
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

        for (const a2aEvent of this.convertAdkEvent(
          adkEvent,
          executorContext,
          agentsArtifacts,
        )) {
          a2aEvent.metadata = {
            ...a2aEvent.metadata,
            ...getA2AEventMetadata(adkEvent, executorContext),
          };

          await this.config.afterEventCallback?.(
            executorContext,
            adkEvent,
            isTaskArtifactUpdateEvent(a2aEvent) ? a2aEvent : undefined,
          );

          eventBus.publish(a2aEvent);
        }
      }

      await this.publishFinalTaskStatus({
        executorContext,
        eventBus,
        event: getFinalTaskStatusUpdate(adkEvents, executorContext),
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

  /**
   * Converts one ADK event with whichever event converter the config selects.
   *
   * `eventConverter` wins over `adkEventConverter`, so a config that sets both
   * gets the one that reads the executor context.
   */
  private convertAdkEvent(
    adkEvent: AdkEvent,
    executorContext: ExecutorContext,
    agentsArtifacts: Map<string, string>,
  ): A2AEvent[] {
    if (this.config.eventConverter) {
      return this.config.eventConverter(
        adkEvent,
        executorContext,
        this.converters.genAiPartConverter,
      );
    }

    return this.converters.adkEventConverter(
      adkEvent,
      agentsArtifacts,
      executorContext.requestContext.taskId,
      executorContext.requestContext.contextId,
      this.converters.genAiPartConverter,
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
