/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, Part} from '@google/genai';
import type {LlmRequest} from '../models/llm_request.js';
import {redactUriPassword} from '../utils/redact_uri.js';
import {recursiveSmartTruncate, truncateText} from '../utils/sanitize_utils.js';
import {
  AnalyticsContentPart,
  AnalyticsStorageMode,
} from './bigquery_analytics_schema.js';

/**
 * Turns a callback payload into the `content` and `content_parts` columns of
 * the agent analytics events table.
 *
 * The shapes match `google/adk-python`'s `HybridContentParser.parse()`: an
 * `LlmRequest` becomes `{prompt, system_prompt}`, a `Content` becomes
 * `{text_summary}` plus one record per part, and anything else becomes its
 * sanitized self. Keeping the shapes identical is what lets one dataset serve
 * queries written against either SDK.
 */

/** Separator between the per-part summaries of one `Content`. */
const SUMMARY_SEPARATOR = ' | ';

/** Text written for a part whose bytes are inline and are not stored. */
const BINARY_DATA = '[BINARY DATA]';

/** The result of turning one payload into table columns. */
export interface ParsedAnalyticsContent {
  /** The value for the `content` column, before JSON encoding. */
  payload: unknown;
  /** The value for the repeated `content_parts` column. */
  parts: AnalyticsContentPart[];
  /** Whether any payload was lost on the way. */
  truncated: boolean;
}

/** One part's record plus the text it contributes to the content summary. */
interface BuiltContentPart {
  part: AnalyticsContentPart;
  summary?: string;
  truncated: boolean;
}

/** Narrows an arbitrary value to an indexable record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Returns whether `value` is an {@link LlmRequest}. A shape check rather than
 * `instanceof`, which misidentifies objects built by a second copy of the
 * package in the same runtime.
 */
function isLlmRequest(value: unknown): value is LlmRequest {
  return (
    isRecord(value) &&
    Array.isArray(value['contents']) &&
    isRecord(value['toolsDict'])
  );
}

/** Returns whether `value` is a genai `Content` carrying parts. */
function isContent(value: unknown): value is Content {
  return isRecord(value) && Array.isArray(value['parts']);
}

/** Sanitizes one genai part model for embedding in `part_attributes`. */
function sanitizePartModel(
  value: unknown,
  maxLength: number,
): {value: unknown; truncated: boolean} {
  return recursiveSmartTruncate(value, maxLength);
}

/** The record every part starts from, before its own case fills it in. */
function baseContentPart(index: number): AnalyticsContentPart {
  return {
    part_index: index,
    mime_type: 'text/plain',
    uri: null,
    text: null,
    part_attributes: '{}',
    storage_mode: AnalyticsStorageMode.INLINE,
    object_ref: null,
  };
}

/** Builds the `content_parts` record for one genai part. */
function buildContentPart(
  part: Part,
  index: number,
  maxLength: number,
): BuiltContentPart {
  const record = baseContentPart(index);

  if (part.fileData) {
    const {fileUri, mimeType} = part.fileData;
    record.storage_mode = AnalyticsStorageMode.EXTERNAL_URI;
    record.uri = fileUri === undefined ? null : redactUriPassword(fileUri);
    record.mime_type = mimeType ?? record.mime_type;
    return {part: record, truncated: false};
  }

  if (part.inlineData) {
    record.text = BINARY_DATA;
    return {part: record, truncated: false};
  }

  if (part.text) {
    const {text, truncated} = truncateText(part.text, maxLength);
    record.text = text;
    return {part: record, summary: text, truncated};
  }

  if (part.functionCall) {
    record.mime_type = 'application/json';
    record.text = `Function: ${part.functionCall.name}`;
    record.part_attributes = JSON.stringify({
      function_name: part.functionCall.name,
    });
    return {part: record, truncated: false};
  }

  if (part.functionResponse) {
    const summary = `Function response: ${part.functionResponse.name}`;
    const {value, truncated} = sanitizePartModel(
      part.functionResponse,
      maxLength,
    );
    record.mime_type = 'application/json';
    record.text = summary;
    record.part_attributes = JSON.stringify({function_response: value});
    return {part: record, summary, truncated};
  }

  if (part.executableCode) {
    const code = part.executableCode.code ?? '';
    const language = part.executableCode.language ?? 'unknown';
    const {value, truncated} = sanitizePartModel(
      part.executableCode,
      maxLength,
    );
    record.text = code;
    record.part_attributes = JSON.stringify({executable_code: value});
    return {
      part: record,
      summary: `Executable code (${language}): ${code}`,
      truncated,
    };
  }

  if (part.codeExecutionResult) {
    const output = part.codeExecutionResult.output ?? '';
    const outcome = part.codeExecutionResult.outcome ?? 'unknown';
    const {value, truncated} = sanitizePartModel(
      part.codeExecutionResult,
      maxLength,
    );
    record.text = output;
    record.part_attributes = JSON.stringify({code_execution_result: value});
    return {
      part: record,
      summary: `Code execution result (${outcome}): ${output}`,
      truncated,
    };
  }

  return {part: record, truncated: false};
}

/** Renders one part as a {@link formatContentSummary} fragment. */
function describePart(
  part: Part,
  maxLength: number,
): {summary: string; truncated: boolean} {
  if (part.text) {
    const {text, truncated} = truncateText(part.text, maxLength);
    return {summary: `text: '${text}'`, truncated};
  }
  if (part.functionCall) {
    return {summary: `call: ${part.functionCall.name}`, truncated: false};
  }
  if (part.functionResponse) {
    return {summary: `resp: ${part.functionResponse.name}`, truncated: false};
  }
  return {summary: 'other', truncated: false};
}

/**
 * Renders a `Content` as the one-line summary the response rows carry.
 *
 * This is a second, shorter rendering than {@link parseAnalyticsContent}:
 * adk-python uses it for `LLM_RESPONSE` and `AGENT_RESPONSE`, so the `content`
 * column of those rows reads the same in both SDKs.
 *
 * @param content The content to render, or undefined.
 * @param maxLength Maximum length of any single text part, or -1 for no limit.
 * @return The summary line and whether any text was cut.
 */
export function formatContentSummary(
  content: Content | undefined,
  maxLength: number,
): {text: string; truncated: boolean} {
  if (content === undefined || !content.parts?.length) {
    return {text: 'None', truncated: false};
  }
  let truncated = false;
  const fragments = content.parts.map((part) => {
    const described = describePart(part, maxLength);
    truncated = truncated || described.truncated;
    return described.summary;
  });
  return {text: fragments.join(SUMMARY_SEPARATOR), truncated};
}

/** Builds the summary text and the part records for one `Content`. */
function parseContentObject(
  content: Content,
  maxLength: number,
): {summary: string; parts: AnalyticsContentPart[]; truncated: boolean} {
  const parts: AnalyticsContentPart[] = [];
  const summaries: string[] = [];
  let truncated = false;
  (content.parts ?? []).forEach((part, index) => {
    const built = buildContentPart(part, index, maxLength);
    parts.push(built.part);
    truncated = truncated || built.truncated;
    if (built.summary !== undefined) {
      summaries.push(built.summary);
    }
  });
  const joined = truncateText(summaries.join(SUMMARY_SEPARATOR), maxLength);
  return {
    summary: joined.text,
    parts,
    truncated: truncated || joined.truncated,
  };
}

/** Builds the `{prompt, system_prompt}` payload of an `LlmRequest`. */
function parseLlmRequest(
  request: LlmRequest,
  maxLength: number,
): ParsedAnalyticsContent {
  const payload: Record<string, unknown> = {};
  const parts: AnalyticsContentPart[] = [];
  const messages: Array<{role: string; content: string}> = [];
  let truncated = false;
  for (const content of request.contents) {
    const parsed = parseContentObject(content, maxLength);
    parts.push(...parsed.parts);
    truncated = truncated || parsed.truncated;
    messages.push({role: content.role ?? 'unknown', content: parsed.summary});
  }
  if (messages.length > 0) {
    payload['prompt'] = messages;
  }
  const systemInstruction = request.config?.systemInstruction;
  if (typeof systemInstruction === 'string') {
    const cut = truncateText(systemInstruction, maxLength);
    payload['system_prompt'] = cut.text;
    truncated = truncated || cut.truncated;
  }
  return {payload, parts, truncated};
}

/**
 * Turns a callback payload into the `content` and `content_parts` columns.
 *
 * @param raw The payload a callback captured.
 * @param maxLength Maximum length of any single string, or -1 for no limit.
 * @return The column values and whether any payload was lost.
 */
export function parseAnalyticsContent(
  raw: unknown,
  maxLength: number,
): ParsedAnalyticsContent {
  if (raw === null || raw === undefined) {
    return {payload: null, parts: [], truncated: false};
  }
  if (isLlmRequest(raw)) {
    return parseLlmRequest(raw, maxLength);
  }
  if (isContent(raw)) {
    const parsed = parseContentObject(raw, maxLength);
    return {
      payload: {text_summary: parsed.summary},
      parts: parsed.parts,
      truncated: parsed.truncated,
    };
  }
  if (typeof raw === 'string') {
    const cut = truncateText(raw, maxLength);
    return {payload: cut.text, parts: [], truncated: cut.truncated};
  }
  const sanitized = recursiveSmartTruncate(raw, maxLength);
  return {
    payload: sanitized.value,
    parts: [],
    truncated: sanitized.truncated,
  };
}
