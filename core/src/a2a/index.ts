/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@google/adk/a2a` subpath: the A2A surface only, without the full ADK barrel.
 * Also re-exported from `@google/adk`.
 */

export {TaskState} from './a2a_event.js';
export type {A2AEvent} from './a2a_event.js';
export {
  AGENT_CARD_PATH,
  DEFAULT_A2A_TIMEOUT_MS,
  RemoteA2AAgent,
  isRemoteA2AAgent,
} from './a2a_remote_agent.js';
export type {
  A2AStreamEventData,
  AfterA2ARequestCallback,
  BeforeA2ARequestCallback,
  RemoteA2AAgentConfig,
} from './a2a_remote_agent.js';
export {
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
  newIntegrationExtensionInterceptor,
} from './a2a_remote_agent_interceptors.js';
export type {
  A2ABeforeRequestResult,
  A2ACardRequestConfig,
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
  A2ARequestParameters,
} from './a2a_remote_agent_interceptors.js';
export {
  AgentCardResolutionError,
  getA2AAgentCard,
  isAgentCardResolutionError,
} from './agent_card.js';
export type {ResolveAgentCardOptions} from './agent_card.js';
export {A2AAgentExecutor} from './agent_executor.js';
export type {
  AdkEventToA2AEventsConverter,
  AfterEventCallback,
  AfterExecuteCallback,
  AgentExecutorConfig,
  BeforeExecuteCallback,
  RunnerOrRunnerConfig,
} from './agent_executor.js';
export {
  AdkDefaultRequestHandler,
  getA2aRequestMetadata,
  toA2a,
} from './agent_to_a2a.js';
export type {A2aUserBuilder, ToA2aOptions} from './agent_to_a2a.js';
export {bearerTokenUserBuilder} from './auth.js';
export type {
  A2AArtifactUpdateToEventConverter,
  A2AEventConverters,
  A2AMessageToEventConverter,
  A2AStatusUpdateToEventConverter,
  A2ATaskToEventConverter,
  A2AToAdkEventConverter,
} from './event_converter_utils.js';
export {
  resolveA2aAgentExecutorConfig,
  toA2AArtifactUpdateEventsFromArtifactMap,
} from './executor_config.js';
export type {
  A2aAgentExecutorConverterConfig,
  AdkEventToA2AEventsConverterImpl,
  ResolvedA2aAgentExecutorConfig,
} from './executor_config.js';
export type {ExecutorContext} from './executor_context.js';
export type {ExecuteInterceptor} from './executor_utils.js';
export {
  toA2APart,
  toGenAIContent,
  toGenAIPart,
} from './part_converter_utils.js';
export type {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
} from './part_converter_utils.js';
export {
  convertA2aRequestToAgentRunRequest,
  getUserId,
} from './request_converter_utils.js';
export type {
  A2ARequestToAgentRunRequestConverter,
  AgentRunRequest,
} from './request_converter_utils.js';
export {TaskResultAggregator} from './task_result_aggregator.js';
