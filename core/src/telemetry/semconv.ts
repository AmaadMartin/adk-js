/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTelemetry semantic-convention attribute keys shared by the span and
 * metric telemetry.
 *
 * These strings are a wire contract: a span attribute and a metric attribute
 * that name the same thing must spell it the same way, and adk-python emits
 * the same keys. One declaration keeps a copy from drifting and splitting a
 * dashboard series.
 */

/** Classification of a failure, e.g. an exception name or an HTTP status. */
export const ERROR_TYPE = 'error.type';

export const GEN_AI_AGENT_DESCRIPTION = 'gen_ai.agent.description';
export const GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
export const GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';
export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const GEN_AI_TOKEN_TYPE = 'gen_ai.token.type';
export const GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';
export const GEN_AI_TOOL_DESCRIPTION = 'gen_ai.tool.description';
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const GEN_AI_TOOL_TYPE = 'gen_ai.tool.type';

export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  'gen_ai.usage.cache_read.input_tokens';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_USAGE_REASONING_OUTPUT_TOKENS =
  'gen_ai.usage.reasoning.output_tokens';
