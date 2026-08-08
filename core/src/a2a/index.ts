/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The public surface of the ADK A2A module, reachable as `@google/adk/a2a`.
 *
 * Every name is re-exported explicitly rather than with `export *`: the
 * modules below also export `resolveAgentCard`, `buildAgentSkills` and
 * `createExecutorContext`, which are internal.
 */

export {AGENT_CARD_PATH, RemoteA2AAgent} from './a2a_remote_agent.js';
export type {
  A2AStreamEventData,
  AfterA2ARequestCallback,
  BeforeA2ARequestCallback,
  RemoteA2AAgentConfig,
} from './a2a_remote_agent.js';
export {getA2AAgentCard} from './agent_card.js';
export {A2AAgentExecutor} from './agent_executor.js';
export type {
  AfterEventCallback,
  AfterExecuteCallback,
  AgentExecutorConfig,
  BeforeExecuteCallback,
  RunnerOrRunnerConfig,
} from './agent_executor.js';
export {toA2a} from './agent_to_a2a.js';
export type {A2aUserBuilder, ToA2aOptions} from './agent_to_a2a.js';
export {bearerTokenUserBuilder} from './auth.js';
export type {ExecutorContext} from './executor_context.js';
