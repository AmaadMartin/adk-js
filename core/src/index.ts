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

// Also available as `@google/adk/a2a`, which does not evaluate the rest of
// this barrel.
export * from './a2a/index.js';
export {codeConfigSchema} from './agents/common_configs.js';
export type {CodeConfig} from './agents/common_configs.js';
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
  ContainerCodeExecutor,
  type ContainerCodeExecutorOptions,
} from './code_executors/container_code_executor.js';
export {
  UnsafeLocalCodeExecutor,
  type UnsafeLocalCodeExecutorOptions,
} from './code_executors/unsafe_local_code_executor.js';
export * from './common.js';
export {LocalEnvironment} from './environment/local_environment.js';
export type {LocalEnvironmentOptions} from './environment/local_environment.js';
export {
  getDeveloperInstructions,
  getToolsByAgentName,
} from './evaluation/app_details.js';
export type {AgentDetails, AppDetails} from './evaluation/app_details.js';
export {
  DEFAULT_EVAL_PARALLELISM,
  InferenceStatus,
} from './evaluation/base_eval_service.js';
export type {
  BaseEvalService,
  EvaluateConfig,
  EvaluateRequest,
  InferenceConfig,
  InferenceRequest,
  InferenceResult,
} from './evaluation/base_eval_service.js';
export {evalModel, optionalField} from './evaluation/common.js';
export type {
  EvalDumpOptions,
  EvalModel,
  EvalModelOptions,
  ExtraKeysPolicy,
} from './evaluation/common.js';
export {
  DEFAULT_LIVE_TIMEOUT_SECONDS,
  MISSING_EVAL_DEPENDENCIES_MESSAGE,
} from './evaluation/constants.js';
export {CustomMetricEvaluator} from './evaluation/custom_metric_evaluator.js';
export type {CustomMetricFunction} from './evaluation/custom_metric_evaluator.js';
export {
  getAllToolCalls,
  getAllToolCallsWithResponses,
  getAllToolResponses,
  isIntermediateData,
  isInvocationEvents,
  validateEvalCase,
} from './evaluation/eval_case.js';
export type {
  ConversationScenario,
  EvalCase,
  IntermediateData,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  InvocationEvents,
  SessionInput,
  SessionState,
  StaticConversation,
  ToolCallAndResponse,
} from './evaluation/eval_case.js';
export {
  DEFAULT_EVAL_CONFIG,
  getEvalMetricsFromConfig,
  getEvaluationCriteriaOrDefault,
  parseEvalConfig,
} from './evaluation/eval_config.js';
export type {
  Criterion,
  CustomMetricCodeConfig,
  CustomMetricConfig,
  EvalConfig,
  LiveModelConfig,
  UserSimulatorConfig,
} from './evaluation/eval_config.js';
export {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_NUM_SAMPLES,
  DEFAULT_JUDGE_PARALLELISM_LIMIT,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  EvalStatus,
  getConfigCustomFunctionPath,
  getMetricThreshold,
  normalizeToolTrajectoryMatchType,
  parseBaseCriterion,
  parseEvalMetric,
  parseEvalMetricResult,
  parseHallucinationsCriterion,
  parseInterval,
  parseJudgeModelOptions,
  parseLlmAsAJudgeCriterion,
  parseLlmBackedUserSimulatorCriterion,
  parseMetricInfo,
  parseMetricValueInfo,
  parseRubricsBasedCriterion,
  parseToolTrajectoryCriterion,
  PrebuiltMetrics,
  resolveJudgeModelOptions,
  setConfigCustomFunctionPath,
  ToolTrajectoryMatchType,
} from './evaluation/eval_metrics.js';
export type {
  BaseCriterion,
  EvalMetric,
  EvalMetricCriterion,
  EvalMetricResult,
  EvalMetricResultDetails,
  EvalMetricResultPerInvocation,
  HallucinationsCriterion,
  Interval,
  JudgeModelOptions,
  LlmAsAJudgeCriterion,
  LlmBackedUserSimulatorCriterion,
  MetricInfo,
  MetricInfoProvider,
  MetricValueInfo,
  ParsedLlmBackedUserSimulatorCriterion,
  ParsedRubricsBasedCriterion,
  ParsedToolTrajectoryCriterion,
  ResolvedJudgeModelOptions,
  RubricsBasedCriterion,
  Threshold,
  ToolTrajectoryCriterion,
} from './evaluation/eval_metrics.js';
export type {EvalCaseResult} from './evaluation/eval_result.js';
export {parseRubric, parseRubricScore} from './evaluation/eval_rubrics.js';
export type {
  Rubric,
  RubricContent,
  RubricScore,
} from './evaluation/eval_rubrics.js';
export {getEvalRuntime, setEvalRuntime} from './evaluation/eval_runtime.js';
export type {
  EvalRuntime,
  EvalServiceParams,
} from './evaluation/eval_runtime.js';
export type {EvalSet} from './evaluation/eval_set.js';
export type {
  EvalSetResult,
  EvalSetResultsManager,
} from './evaluation/eval_set_results_manager.js';
export type {EvalSetsManager} from './evaluation/eval_sets_manager.js';
export {
  BASE_CRITERION_TYPE,
  emptyEvaluationResult,
  getCriterionType,
  getEvalStatus,
  getTextFromContent,
  validateBaseCriterion,
  validateInvocationLengths,
} from './evaluation/evaluator.js';
export type {
  CriterionType,
  EvaluationResult,
  Evaluator,
  EvaluatorClass,
  PerInvocationResult,
} from './evaluation/evaluator.js';
export {RougeEvaluator} from './evaluation/final_response_match_v1.js';
export {InMemoryEvalSetsManager} from './evaluation/in_memory_eval_sets_manager.js';
export {
  createEvalSessionId,
  LocalEvalService,
} from './evaluation/local_eval_service.js';
export type {LocalEvalServiceOptions} from './evaluation/local_eval_service.js';
export {
  defaultMetricEvaluatorRegistry,
  MetricEvaluatorRegistry,
  registerCustomMetricsFromConfig,
} from './evaluation/metric_evaluator_registry.js';
export type {MetricEvaluatorFactory} from './evaluation/metric_evaluator_registry.js';
export {ResponseEvaluator} from './evaluation/response_evaluator.js';
export type {ResponseEvaluatorOptions} from './evaluation/response_evaluator.js';
export {rouge1Score, tokenizeForRouge} from './evaluation/rouge_scorer.js';
export type {RougeScore} from './evaluation/rouge_scorer.js';
export {
  DEFAULT_USER_SIMULATOR_AUDIO_MODEL,
  DEFAULT_USER_SIMULATOR_LANGUAGE_CODE,
  DEFAULT_USER_SIMULATOR_VOICE_NAME,
} from './evaluation/simulation/llm_audio_user_simulator.js';
export type {LlmAudioUserSimulatorConfig} from './evaluation/simulation/llm_audio_user_simulator.js';
export type {LlmBackedUserSimulatorConfig} from './evaluation/simulation/llm_backed_user_simulator.js';
export {StaticUserSimulator} from './evaluation/simulation/static_user_simulator.js';
export {
  DEFAULT_MAX_ALLOWED_INVOCATIONS,
  DEFAULT_USER_SIMULATOR_MODEL,
  DEFAULT_USER_SIMULATOR_THINKING_BUDGET,
  getRegisteredUserSimulator,
  parseBaseUserSimulatorConfig,
  registeredUserSimulatorTypes,
  registerUserSimulator,
  unregisterUserSimulator,
  UserSimulatorStatus,
  validateNextUserMessage,
} from './evaluation/simulation/user_simulator.js';
export type {
  BaseUserSimulatorConfig,
  NextUserMessage,
  UserSimulator,
  UserSimulatorFactory,
} from './evaluation/simulation/user_simulator.js';
export type {
  UserBehavior,
  UserPersona,
} from './evaluation/simulation/user_simulator_personas.js';
export {UserSimulatorProvider} from './evaluation/simulation/user_simulator_provider.js';
export {TrajectoryEvaluator} from './evaluation/trajectory_evaluator.js';
export type {TrajectoryEvaluatorOptions} from './evaluation/trajectory_evaluator.js';
export {
  MultiTurnVertexAiEvalFacade,
  resolveVertexAiEvalClientConfig,
  SingleTurnVertexAiEvalFacade,
  VertexAiEvalFacade,
} from './evaluation/vertex_ai_eval_facade.js';
export type {
  VertexAgentConfig,
  VertexAgentData,
  VertexAgentEvent,
  VertexAggregatedMetricResult,
  VertexAiEvalClient,
  VertexAiEvalClientConfig,
  VertexAiEvalFacadeOptions,
  VertexAiEvalRequest,
  VertexConversationTurn,
  VertexEvalCase,
  VertexEvalCaseRow,
  VertexEvalMetricSpec,
  VertexEvaluationDataset,
  VertexEvaluationResult,
} from './evaluation/vertex_ai_eval_facade.js';
export {VertexAiMemoryBankService} from './memory/vertex_ai_memory_bank_service.js';
export type {VertexAiMemoryBankServiceOptions} from './memory/vertex_ai_memory_bank_service.js';
export {VertexAiRagMemoryService} from './memory/vertex_ai_rag_memory_service.js';
export type {VertexAiRagMemoryServiceOptions} from './memory/vertex_ai_rag_memory_service.js';
export {
  extractSingleInvocationInfo,
  extractToolCallData,
  LocalEvalSampler,
} from './optimization/local_eval_sampler.js';
export type {
  CapturedEvalData,
  CapturedInvocation,
  CapturedMetricResult,
  InvocationInfo,
  LocalEvalSamplerConfig,
  LocalEvalSamplerOptions,
  LocalEvalSamplingResult,
  ToolCallData,
} from './optimization/local_eval_sampler.js';
export {DatabaseSessionService} from './sessions/database_session_service.js';
export {getSessionServiceFromUri} from './sessions/registry.js';
export {VertexAiSessionService} from './sessions/vertex_ai_session_service.js';
export type {
  VertexAiCreateSessionRequest,
  VertexAiSessionServiceOptions,
} from './sessions/vertex_ai_session_service.js';
export {GCPSkillRegistry} from './skills/gcp_skill_registry.js';
export type {GCPSkillRegistryOptions} from './skills/gcp_skill_registry.js';
export {
  loadAllSkillsInDir,
  loadSkillFromDir,
  loadSkillFromZipBuffer,
  validateSkillDir,
} from './skills/loader.js';
export {LOAD_WEB_PAGE, loadWebPage} from './tools/load_web_page.js';
export type {LoadWebPageOptions} from './tools/load_web_page.js';
export {OpenApiSpecParser} from './tools/openapi_tool/openapi_spec_parser/openapi_spec_parser.js';
export type {
  OperationEndpoint,
  ParsedOperation,
} from './tools/openapi_tool/openapi_spec_parser/openapi_spec_parser.js';
export {OperationParser} from './tools/openapi_tool/openapi_spec_parser/operation_parser.js';
export type {ApiParameter} from './tools/openapi_tool/openapi_spec_parser/operation_parser.js';
export {ToolAuthHandler} from './tools/openapi_tool/openapi_spec_parser/tool_auth_handler.js';
export type {AuthPreparationResult} from './tools/openapi_tool/openapi_spec_parser/tool_auth_handler.js';
export {OpenAPIToolset} from './tools/openapi_tool/openapi_toolset.js';
export {
  createRestApiTool,
  RestApiTool,
} from './tools/openapi_tool/rest_api_tool.js';
export {FilesRetrieval} from './tools/retrieval/files_retrieval.js';
export type {
  FilesRetrievalConstructorParams,
  FilesRetrievalParams,
} from './tools/retrieval/files_retrieval.js';
export {LoadSkillResourceTool} from './tools/skill/load_skill_resource_tool.js';
export {
  RunSkillInlineScriptErrorCode,
  RunSkillInlineScriptTool,
} from './tools/skill/run_skill_inline_script_tool.js';
export {RunSkillScriptTool} from './tools/skill/run_skill_script_tool.js';
export {SkillToolset} from './tools/skill/skill_toolset.js';

export * from './integrations/agent_registry/agent_registry.js';
export * from './telemetry/google_cloud.js';
export * from './telemetry/setup.js';
// Also available as `@google/adk/tools/mcp`, which does not evaluate the rest
// of this barrel.
export * from './tools/mcp/index.js';
