/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for reading and reshaping genai `Content` and `Part` values.
 *
 * Ports `google/adk-python` `utils/content_utils.py`.
 */

import {Content, ContentUnion, createUserContent, Part} from '@google/genai';

/** Returns whether a value looks like a genai `Content` object. */
export function isContent(value: unknown): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parts' in value &&
    Array.isArray((value as {parts?: unknown}).parts)
  );
}

/**
 * Normalizes a string, a `Part`, or a `Part[]` into a user `Content`.
 *
 * A value that is already a `Content` is returned unchanged, so callers that
 * pass one keep object identity. Mirrors `t_content` in `google-genai`, which
 * `google/adk-python` `events/event.py` calls for the same purpose.
 */
export function toUserContent(value: ContentUnion): Content {
  return isContent(value) ? value : createUserContent(value);
}

/**
 * Coerces a value of any shape into a user `Content`.
 *
 * A `Content` keeps its parts and is re-roled to user; a string becomes one
 * text part; anything else is serialized to JSON, so a structured value still
 * reaches a model that only reads text.
 *
 * Use this for a value whose shape the caller does not control, such as a
 * workflow node input. {@link toUserContent} is the strict version: it takes a
 * `ContentUnion` and never re-roles a `Content` it is given.
 *
 * Mirrors `to_user_content` in google/adk-python `utils/content_utils.py`.
 *
 * @param input The value to convert.
 * @return A `Content` with `role: 'user'`.
 */
export function coerceToUserContent(input: unknown): Content {
  if (isContent(input)) {
    return {...input, role: 'user'};
  }
  if (typeof input === 'string') {
    return {role: 'user', parts: [{text: input}]};
  }
  return {role: 'user', parts: [{text: JSON.stringify(input)}]};
}

/**
 * Returns whether a part carries audio, by inline blob or by file reference.
 *
 * The check is a prefix match on the top-level MIME type, so
 * `application/audio-ish` is not audio. A part with no MIME type is not audio:
 * an unlabelled blob cannot be proven to be audio, so it is kept.
 */
export function isAudioPart(part: Part): boolean {
  return (
    isAudioMimeType(part.inlineData?.mimeType) ||
    isAudioMimeType(part.fileData?.mimeType)
  );
}

/**
 * Returns a copy of `content` with its audio parts removed, or `undefined` when
 * nothing survives.
 *
 * `undefined` tells the caller to drop the whole content rather than send one
 * with no parts. The input is never mutated.
 */
export function filterAudioParts(content: Content): Content | undefined {
  const kept = (content.parts ?? []).filter((part) => !isAudioPart(part));
  return kept.length > 0 ? {...content, parts: kept} : undefined;
}

/**
 * Joins the text of every text part, with no separator.
 *
 * A part carrying anything else contributes nothing. Ask
 * {@link contentHasNonTextParts} whether that happened.
 */
export function contentToText(content: Content): string {
  let text = '';
  for (const part of content.parts ?? []) {
    if (part.text !== undefined && part.text !== null) {
      text += part.text;
    }
  }
  return text;
}

/**
 * Whether any part carries data that {@link contentToText} drops: inline data,
 * file data or executable code.
 *
 * A part carrying none of those three is not counted, so a thought part or an
 * empty part does not make a `Content` lossy to read as text.
 */
export function contentHasNonTextParts(content: Content): boolean {
  return (content.parts ?? []).some(
    (part) =>
      part.inlineData !== undefined ||
      part.fileData !== undefined ||
      part.executableCode !== undefined,
  );
}

function isAudioMimeType(mimeType: string | undefined): boolean {
  return mimeType !== undefined && mimeType.startsWith('audio/');
}
