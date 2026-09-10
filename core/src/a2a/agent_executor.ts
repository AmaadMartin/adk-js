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
  getA2AInvocationMetadata,
} from './metadata_converter_utils.js';
import {
  GenAIPartToA2APartConverter,
  toA2AParts,
  toGenAIContent,
} from './part_converter_utils.js';
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
  /**
   * Converts one GenAI part to an A2A part. Defaults to `toA2APart`. A part it
   * converts to nothing is dropped from the published event.
   */
  genAiPartConverter?: GenAIPartToA2APartConverter;
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
            metadata: getA2AInvocationMetadata(executorContext),
          }),
        );
      }

      eventBus.publish(
        createTaskWorkingEvent({
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          metadata: getA2AInvocationMetadata(executorContext),
        }),
      );

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
        event: getFinalTaskStatusUpdate(
          adkEvents,
          executorContext,
          this.config.genAiPartConverter,
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
      this.config.genAiPartConverter,
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
        ...getA2AInvocationMetadata(executorContext),
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
    const finalEvent = {
      ...event,
      metadata: {
        ...event.metadata,
        ...getA2AInvocationMetadata(executorContext),
      },
    };

    try {
      await this.config.afterExecuteCallback?.(
        executorContext,
        finalEvent,
        error,
      );
    } catch (e: unknown) {
      logger.error('Error in afterExecuteCallback:', e);
    }

    eventBus.publish(finalEvent);
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
  // Fetched with its full event history, unlike adk-python's
  // `_resolve_session`, which passes `num_recent_events=0` because it only
  // probes for existence. These events feed `getUnansweredRequestEvent`, which
  // decides whether a pending human-in-the-loop request is still open. Asking
  // for no events would blind that gate: VertexAiSessionService returns an
  // event-less session for `numRecentEvents: 0`.
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
 *
 * Takes `unknown` because the value is unvalidated: a JavaScript caller is not
 * bound by `RunnerOrRunnerConfig`, and a factory can return anything whatever
 * its declared return type says.
 *
 * @param runnerOrConfig - A runner, a runner config, or a factory for either.
 * @param fromFactory - Whether a factory produced this value, which selects the
 *   error message.
 * @returns The resolved runner.
 * @throws {TypeError} If the value is neither a runner nor a runner config.
 */
async function getAdkRunner(
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
    const got = runnerOrConfig === null ? 'null' : typeof runnerOrConfig;
    throw new TypeError(
      fromFactory
        ? `Runner factory must return a Runner instance, got ${got}`
        : `Runner must be a Runner instance or a callable that returns a Runner, got ${got}`,
    );
  }

  return new Runner(runnerOrConfig);
}

/**
 * Whether the value can be handed to the `Runner` constructor.
 *
 * Tests for `sessionService`, the one property `RunnerConfig` requires. Kept
 * unexported because the executor is the only caller that accepts this union.
 */
function isRunnerConfig(value: unknown): value is RunnerConfig {
  return (
    typeof value === 'object' && value !== null && 'sessionService' in value
  );
}
