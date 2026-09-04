/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The shape of the file {@link DebugLoggingPlugin} writes.
 *
 * The keys here are snake_case, matching adk-python's dump, because the same
 * tools read both SDKs' files. The plugin's own API stays camelCase.
 */

import {Content, Part} from '@google/genai';

import {Event, isFinalResponse} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {safeSerialize, safeSerializeRecord} from '../utils/redact_secrets.js';

/** The kind of a recorded debug entry. */
export enum DebugEntryType {
  INVOCATION_START = 'invocation_start',
  USER_MESSAGE = 'user_message',
  AGENT_START = 'agent_start',
  AGENT_END = 'agent_end',
  LLM_REQUEST = 'llm_request',
  LLM_RESPONSE = 'llm_response',
  LLM_ERROR = 'llm_error',
  TOOL_CALL = 'tool_call',
  TOOL_RESPONSE = 'tool_response',
  TOOL_ERROR = 'tool_error',
  EVENT = 'event',
  SESSION_STATE_SNAPSHOT = 'session_state_snapshot',
  INVOCATION_END = 'invocation_end',
}

/** A single debug entry recorded at a callback point. */
export interface DebugEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  entryType: DebugEntryType;
  invocationId: string;
  agentName?: string;
  /** The captured, redacted payload for this entry. */
  data: Record<string, unknown>;
}

/** The debug state accumulated across the callbacks of one invocation. */
export interface InvocationDebugState {
  invocationId: string;
  sessionId: string;
  appName: string;
  /** Always present: an adk-js `Session` always carries a user id. */
  userId: string;
  /** ISO-8601 timestamp of when the invocation started. */
  startTime: string;
  entries: DebugEntry[];
  /**
   * Set when the trace was flushed without its invocation ever reaching
   * `afterRunCallback`, so a reader can tell a truncated trace from a
   * finished one. See {@link DebugLoggingPluginOptions.maxBufferedInvocations}.
   */
  incomplete?: boolean;
}

/** Serializes one part, dropping every field it does not carry. */
function serializePart(part: Part): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (part.text) {
    data['text'] = part.text;
  }
  if (part.functionCall) {
    data['function_call'] = {
      id: part.functionCall.id,
      name: part.functionCall.name,
      args: safeSerialize(part.functionCall.args),
    };
  }
  if (part.functionResponse) {
    data['function_response'] = {
      id: part.functionResponse.id,
      name: part.functionResponse.name,
      response: safeSerialize(part.functionResponse.response),
    };
  }
  if (part.inlineData) {
    data['inline_data'] = {
      mime_type: part.inlineData.mimeType,
      display_name: part.inlineData.displayName,
      // The bytes are omitted to keep the file readable.
      _data_omitted: true,
    };
  }
  if (part.fileData) {
    data['file_data'] = {
      file_uri: part.fileData.fileUri,
      mime_type: part.fileData.mimeType,
    };
  }
  if (part.codeExecutionResult) {
    data['code_execution_result'] = {
      outcome: part.codeExecutionResult.outcome,
      output: part.codeExecutionResult.output,
    };
  }
  if (part.executableCode) {
    data['executable_code'] = {
      language: part.executableCode.language,
      code: part.executableCode.code,
    };
  }
  return data;
}

/**
 * Serializes content to a plain, redacted mapping.
 *
 * @param content The content to serialize.
 * @returns `undefined` when there is no content, otherwise its role and the
 *     parts that carry something.
 */
export function serializeContent(
  content: Content | undefined,
): Record<string, unknown> | undefined {
  if (!content) {
    return undefined;
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content.parts ?? []) {
    const data = serializePart(part);
    if (Object.keys(data).length > 0) {
      parts.push(data);
    }
  }
  return {role: content.role, parts};
}

/** Builds the `config` block of an `llm_request` entry. */
export function serializeRequestConfig(
  llmRequest: LlmRequest,
  includeSystemInstruction: boolean,
): Record<string, unknown> | undefined {
  const config = llmRequest.config;
  if (!config) {
    return undefined;
  }
  const data: Record<string, unknown> = {};
  const systemInstruction = config.systemInstruction;
  if (systemInstruction) {
    if (includeSystemInstruction) {
      data['system_instruction'] = safeSerialize(systemInstruction);
    } else if (typeof systemInstruction === 'string') {
      data['system_instruction_length'] = systemInstruction.length;
    } else {
      data['has_system_instruction'] = true;
    }
  }
  if (config.temperature !== undefined) {
    data['temperature'] = config.temperature;
  }
  if (config.topP !== undefined) {
    data['top_p'] = config.topP;
  }
  if (config.topK !== undefined) {
    data['top_k'] = config.topK;
  }
  if (config.maxOutputTokens !== undefined) {
    data['max_output_tokens'] = config.maxOutputTokens;
  }
  if (config.responseMimeType) {
    data['response_mime_type'] = config.responseMimeType;
  }
  if (config.responseSchema) {
    data['has_response_schema'] = true;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

/** Builds the `actions` block of an `event` entry. */
function serializeEventActions(
  event: Event,
): Record<string, unknown> | undefined {
  const actions = event.actions;
  const data: Record<string, unknown> = {};
  if (Object.keys(actions.stateDelta).length > 0) {
    data['state_delta'] = safeSerializeRecord(actions.stateDelta);
  }
  if (Object.keys(actions.artifactDelta).length > 0) {
    // The filename -> version mapping is what makes an artifact write
    // traceable.
    data['artifact_delta'] = {...actions.artifactDelta};
  }
  if (actions.transferToAgent) {
    data['transfer_to_agent'] = actions.transferToAgent;
  }
  if (actions.escalate) {
    data['escalate'] = actions.escalate;
  }
  const requestedAuthConfigs = Object.keys(actions.requestedAuthConfigs).length;
  if (requestedAuthConfigs > 0) {
    // The count only: an auth config holds a credential.
    data['requested_auth_configs'] = requestedAuthConfigs;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

/** Builds the payload of an `event` entry. */
export function serializeEvent(event: Event): Record<string, unknown> {
  const data: Record<string, unknown> = {
    event_id: event.id,
    author: event.author,
    content: serializeContent(event.content),
    is_final_response: isFinalResponse(event),
    partial: event.partial,
    turn_complete: event.turnComplete,
    branch: event.branch,
  };
  const actions = serializeEventActions(event);
  if (actions) {
    data['actions'] = actions;
  }
  if (event.groundingMetadata) {
    data['has_grounding_metadata'] = true;
  }
  if (event.usageMetadata) {
    data['usage_metadata'] = {
      prompt_token_count: event.usageMetadata.promptTokenCount,
      candidates_token_count: event.usageMetadata.candidatesTokenCount,
      total_token_count: event.usageMetadata.totalTokenCount,
    };
  }
  if (event.errorCode) {
    data['error_code'] = event.errorCode;
    data['error_message'] = event.errorMessage;
  }
  if (event.longRunningToolIds && event.longRunningToolIds.length > 0) {
    data['long_running_tool_ids'] = [...event.longRunningToolIds];
  }
  return data;
}

/** Builds the payload of an `llm_response` entry. */
export function serializeLlmResponse(
  llmResponse: LlmResponse,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    content: serializeContent(llmResponse.content),
    partial: llmResponse.partial,
    turn_complete: llmResponse.turnComplete,
  };
  if (llmResponse.errorCode) {
    data['error_code'] = llmResponse.errorCode;
    data['error_message'] = llmResponse.errorMessage;
  }
  if (llmResponse.usageMetadata) {
    data['usage_metadata'] = {
      prompt_token_count: llmResponse.usageMetadata.promptTokenCount,
      candidates_token_count: llmResponse.usageMetadata.candidatesTokenCount,
      total_token_count: llmResponse.usageMetadata.totalTokenCount,
      cached_content_token_count:
        llmResponse.usageMetadata.cachedContentTokenCount,
    };
  }
  if (llmResponse.groundingMetadata) {
    data['has_grounding_metadata'] = true;
  }
  if (llmResponse.finishReason) {
    data['finish_reason'] = llmResponse.finishReason;
  }
  if (llmResponse.modelVersion) {
    data['model_version'] = llmResponse.modelVersion;
  }
  return data;
}

/**
 * Renders one entry as the mapping written to the file.
 *
 * `agentName` is left as `undefined` for an entry recorded outside an agent.
 * js-yaml drops a mapping key whose value is `undefined`, so no `agent_name`
 * key reaches the file.
 */
function toEntryDocument(entry: DebugEntry): Record<string, unknown> {
  return {
    timestamp: entry.timestamp,
    entry_type: entry.entryType,
    invocation_id: entry.invocationId,
    agent_name: entry.agentName,
    data: entry.data,
  };
}

/**
 * Renders one buffered invocation as the mapping written to the file.
 *
 * The keys are renamed to snake_case here, and only here: the file is read by
 * the same tools that read adk-python's dump, so it keeps the reference
 * spelling even though the TypeScript API is camelCase.
 */
export function toDocument(
  state: InvocationDebugState,
): Record<string, unknown> {
  return {
    invocation_id: state.invocationId,
    session_id: state.sessionId,
    app_name: state.appName,
    user_id: state.userId,
    start_time: state.startTime,
    ...(state.incomplete ? {incomplete: true} : {}),
    entries: state.entries.map(toEntryDocument),
  };
}
