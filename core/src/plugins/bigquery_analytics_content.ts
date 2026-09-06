/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Blob, Content, Part} from '@google/genai';
import type {LlmRequest} from '../models/llm_request.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  NO_LENGTH_LIMIT,
  recursiveSmartTruncate,
  sanitizeErrorText,
  truncateText,
} from '../utils/sanitize_utils.js';
import {sanitizeExternalUri} from '../utils/uri_sanitize_utils.js';
import type {ContentOffloader} from './bigquery_analytics_offloader.js';
import {
  AnalyticsContentPart,
  AnalyticsObjectRef,
  AnalyticsStorageMode,
} from './bigquery_analytics_schema.js';
import {newHexId} from './bigquery_analytics_spans.js';

/**
 * Turns a callback payload into the `content` and `content_parts` columns of
 * the agent analytics events table.
 *
 * The shapes match `google/adk-python`'s `HybridContentParser.parse()`: an
 * `LlmRequest` becomes `{prompt, system_prompt}`, a `Content` becomes
 * `{text_summary}` plus one record per part, and anything else becomes its
 * sanitized self. Keeping the shapes identical is what lets one dataset serve
 * queries written against either SDK.
 *
 * A part whose content is too large to inline goes to Cloud Storage instead,
 * when the caller supplies an {@link AnalyticsOffload}. The row then carries a
 * `gs://` URI and an `object_ref` in place of the bytes.
 */

/** Separator between the per-part summaries of one `Content`. */
const SUMMARY_SEPARATOR = ' | ';

/** Text written for a part whose bytes are inline and are not stored. */
const BINARY_DATA = '[BINARY DATA]';

/** Text written for a part whose bytes went to Cloud Storage. */
const MEDIA_OFFLOADED = '[MEDIA OFFLOADED]';

/** Text written for a part whose upload failed. Its bytes are not stored. */
const UPLOAD_FAILED = '[UPLOAD FAILED]';

/** Appended to the preview of text that went to Cloud Storage. */
const OFFLOADED_SUFFIX = '... [OFFLOADED]';

/** How much of an offloaded text the row keeps as a preview. */
const OFFLOADED_PREVIEW_CHARS = 200;

/**
 * Byte length above which a text part is offloaded rather than inlined. This
 * is a storage guard and is counted in bytes, where `maxContentLength` is a
 * truncation limit and is counted in characters. Evaluating either one in the
 * other's unit misjudges every multi-byte payload.
 */
const INLINE_TEXT_LIMIT = 32 * 1024;

/** MIME type of an offloaded text object. */
const TEXT_MIME_TYPE = 'text/plain';

/** MIME type recorded for inline bytes that declare none. */
const DEFAULT_BINARY_MIME_TYPE = 'application/octet-stream';

/** Object-name extension for a MIME type this module does not recognize. */
const DEFAULT_EXTENSION = '.bin';

/** Object-name extension of an offloaded text object. */
const TEXT_EXTENSION = '.txt';

/**
 * Extensions for the MIME types an agent turn actually carries. Node has no
 * MIME database of its own, and one small map is cheaper than a dependency.
 */
const EXTENSION_BY_MIME_TYPE: ReadonlyMap<string, string> = new Map([
  ['application/json', '.json'],
  ['application/pdf', '.pdf'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['text/csv', '.csv'],
  ['text/html', '.html'],
  ['text/plain', '.txt'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
]);

/** The Cloud Storage destination one parse call writes to. */
export interface AnalyticsOffload {
  /** Uploads the content and returns the URI naming it. */
  offloader: ContentOffloader;
  /** The trace the calling event belongs to. */
  traceId: string;
  /** The span the calling event belongs to. */
  spanId: string;
  /** The BigQuery connection recorded on each `object_ref`. */
  connectionId?: string;
}

/** What one call to {@link parseContentParts} needs. */
export interface ContentPartsOptions {
  /** Maximum length of any single string, or -1 for no limit. */
  maxLength: number;
  /** Where oversized content goes. Omit to keep every part inline. */
  offload?: AnalyticsOffload;
  /**
   * Shared by the contents of one request. The part index restarts per
   * `Content`, so without it two messages collide at the same part ordinal.
   * Defaults to a fresh identifier.
   */
  parseUid?: string;
  /** The message index within a multi-content request. Defaults to 0. */
  contentOrdinal?: number;
}

/** The result of turning one payload into table columns. */
export interface ParsedAnalyticsContent {
  /** The value for the `content` column, before JSON encoding. */
  payload: unknown;
  /** The value for the repeated `content_parts` column. */
  parts: AnalyticsContentPart[];
  /** Whether any payload was lost on the way. */
  truncated: boolean;
}

/** The result of turning one `Content` into part records. */
export interface ParsedContentParts {
  /** The one-line summary of the parts that contribute one. */
  summary: string;
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

/** Everything one part needs to name and write its Cloud Storage object. */
interface PartScope {
  maxLength: number;
  offload?: AnalyticsOffload;
  parseUid: string;
  contentOrdinal: number;
  partIndex: number;
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
function isContent(value: unknown): value is Content & {parts: Part[]} {
  return isRecord(value) && Array.isArray(value['parts']);
}

/**
 * Returns whether `value` can be read as a genai `Part`. Every field of a
 * `Part` is optional, so any object qualifies and one carrying none of them
 * contributes an empty record rather than raising.
 */
function isPart(value: unknown): value is Part {
  return isRecord(value);
}

/** The record every part starts from, before its own case fills it in. */
function baseContentPart(index: number): AnalyticsContentPart {
  return {
    part_index: index,
    mime_type: TEXT_MIME_TYPE,
    uri: null,
    text: null,
    part_attributes: '{}',
    storage_mode: AnalyticsStorageMode.INLINE,
    object_ref: null,
  };
}

/** Today's date in the local zone, as `YYYY-MM-DD`. */
function localDate(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** The object-name extension for `mimeType`. */
function fileExtension(mimeType: string): string {
  return (
    EXTENSION_BY_MIME_TYPE.get(mimeType.toLowerCase()) ?? DEFAULT_EXTENSION
  );
}

/** The object name one part's content is written under. */
function objectPath(
  offload: AnalyticsOffload,
  scope: PartScope,
  extension: string,
): string {
  return (
    `${localDate()}/${offload.traceId}/${offload.spanId}` +
    `_${scope.parseUid}_c${scope.contentOrdinal}_p${scope.partIndex}${extension}`
  );
}

/** The `object_ref` column value for an object at `uri`. */
function buildObjectRef(
  uri: string,
  contentType: string,
  connectionId: string | undefined,
): AnalyticsObjectRef {
  return {
    uri,
    version: null,
    authorizer: connectionId ?? null,
    details: JSON.stringify({gcs_metadata: {content_type: contentType}}),
  };
}

/**
 * Uploads `data` and returns the URI naming it, or undefined when the upload
 * failed. An offload failure costs the row its content, never the row itself.
 */
async function uploadContent(
  offload: AnalyticsOffload,
  data: Buffer | string,
  contentType: string,
  path: string,
): Promise<string | undefined> {
  try {
    return await offload.offloader.uploadContent(data, contentType, path);
  } catch (err: unknown) {
    logger.warn(
      `BigQuery analytics could not offload content to Cloud Storage: ${formatError(err)}`,
    );
    return undefined;
  }
}

/** Records an external URI, with its credentials redacted. */
function buildFileDataPart(
  record: AnalyticsContentPart,
  fileData: NonNullable<Part['fileData']>,
  maxLength: number,
): BuiltContentPart {
  const safe = sanitizeExternalUri(fileData.fileUri, maxLength);
  record.storage_mode = AnalyticsStorageMode.EXTERNAL_URI;
  record.uri = safe.uri;
  record.mime_type = fileData.mimeType ?? record.mime_type;
  return {part: record, truncated: safe.changed};
}

/** Records inline bytes, offloading them to Cloud Storage when configured. */
async function buildInlineDataPart(
  record: AnalyticsContentPart,
  inlineData: Blob,
  scope: PartScope,
): Promise<BuiltContentPart> {
  const {offload} = scope;
  if (offload === undefined) {
    record.text = BINARY_DATA;
    return {part: record, truncated: false};
  }
  const mimeType = inlineData.mimeType ?? DEFAULT_BINARY_MIME_TYPE;
  const uri = await uploadContent(
    offload,
    // genai carries inline bytes base64-encoded; the object holds the bytes.
    Buffer.from(inlineData.data ?? '', 'base64'),
    mimeType,
    objectPath(offload, scope, fileExtension(mimeType)),
  );
  if (uri === undefined) {
    record.text = UPLOAD_FAILED;
    return {part: record, truncated: false};
  }
  record.storage_mode = AnalyticsStorageMode.GCS_REFERENCE;
  record.uri = uri;
  record.object_ref = buildObjectRef(uri, mimeType, offload.connectionId);
  record.mime_type = mimeType;
  record.text = MEDIA_OFFLOADED;
  return {part: record, truncated: false};
}

/**
 * Records text, offloading it to Cloud Storage when it is too large to inline.
 *
 * The two limits are evaluated in their own units, and either one triggers the
 * offload. The value uploaded is the sanitized text, never the raw text, so a
 * credential the row would not carry does not reach the bucket either.
 */
async function buildTextPart(
  record: AnalyticsContentPart,
  text: string,
  scope: PartScope,
): Promise<BuiltContentPart> {
  const {maxLength, offload} = scope;
  const sanitized = sanitizeErrorText(text, NO_LENGTH_LIMIT);
  const safeText = sanitized.text;
  const exceedsInlineByteLimit =
    Buffer.byteLength(safeText, 'utf8') > INLINE_TEXT_LIMIT;
  const exceedsCharLimit =
    maxLength !== NO_LENGTH_LIMIT && safeText.length > maxLength;
  if (offload !== undefined && (exceedsInlineByteLimit || exceedsCharLimit)) {
    const uri = await uploadContent(
      offload,
      safeText,
      TEXT_MIME_TYPE,
      objectPath(offload, scope, TEXT_EXTENSION),
    );
    if (uri !== undefined) {
      record.storage_mode = AnalyticsStorageMode.GCS_REFERENCE;
      record.uri = uri;
      record.object_ref = buildObjectRef(
        uri,
        TEXT_MIME_TYPE,
        offload.connectionId,
      );
      record.text =
        safeText.slice(0, OFFLOADED_PREVIEW_CHARS) + OFFLOADED_SUFFIX;
      return {part: record, truncated: sanitized.truncated};
    }
  }
  const bounded = truncateText(safeText, maxLength);
  record.text = bounded.text;
  return {
    part: record,
    summary: bounded.text,
    truncated: sanitized.truncated || bounded.truncated,
  };
}

/** Builds the `content_parts` record for one genai part. */
async function buildContentPart(
  part: Part,
  scope: PartScope,
): Promise<BuiltContentPart> {
  const record = baseContentPart(scope.partIndex);
  const maxLength = scope.maxLength;

  if (part.fileData) {
    return buildFileDataPart(record, part.fileData, maxLength);
  }

  if (part.inlineData) {
    return buildInlineDataPart(record, part.inlineData, scope);
  }

  if (part.text) {
    return buildTextPart(record, part.text, scope);
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
    const {value, truncated} = recursiveSmartTruncate(
      part.functionResponse,
      maxLength,
    );
    record.mime_type = 'application/json';
    record.text = summary;
    record.part_attributes = JSON.stringify({function_response: value});
    return {part: record, summary, truncated};
  }

  if (part.executableCode) {
    const code = sanitizeErrorText(
      part.executableCode.code ?? '',
      maxLength,
    ).text;
    const language = part.executableCode.language ?? 'unknown';
    const {value, truncated} = recursiveSmartTruncate(
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
    const output = sanitizeErrorText(
      part.codeExecutionResult.output ?? '',
      maxLength,
    ).text;
    const outcome = part.codeExecutionResult.outcome ?? 'unknown';
    const {value, truncated} = recursiveSmartTruncate(
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
function describePart(part: Part): string {
  if (part.text) {
    return `text: '${part.text}'`;
  }
  if (part.functionCall) {
    return `call: ${part.functionCall.name}`;
  }
  if (part.functionResponse) {
    return `resp: ${part.functionResponse.name}`;
  }
  return 'other';
}

/**
 * Renders a `Content` as the one-line summary the response rows carry.
 *
 * This is a second, shorter rendering than {@link parseAnalyticsContent}:
 * adk-python uses it for `LLM_RESPONSE` and `AGENT_RESPONSE`, so the `content`
 * column of those rows reads the same in both SDKs.
 *
 * The result is unbounded. The single sanitize pass the caller runs before
 * writing the row is what bounds it, so a long answer carries one
 * `...[TRUNCATED]` marker rather than one per part and one for the line.
 *
 * @param content The content to render, or undefined.
 * @return The summary line.
 */
export function formatContentSummary(content: Content | undefined): string {
  if (content === undefined || !content.parts?.length) {
    return 'None';
  }
  return content.parts.map(describePart).join(SUMMARY_SEPARATOR);
}

/** The parts of `content`, whatever `ContentUnion` member it is. */
function unpackParts(content: unknown): Part[] {
  if (isContent(content)) {
    return content.parts;
  }
  const members: unknown[] = Array.isArray(content) ? content : [content];
  return members.map((member) => (isPart(member) ? member : {}));
}

/**
 * Builds the summary text and the part records for one `Content`.
 *
 * @param content A `Content`, an array of parts, or any other `ContentUnion`
 *     member. A member carrying no part fields yields an empty record.
 * @param options The length limit and the Cloud Storage destination.
 * @return The summary, the part records and whether any payload was lost.
 */
export async function parseContentParts(
  content: unknown,
  options: ContentPartsOptions,
): Promise<ParsedContentParts> {
  const {maxLength, offload} = options;
  const parseUid = options.parseUid ?? newHexId();
  const contentOrdinal = options.contentOrdinal ?? 0;
  const parts: AnalyticsContentPart[] = [];
  const summaries: string[] = [];
  let truncated = false;
  const members = unpackParts(content);
  for (let partIndex = 0; partIndex < members.length; partIndex++) {
    const built = await buildContentPart(members[partIndex], {
      maxLength,
      offload,
      parseUid,
      contentOrdinal,
      partIndex,
    });
    parts.push(built.part);
    truncated = truncated || built.truncated;
    if (built.summary !== undefined) {
      summaries.push(built.summary);
    }
  }
  const joined = truncateText(summaries.join(SUMMARY_SEPARATOR), maxLength);
  return {
    summary: joined.text,
    parts,
    truncated: truncated || joined.truncated,
  };
}

/** Builds the `{prompt, system_prompt}` payload of an `LlmRequest`. */
async function parseLlmRequest(
  request: LlmRequest,
  options: ContentPartsOptions,
): Promise<ParsedAnalyticsContent> {
  const {maxLength} = options;
  const payload: Record<string, unknown> = {};
  const parts: AnalyticsContentPart[] = [];
  const messages: Array<{role: string; content: string}> = [];
  let truncated = false;
  for (const [contentOrdinal, content] of request.contents.entries()) {
    const parsed = await parseContentParts(content, {
      ...options,
      contentOrdinal,
    });
    parts.push(...parsed.parts);
    truncated = truncated || parsed.truncated;
    // The role is caller-supplied text like any other, so it is sanitized
    // rather than copied into the row verbatim.
    const role = sanitizeErrorText(content.role ?? 'unknown', maxLength);
    truncated = truncated || role.truncated;
    messages.push({role: role.text, content: parsed.summary});
  }
  if (messages.length > 0) {
    payload['prompt'] = messages;
  }
  const systemInstruction = request.config?.systemInstruction;
  if (typeof systemInstruction === 'string') {
    const cut = sanitizeErrorText(systemInstruction, maxLength);
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
 * @param offload Where oversized content goes. Omit to keep every part inline.
 * @return The column values and whether any payload was lost.
 */
export async function parseAnalyticsContent(
  raw: unknown,
  maxLength: number,
  offload?: AnalyticsOffload,
): Promise<ParsedAnalyticsContent> {
  const options: ContentPartsOptions = {
    maxLength,
    offload,
    // Shared by every content of this payload, so their object names differ.
    parseUid: newHexId(),
  };
  if (raw === null || raw === undefined) {
    return {payload: null, parts: [], truncated: false};
  }
  if (isLlmRequest(raw)) {
    return parseLlmRequest(raw, options);
  }
  if (isContent(raw)) {
    const parsed = await parseContentParts(raw, options);
    return {
      payload: {text_summary: parsed.summary},
      parts: parsed.parts,
      truncated: parsed.truncated,
    };
  }
  if (typeof raw === 'string') {
    const cut = sanitizeErrorText(raw, maxLength);
    return {payload: cut.text, parts: [], truncated: cut.truncated};
  }
  const sanitized = recursiveSmartTruncate(raw, maxLength);
  return {
    payload: sanitized.value,
    parts: [],
    truncated: sanitized.truncated,
  };
}
