/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createFunctionResponsePartFromBase64,
  createFunctionResponsePartFromUri,
  FunctionResponsePart,
  Part,
} from '@google/genai';
import {isEmpty, isPlainObject} from 'lodash-es';

/**
 * The deepest container whose entries are searched for media: the value a tool
 * returns, and one container inside it. A deeper search would walk a tool's own
 * data structures on every call, and the bound also stops a self-referential
 * result being walked forever.
 */
const MAX_MEDIA_CONTAINER_DEPTH = 1;

/**
 * The own keys a genai `Part` may carry.
 *
 * A `Part` is a plain object, so its keys are the only way to tell it apart
 * from a record a tool built itself. Without this allowlist the result
 * `{inlineData: blob, summary: 'up 3%'}` would read as one `Part` and `summary`
 * would be dropped. A genai release that adds a key makes the guard fail
 * closed: the value stays in the response body, as it does today.
 */
const PART_KEYS: ReadonlySet<string> = new Set([
  'codeExecutionResult',
  'executableCode',
  'fileData',
  'functionCall',
  'functionResponse',
  'inlineData',
  'mediaResolution',
  'partMetadata',
  'text',
  'thought',
  'thoughtSignature',
  'toolCall',
  'toolResponse',
  'videoMetadata',
]);

/** A tool result with its media separated out. */
export interface ExtractedMedia {
  /**
   * The result with the media removed, or the original value when the result
   * carries no media.
   */
  remainder: unknown;
  /** The extracted media, or undefined when the result carries none. */
  parts?: FunctionResponsePart[];
}

/** What is left of one entry of a container after its media is taken out. */
interface KeptEntry {
  /** Whether the entry stays in the response body. */
  keep: boolean;
  /** What is left of the entry. */
  kept: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function isContainer(value: unknown): boolean {
  return Array.isArray(value) || isRecord(value);
}

function isPartShaped(value: unknown): value is Part {
  return (
    isRecord(value) && Object.keys(value).every((key) => PART_KEYS.has(key))
  );
}

/**
 * Converts a tool-returned part into a function response part.
 *
 * Returns undefined when the value is not a part carrying usable media.
 */
function asFunctionResponsePart(
  value: unknown,
): FunctionResponsePart | undefined {
  if (!isPartShaped(value)) {
    return undefined;
  }
  const blob = value.inlineData;
  if (blob?.data != null && blob.mimeType) {
    return createFunctionResponsePartFromBase64(blob.data, blob.mimeType);
  }
  const file = value.fileData;
  if (file?.fileUri && file.mimeType) {
    return createFunctionResponsePartFromUri(file.fileUri, file.mimeType);
  }
  return undefined;
}

/**
 * Removes media from one entry of a tool result.
 *
 * Any parts found are appended to `parts`. Only arrays and plain objects are
 * descended into, so a class instance a tool returns is left alone.
 */
function extractMediaFromEntry(
  value: unknown,
  parts: FunctionResponsePart[],
  depth: number,
): KeptEntry {
  const part = asFunctionResponsePart(value);
  if (part) {
    parts.push(part);
    return {keep: false, kept: undefined};
  }
  if (depth >= MAX_MEDIA_CONTAINER_DEPTH || !isContainer(value)) {
    return {keep: true, kept: value};
  }
  const nested = extractMediaParts(value, depth + 1);
  if (!nested.parts?.length) {
    return {keep: true, kept: value};
  }
  parts.push(...nested.parts);
  return {keep: !isEmpty(nested.remainder), kept: nested.remainder};
}

/**
 * Moves media in a tool result into function response parts.
 *
 * A tool result is otherwise required to be JSON-serializable, which leaves no
 * way to hand back media except by encoding it into a string the model reads as
 * text. A tool that produces an image, audio clip or document returns a `Part`
 * holding the base64 bytes or a uri instead, on its own or among the entries of
 * a returned container, which may itself hold a container of parts.
 *
 * @param result Whatever a tool or a tool callback produced.
 * @param depth How deep into the returned containers this call already is.
 * @returns The result with the media removed, and the extracted parts. The
 *     parts are undefined when the result carries no media, in which case the
 *     remainder is the original result.
 */
export function extractMediaParts(result: unknown, depth = 0): ExtractedMedia {
  const single = asFunctionResponsePart(result);
  if (single) {
    return {remainder: {}, parts: [single]};
  }

  const parts: FunctionResponsePart[] = [];
  let remainder: unknown;
  if (isRecord(result)) {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result)) {
      const entry = extractMediaFromEntry(value, parts, depth);
      if (entry.keep) {
        kept[key] = entry.kept;
      }
    }
    remainder = kept;
  } else if (Array.isArray(result)) {
    const kept: unknown[] = [];
    for (const value of result) {
      const entry = extractMediaFromEntry(value, parts, depth);
      if (entry.keep) {
        kept.push(entry.kept);
      }
    }
    remainder = kept;
  } else {
    return {remainder: result};
  }

  if (!parts.length) {
    return {remainder: result};
  }
  return {remainder: isEmpty(remainder) ? {} : remainder, parts};
}
