/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {RequestContext} from '@a2a-js/sdk/server';
import {Event as AdkEvent} from '../events/event.js';
import {A2AEvent} from './a2a_event.js';
import {
  AdkEventToA2AEventConverter,
  toA2AArtifactUpdateEvent,
} from './event_converter_utils.js';
import {ExecutorContext} from './executor_context.js';
import {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
  toA2APart,
  toGenAIPart,
} from './part_converter_utils.js';
import {
  A2ARequestToAgentRunRequestConverter,
  toAgentRunRequest,
} from './request_converter_utils.js';

/**
 * Hooks that observe or rewrite one A2A execution.
 *
 * Every hook is optional; an interceptor that omits one is skipped at that
 * point of the run.
 *
 * Each hook pairs with a callback on `AgentExecutorConfig` that only observes:
 * `beforeAgent` runs before `beforeExecuteCallback`, `afterEvent` runs after
 * `afterEventCallback`, and `afterAgent` runs before `afterExecuteCallback`.
 */
export interface ExecuteInterceptor {
  /**
   * Runs before the agent starts, with the incoming request context.
   *
   * The returned context is what the rest of the run uses, so a hook that only
   * inspects the request must return the context it was given. Interceptors
   * run in registration order and each hook sees the previous hook's return
   * value. A hook that throws propagates out of `execute`, and no task event
   * is published.
   */
  beforeAgent?: (requestContext: RequestContext) => Promise<RequestContext>;

  /**
   * Runs after an ADK event is converted, before the A2A event is published.
   *
   * Return one event to replace it, an array to publish several in order, or
   * `undefined` to drop it. Dropping the last remaining event ends the chain,
   * so later interceptors never see it. Interceptors run in registration
   * order, and each one is called once per event the previous one produced.
   */
  afterEvent?: (
    executorContext: ExecutorContext,
    a2aEvent: A2AEvent,
    adkEvent: AdkEvent,
  ) => Promise<A2AEvent | A2AEvent[] | undefined>;

  /**
   * Runs after the agent finishes, with the terminal status event.
   *
   * Interceptors run in **reverse** registration order, so the
   * last-registered hook runs first and each hook sees the previous one's
   * return value. The hook must return an event to publish. It does not run
   * when the agent fails or when the task returns early asking for input.
   */
  afterAgent?: (
    executorContext: ExecutorContext,
    finalEvent: TaskStatusUpdateEvent,
  ) => Promise<TaskStatusUpdateEvent>;
}

/**
 * The converters and interceptors an embedder can plug into the A2A executor.
 *
 * Every field is optional. An executor built without any of them behaves
 * exactly as one built with the built-in converters and no interceptors.
 */
export interface A2AAgentExecutorConfig {
  /** Converts one inbound A2A part. Defaults to `toGenAIPart`. */
  a2aPartConverter?: A2APartToGenAIPartConverter;
  /** Converts one outbound GenAI part. Defaults to `toA2APart`. */
  genAIPartConverter?: GenAIPartToA2APartConverter;
  /** Builds the ADK runner arguments. Defaults to `toAgentRunRequest`. */
  requestConverter?: A2ARequestToAgentRunRequestConverter;
  /** Converts one ADK event. Defaults to `toA2AArtifactUpdateEvent`. */
  eventConverter?: AdkEventToA2AEventConverter;
  /** Hooks that observe or rewrite the run, in registration order. */
  executeInterceptors?: ExecuteInterceptor[];
}

/**
 * A converter set with every slot filled.
 */
export type ResolvedConverters = Required<
  Omit<A2AAgentExecutorConfig, 'executeInterceptors'>
>;

/**
 * Fills every unset converter slot with its built-in implementation.
 */
export function resolveConverters(
  config: A2AAgentExecutorConfig,
): ResolvedConverters {
  return {
    a2aPartConverter: config.a2aPartConverter ?? toGenAIPart,
    genAIPartConverter: config.genAIPartConverter ?? toA2APart,
    requestConverter: config.requestConverter ?? toAgentRunRequest,
    eventConverter: config.eventConverter ?? toA2AArtifactUpdateEvent,
  };
}
