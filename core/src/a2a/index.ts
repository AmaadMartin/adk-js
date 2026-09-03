/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@google/adk/a2a` subpath: the A2A surface only, without the full ADK barrel.
 * Also re-exported from `@google/adk`.
 */

export {
  AGENT_CARD_PATH,
  DEFAULT_A2A_TIMEOUT_MS,
  RemoteA2AAgent,
} from './a2a_remote_agent.js';
export type {
  A2ARequestMetaProvider,
  A2AStreamEventData,
  AfterA2ARequestCallback,
  BeforeA2ARequestCallback,
  RemoteA2AAgentConfig,
} from './a2a_remote_agent.js';
export type {
  A2ACardRequestConfig,
  A2ACardRequestInterceptor,
  A2AParametersConfig,
  A2ARequestInterceptor,
} from './a2a_remote_agent_config.js';
export {
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
  newIntegrationExtensionInterceptor,
} from './a2a_remote_agent_interceptors.js';
export {getA2AAgentCard, resolveAgentCard} from './agent_card.js';
export type {ResolveAgentCardOptions} from './agent_card.js';
export {
  AgentCardResolutionError,
  agentCardRpcUrls,
  isAgentCardResolutionError,
  isLoopbackHost,
  isRemoteCardSource,
  validateAgentCard,
} from './agent_card_validation.js';
export {A2AAgentExecutor} from './agent_executor.js';
export type {
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
export type {ExecutorContext} from './executor_context.js';
export {toA2APart, toGenAIPart} from './part_converter_utils.js';
export type {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
} from './part_converter_utils.js';
