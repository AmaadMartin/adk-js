/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {installNodeLogger} from './utils/logger_node.js';

// The Node entry point installs the winston-backed logger. `utils/logger.ts`
// itself must stay free of Node-only imports so that the browser entry point
// can reach it; see https://github.com/google/adk-js/issues/611.
// This call runs after the modules re-exported below are evaluated, so a module
// must log through the `logger` facade instead of holding the result of
// `getLogger()`.
installNodeLogger();

export {AGENT_CARD_PATH, RemoteA2AAgent} from './a2a/a2a_remote_agent.js';
export type {
  A2AStreamEventData,
  AfterA2ARequestCallback,
  BeforeA2ARequestCallback,
  RemoteA2AAgentConfig,
} from './a2a/a2a_remote_agent.js';
export {getA2AAgentCard} from './a2a/agent_card.js';
export {A2AAgentExecutor} from './a2a/agent_executor.js';
export type {
  AfterEventCallback,
  AfterExecuteCallback,
  AgentExecutorConfig,
  BeforeExecuteCallback,
  OnTaskPauseCallback,
  OnTaskResumeCallback,
  RunnerOrRunnerConfig,
} from './a2a/agent_executor.js';
export {toA2a} from './a2a/agent_to_a2a.js';
export type {A2aUserBuilder, ToA2aOptions} from './a2a/agent_to_a2a.js';
export {bearerTokenUserBuilder} from './a2a/auth.js';
export type {ExecutorContext} from './a2a/executor_context.js';
export {
  detectContextMutation,
  freezeIntent,
  IntentMismatchReason,
  verifyIntent,
} from './a2a/intent_binding.js';
export type {
  ContextMutation,
  IntentBinding,
  IntentVerification,
  PendingAction,
} from './a2a/intent_binding.js';
export {InvocationContext} from './agents/invocation_context.js';
export type {WorkflowInstructionScope} from './agents/invocation_context.js';
export {FileArtifactService} from './artifacts/file_artifact_service.js';
export {GcsArtifactService} from './artifacts/gcs_artifact_service.js';
export {getArtifactServiceFromUri} from './artifacts/registry.js';
export {
  AgentEngineSandboxCodeExecutor,
  type AgentEngineSandboxCodeExecutorOptions,
} from './code_executors/agent_engine_sandbox_code_executor.js';
export {CodeExecutionLanguage} from './code_executors/code_execution_utils.js';
export {
  UnsafeLocalCodeExecutor,
  type UnsafeLocalCodeExecutorOptions,
} from './code_executors/unsafe_local_code_executor.js';
export {
  VertexAiCodeExecutor,
  type CodeInterpreterExecuteResponse,
  type CodeInterpreterExtension,
  type VertexAiCodeExecutorOptions,
} from './code_executors/vertex_ai_code_executor.js';
export * from './common.js';
export {DaytonaEnvironment} from './environment/daytona_environment.js';
export type {DaytonaEnvironmentOptions} from './environment/daytona_environment.js';
export {LocalEnvironment} from './environment/local_environment.js';
export type {LocalEnvironmentOptions} from './environment/local_environment.js';
export {
  SecretManagerClient,
  type SecretManagerClientOptions,
} from './integrations/secret_manager/secret_client.js';
export {DatabaseSessionService} from './sessions/database_session_service.js';
export {upgradeSessionDatabaseSchema} from './sessions/db/schema_version.js';
export {getSessionServiceFromUri} from './sessions/registry.js';
export {VertexAiSessionService} from './sessions/vertex_ai_session_service.js';
export type {
  VertexAiCreateSessionRequest,
  VertexAiSessionServiceOptions,
} from './sessions/vertex_ai_session_service.js';
export {
  loadAllSkillsInDir,
  loadSkillFromDir,
  validateSkillDir,
} from './skills/loader.js';
export {
  RunSkillInlineScriptErrorCode,
  RunSkillInlineScriptTool,
} from './tools/skill/run_skill_inline_script_tool.js';
export {
  RunSkillScriptErrorCode,
  RunSkillScriptTool,
} from './tools/skill/run_skill_script_tool.js';
export {ToolboxToolset} from './tools/toolbox_toolset.js';
export type {
  ToolboxAuthTokenGetter,
  ToolboxToolsetOptions,
} from './tools/toolbox_toolset.js';

export * from './integrations/agent_registry/agent_registry.js';
export {CrewaiTool} from './integrations/crewai/crewai_tool.js';
export type {
  CrewaiBaseTool,
  CrewaiToolOptions,
} from './integrations/crewai/crewai_tool.js';
export * from './telemetry/google_cloud.js';
export * from './telemetry/setup.js';
export {toMcpServer} from './tools/mcp/agent_to_mcp.js';
export type {ToMcpServerOptions} from './tools/mcp/agent_to_mcp.js';
export * from './tools/mcp/load_mcp_resource_tool.js';
export * from './tools/mcp/mcp_session_manager.js';
export * from './tools/mcp/mcp_tool.js';
export * from './tools/mcp/mcp_toolset.js';
