/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import type {BaseAgent} from '../agents/base_agent.js';
import type {Context} from '../agents/context.js';
import type {InvocationContext} from '../agents/invocation_context.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import type {Event} from '../events/event.js';
import type {LlmRequest} from '../models/llm_request.js';
import type {LlmResponse} from '../models/llm_response.js';
import type {BaseTool} from '../tools/base_tool.js';
import {toSnakeCasePropertyName} from '../utils/case_utils.js';
import {logger} from '../utils/logger.js';
import {
  capturesCustomMetadata,
  CustomMetadataAllowlist,
  ResolvedConfig,
} from './bigquery_analytics_config.js';
import {
  ADK_ENVELOPE_SCHEMA_VERSION,
  AnalyticsNode,
  AnalyticsScopeKind,
  AnalyticsStatus,
  deriveScope,
  parseNodeRunIds,
} from './bigquery_analytics_schema.js';
import {ambientOtelIds} from './bigquery_analytics_spans.js';
import {
  extractToolDeclarations,
  getToolOrigin,
} from './bigquery_analytics_tools.js';

/**
 * Turns the values a runner callback carries into the `content`,
 * `attributes` and `latency_ms` a row is written from.
 *
 * The plugin decides which rows exist and when; this module decides what one
 * row says. Everything here is a free function over its arguments, so a shape
 * can be checked without a plugin, a BigQuery client or a runner.
 */

/**
 * Generation-config fields captured into `attributes.llm_config`.
 *
 * Which fields are captured is the wire contract with adk-python, so the list
 * stays explicit. The column name is not: every one is the snake_case of the
 * field, so `toSnakeCasePropertyName` derives it. Pair a field with a literal column
 * name here the day one of them stops being mechanical.
 */
const LOGGED_GENERATION_CONFIG_KEYS: ReadonlyArray<
  keyof GenerateContentConfig
> = [
  'temperature',
  'topP',
  'topK',
  'candidateCount',
  'maxOutputTokens',
  'stopSequences',
  'presencePenalty',
  'frequencyPenalty',
  'responseMimeType',
  'responseSchema',
  'seed',
  'responseLogprobs',
  'logprobs',
];

/** Structured fields one row carries beyond its content. */
export interface AnalyticsEventData {
  status?: AnalyticsStatus;
  errorMessage?: string;
  latencyMs?: number;
  timeToFirstTokenMs?: number;
  model?: string;
  modelVersion?: string;
  usageMetadata?: unknown;
  finishReason?: string;
  extraAttributes?: Record<string, unknown>;
  /** Extra keys merged into the row's `attributes.adk` envelope. */
  adk?: Record<string, unknown>;
  traceIdOverride?: string;
  spanIdOverride?: string;
  parentSpanIdOverride?: string;
  sourceEvent?: Event;
}

/** The agent's instruction, when it is a plain string. */
export function agentInstruction(agent: BaseAgent): string {
  return isLlmAgent(agent) && typeof agent.instruction === 'string'
    ? agent.instruction
    : '';
}

/**
 * The `content` of a tool row: the tool, this event's payload, and where the
 * call runs. Every tool row carries `tool_origin`, as adk-python's do.
 */
export function toolContent(
  params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  },
  payload: {args: Record<string, unknown>} | {result: Record<string, unknown>},
): Record<string, unknown> {
  return {
    tool: params.tool.name,
    ...payload,
    tool_origin: getToolOrigin(
      params.tool,
      params.toolArgs,
      params.toolContext.invocationContext.agent,
    ),
  };
}

/** Captures the generation config and request labels into row attributes. */
export function requestAttributes(
  llmRequest: LlmRequest,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  const config = llmRequest.config;
  if (config !== undefined) {
    const llmConfig: Record<string, unknown> = {};
    for (const field of LOGGED_GENERATION_CONFIG_KEYS) {
      const value = config[field];
      if (value !== undefined) {
        llmConfig[toSnakeCasePropertyName(field)] = value;
      }
    }
    if (Object.keys(llmConfig).length > 0) {
      attributes['llm_config'] = llmConfig;
    }
    if (config.labels !== undefined) {
      attributes['labels'] = config.labels;
    }
  }
  const tools = extractToolDeclarations(llmRequest.toolsDict);
  if (tools.length > 0) {
    attributes['tools'] = tools;
  }
  return attributes;
}

/** The token counts adk-python records under `content.usage`. */
export function usageCounts(
  llmResponse: LlmResponse,
): Record<string, number> | undefined {
  const usage = llmResponse.usageMetadata;
  if (usage === undefined) {
    return undefined;
  }
  return {
    prompt: usage.promptTokenCount ?? 0,
    completion: usage.candidatesTokenCount ?? 0,
    total: usage.totalTokenCount ?? 0,
  };
}

/** The `latency_ms` object, or null when neither measurement is available. */
export function buildLatency(
  data: AnalyticsEventData,
): Record<string, number> | null {
  const latency: Record<string, number> = {};
  if (data.latencyMs !== undefined) {
    latency['total_ms'] = data.latencyMs;
  }
  if (data.timeToFirstTokenMs !== undefined) {
    latency['time_to_first_token_ms'] = data.timeToFirstTokenMs;
  }
  return Object.keys(latency).length > 0 ? latency : null;
}

/**
 * The `attributes.adk` keys a paused call and its completion share, so one
 * query pairs them on `function_call_id`.
 */
export function pauseKeys(
  pauseKind: string,
  functionCallId: string | undefined,
): Record<string, unknown> {
  return {pause_kind: pauseKind, function_call_id: functionCallId ?? null};
}

/** Whether `key` matches the allowlist in full or by one of its prefixes. */
function isAllowedMetadataKey(
  allowlist: CustomMetadataAllowlist,
  key: string,
): boolean {
  return (
    allowlist.exact.has(key) ||
    allowlist.prefixes.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * The allowlisted `customMetadata` entries of the row's source event, or
 * undefined when there is nothing to capture.
 *
 * The captured object is merged into `attributes`, so it takes the same
 * truncation, redaction and cycle handling as every other captured value and
 * a truncated entry flips the row's `is_truncated`.
 *
 * @param allowlist The keys and prefixes the caller asked for.
 * @param event The session event the row came from, when there was one.
 * @return The captured entries, or undefined when none matched.
 */
function capturedCustomMetadata(
  allowlist: CustomMetadataAllowlist,
  event: Event | undefined,
): Record<string, unknown> | undefined {
  const metadata = event?.customMetadata;
  if (metadata === undefined || !capturesCustomMetadata(allowlist)) {
    return undefined;
  }
  const captured: Record<string, unknown> = Object.fromEntries(
    Object.entries(metadata).filter(([key]) =>
      isAllowedMetadataKey(allowlist, key),
    ),
  );
  return Object.keys(captured).length > 0 ? captured : undefined;
}

/** The `attributes.adk.node` object for an event, or null when it has none. */
function nodeOf(event: Event): AnalyticsNode | null {
  const path = event.nodeInfo?.path;
  if (path === undefined) {
    return null;
  }
  return {path, ...parseNodeRunIds(path)};
}

/**
 * Builds the `attributes.adk` envelope.
 *
 * Every row carries the envelope version and the application name, so a
 * consumer can gate on either without inspecting the row's type. The keys that
 * describe a session event are written only when the row came from one: an
 * omitted key reads as SQL NULL through `JSON_VALUE`, where an explicit null
 * would claim the event had no branch rather than that there was no event.
 *
 * @param invocationContext The invocation the row belongs to.
 * @param event The session event the row came from, when there was one.
 * @return The envelope object.
 */
function buildAdkEnvelope(
  invocationContext: InvocationContext,
  event: Event | undefined,
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    schema_version: ADK_ENVELOPE_SCHEMA_VERSION,
    app_name: invocationContext.appName,
  };
  if (event === undefined) {
    return envelope;
  }
  envelope['source_event_id'] = event.id;
  envelope['node'] = nodeOf(event);
  envelope['branch'] = event.branch ?? null;
  const scope = deriveScope(event.isolationScope);
  if (scope?.kind === AnalyticsScopeKind.UNKNOWN) {
    // The value is left out of the message because a rehydrated event supplies
    // it from storage.
    logger.warn(
      'BigQuery analytics found an isolation scope it cannot classify; writing it with kind "unknown".',
    );
  }
  envelope['scope'] = scope;
  if (event.route !== undefined) {
    envelope['route'] = event.route;
  }
  return envelope;
}

/**
 * Builds the `attributes` column's object, before its final sanitize pass.
 *
 * @param config The plugin's resolved configuration.
 * @param invocationContext The invocation the row belongs to.
 * @param data The structured fields the callback supplied.
 * @return The attributes object, still unsanitized.
 */
export function buildAttributes(
  config: ResolvedConfig,
  invocationContext: InvocationContext,
  data: AnalyticsEventData,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {...data.extraAttributes};
  attributes['adk'] = {
    ...buildAdkEnvelope(invocationContext, data.sourceEvent),
    ...data.adk,
  };
  attributes['root_agent_name'] =
    invocationContext.agent?.rootAgent.name ?? null;
  if (data.model !== undefined) {
    attributes['model'] = data.model;
  }
  if (data.modelVersion !== undefined) {
    attributes['model_version'] = data.modelVersion;
  }
  if (data.usageMetadata !== undefined) {
    attributes['usage_metadata'] = data.usageMetadata;
  }
  if (data.finishReason !== undefined) {
    attributes['finish_reason'] = data.finishReason;
  }
  if (config.logSessionMetadata) {
    const {session} = invocationContext;
    const metadata: Record<string, unknown> = {
      session_id: session.id,
      app_name: invocationContext.appName,
      user_id: invocationContext.userId,
    };
    // State carries user-set metadata, so it is written whole and left to
    // the caller's truncation and redaction pass.
    if (Object.keys(session.state).length > 0) {
      metadata['state'] = session.state;
    }
    attributes['session_metadata'] = metadata;
  }
  if (Object.keys(config.customTags).length > 0) {
    attributes['custom_tags'] = config.customTags;
  }
  const captured = capturedCustomMetadata(
    config.customMetadataAllowlist,
    data.sourceEvent,
  );
  if (captured !== undefined) {
    attributes['custom_metadata'] = captured;
  }
  const otel = config.enableOtelCorrelation ? ambientOtelIds() : undefined;
  if (otel !== undefined) {
    attributes['otel'] = otel;
  }
  return attributes;
}
