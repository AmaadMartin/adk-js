/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Also available as `@google/adk/a2a`, which does not evaluate the rest of
// this barrel.
export * from './a2a/index.js';
// Resolving a config document imports the modules it names, so this half of
// the declarative config layer is Node-only and stays out of `common.ts`.
export {
  llmAgentFromConfig,
  resolveCallbacks,
  resolveTools,
} from './agents/config_agent_utils.js';
export type {CallbackFunction} from './agents/config_agent_utils.js';
export {InvocationContext} from './agents/invocation_context.js';
export type {WorkflowInstructionScope} from './agents/invocation_context.js';
// Node-only: the checkpointer thread id is a `node:crypto` digest, and the web
// bundle aliases `node:crypto` to a shim that provides only `randomUUID`. So
// this barrel and not `common.ts`, which `index_web.ts` re-exports wholesale.
export {LangGraphAgent, isLangGraphAgent} from './agents/langgraph_agent.js';
export type {
  CompiledLangGraph,
  LangGraphAgentConfig,
  LangGraphThreadConfig,
} from './agents/langgraph_agent.js';
export {mcpInstructionProvider} from './agents/mcp_instruction_provider.js';
export {FileArtifactService} from './artifacts/file_artifact_service.js';
export {
  GcsArtifactService,
  type GetSignedUrlRequest,
} from './artifacts/gcs_artifact_service.js';
export {getArtifactServiceFromUri} from './artifacts/registry.js';
export {
  AgentEngineSandboxCodeExecutor,
  type AgentEngineSandboxCodeExecutorOptions,
} from './code_executors/agent_engine_sandbox_code_executor.js';
export {CodeExecutionLanguage} from './code_executors/code_execution_utils.js';
export type {
  CodeInterpreterExecuteParams,
  CodeInterpreterExecuteResponse,
  CodeInterpreterExtensionClient,
  CodeInterpreterFile,
} from './code_executors/code_interpreter_extension_client.js';
export {
  ContainerCodeExecutor,
  type ContainerCodeExecutorOptions,
} from './code_executors/container_code_executor.js';
export {
  UnsafeLocalCodeExecutor,
  type UnsafeLocalCodeExecutorOptions,
} from './code_executors/unsafe_local_code_executor.js';
export {
  VertexAiCodeExecutor,
  type VertexAiCodeExecutorOptions,
} from './code_executors/vertex_ai_code_executor.js';
export * from './common.js';
export {LocalEnvironment} from './environment/local_environment.js';
export type {LocalEnvironmentOptions} from './environment/local_environment.js';
// Node-only: the local managers read and write files, and the GCS managers
// load the `@google-cloud/storage` client. So this barrel and not
// `common.ts`, which `index_web.ts` re-exports wholesale.
export {createGcsEvalManagersFromUri} from './evaluation/eval_managers.js';
export type {EvalManagers} from './evaluation/eval_managers.js';
export {GcsEvalSetResultsManager} from './evaluation/gcs_eval_set_results_manager.js';
export {GcsEvalSetsManager} from './evaluation/gcs_eval_sets_manager.js';
export {LocalEvalSetResultsManager} from './evaluation/local_eval_set_results_manager.js';
export {
  LocalEvalSetsManager,
  loadEvalSetFromFile,
} from './evaluation/local_eval_sets_manager.js';
export {VertexAiExampleStore} from './examples/vertex_ai_example_store.js';
export {SandboxClient} from './integrations/vmaas/sandbox_client.js';
export type {
  CdpBatchResult,
  CdpCommand,
  SandboxClientOptions,
  SandboxCommandSender,
  SandboxJson,
  SandboxScrollDirection,
} from './integrations/vmaas/sandbox_client.js';
export {AgentEngineSandboxComputer} from './integrations/vmaas/sandbox_computer.js';
export type {
  AccessTokenProvider,
  AgentEngineSandboxApi,
  AgentEngineSandboxComputerOptions,
} from './integrations/vmaas/sandbox_computer.js';
export {
  SandboxError,
  SandboxErrorCode,
  isSandboxError,
} from './integrations/vmaas/sandbox_errors.js';
export {getMemoryServiceFromUri} from './memory/registry.js';
export {BigQueryAgentAnalyticsPlugin} from './plugins/bigquery_agent_analytics_plugin.js';
export type {
  AnalyticsContentFormatter,
  AnalyticsRetryConfig,
  BigQueryAgentAnalyticsPluginOptions,
  BigQueryCredentials,
  BigQueryLoggerConfig,
} from './plugins/bigquery_analytics_config.js';
export {AnalyticsEventType} from './plugins/bigquery_analytics_schema.js';
export {AnalyticsDropReason} from './plugins/bigquery_analytics_writer.js';
export {
  DEFAULT_DEBUG_OUTPUT_PATH,
  DebugEntryType,
  DebugLoggingPlugin,
  type DebugLoggingPluginOptions,
} from './plugins/debug_logging_plugin.js';
export {DatabaseSessionService} from './sessions/database_session_service.js';
export {ENTITIES as SESSION_STORAGE_ENTITIES} from './sessions/db/schema.js';
// Also available as `@google/adk/sessions/migration`, which does not evaluate
// the rest of this barrel. It stays out of `common.ts`, whose exports reach
// the browser bundle through `index_web.ts`.
export {migrate} from './sessions/migration/migrate_from_sqlalchemy_pickle.js';
export type {MigrateOptions} from './sessions/migration/migrate_from_sqlalchemy_pickle.js';
export {getSessionServiceFromUri} from './sessions/registry.js';
export {SqliteSessionService} from './sessions/sqlite_session_service.js';
export type {GetUserStateRequest} from './sessions/sqlite_session_service.js';
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
// The API Hub tools use Node-only APIs (`google-auth-library`, `Buffer`,
// `node:https`), so they are exported here and not from the browser barrel
// `common.ts`.
export {APIHubToolset} from './tools/apihub_tool/apihub_toolset.js';
export type {APIHubToolsetOptions} from './tools/apihub_tool/apihub_toolset.js';
export {APIHubClient} from './tools/apihub_tool/clients/apihub_client.js';
export type {
  APIHubClientOptions,
  ApiHubApi,
  ApiHubApiVersion,
  BaseAPIHubClient,
} from './tools/apihub_tool/clients/apihub_client.js';
// The Application Integration clients reach 'google-auth-library' through
// ApiTransport, which is Node only, so they are exported here and not from the
// browser barrel 'common.ts'.
export {
  SqliteSpanExporter,
  type SqliteSpanExporterOptions,
} from './telemetry/sqlite_span_exporter.js';
export {ConnectionsClient} from './tools/application_integration_tool/clients/connections_client.js';
export type {
  ActionSchema,
  ConnectionDetails,
  ConnectionsClientOptions,
  EntitySchemaAndOperations,
} from './tools/application_integration_tool/clients/connections_client.js';
export {
  ENTITY_OPERATIONS,
  actionRequest,
  actionResponse,
  convertJsonSchemaToOpenApiSchema,
  executeCustomQueryRequest,
  getActionOperation,
  getConnectorBaseSpec,
} from './tools/application_integration_tool/clients/connector_spec_builders.js';
export type {
  ConnectorOperationExtensions,
  ConnectorPathItem,
  ConnectorSpec,
  EntityOperationBuilder,
  EntityOperationContext,
} from './tools/application_integration_tool/clients/connector_spec_builders.js';
export {IntegrationClient} from './tools/application_integration_tool/clients/integration_client.js';
export type {IntegrationClientOptions} from './tools/application_integration_tool/clients/integration_client.js';
export {GoogleApiToolset} from './tools/google_api_tool/google_api_toolset.js';
export type {
  GoogleApiToolsetOptions,
  GoogleApiToolsetPresetOptions,
} from './tools/google_api_tool/google_api_toolset.js';
export {
  BigQueryToolset,
  CalendarToolset,
  DocsToolset,
  GmailToolset,
  SheetsToolset,
  SlidesToolset,
  YoutubeToolset,
} from './tools/google_api_tool/google_api_toolsets.js';
export {
  GoogleApiToOpenApiConverter,
  convertDiscoveryDocument,
} from './tools/google_api_tool/googleapi_to_openapi_converter.js';
export {loadTextChunks} from './tools/retrieval/document_loader.js';
export {FilesRetrieval} from './tools/retrieval/files_retrieval.js';
export type {FilesRetrievalOptions} from './tools/retrieval/files_retrieval.js';
export {
  RunSkillInlineScriptErrorCode,
  RunSkillInlineScriptTool,
} from './tools/skill/run_skill_inline_script_tool.js';
export {RunSkillScriptTool} from './tools/skill/run_skill_script_tool.js';
export {ToolboxToolset} from './tools/toolbox_toolset.js';
export type {
  ToolboxAuthTokenGetter,
  ToolboxHeaderValue,
  ToolboxToolsetOptions,
} from './tools/toolbox_toolset.js';

export * from './integrations/agent_identity/index.js';
export * from './integrations/agent_registry/agent_registry.js';
export * from './integrations/api_registry/api_registry.js';
// Exported here rather than from `common.ts`, which also feeds the web build:
// the Firestore client is Node-only.
export * from './integrations/firestore/firestore_session_service.js';
export * from './integrations/langchain/langchain_tool.js';
export * from './integrations/parameter_manager/parameter_client.js';
export * from './integrations/secret_manager/secret_client.js';
// Exported here rather than from `common.ts`, which also feeds the web build:
// these tools reach the network through `google-auth-library`.
export * from './telemetry/google_cloud.js';
// Exported here rather than from `common.ts`, which also feeds the web build:
// the executor spawns the Cloud Run guest sandbox binary.
export {
  CloudRunSandboxCodeExecutor,
  type CloudRunSandboxCodeExecutorOptions,
} from './integrations/cloud_run/cloud_run_sandbox_code_executor.js';
export * from './telemetry/setup.js';
// Also available as `@google/adk/tools/bigtable`, which does not evaluate the
// rest of this barrel.
export * from './tools/bigtable/index.js';
export * from './tools/data_agent/index.js';
// Also available as `@google/adk/tools/mcp`, which does not evaluate the rest
// of this barrel.
export * from './tools/mcp/index.js';
// The Spanner tools are deliberately NOT re-exported here. They reach
// `@google-cloud/spanner` through a literal `import()`, which a bundler
// follows, and that peer adds about 5 MB to every bundle. Import them from
// `@google/adk/tools/spanner`, which nothing else in this barrel reaches.
