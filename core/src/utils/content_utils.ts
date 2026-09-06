/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for reading and reshaping genai `Content` and `Part` values,
 * so that live sessions, workflow nodes and plugins agree on what the text of a
 * content is, what an audio part is, and what a user turn is.
 *
 * Ports `google/adk-python` `utils/content_utils.py`.
 */

import {Content, Part} from '@google/genai';

/**
 * Placeholder `Part.thoughtSignature` that bypasses backend validation.
 *
 * Set it on a part you synthesize yourself — a model turn or tool call the
 * model never produced — so the Gemini backend accepts the fabricated part
 * instead of rejecting it for a missing signature. The backend matches the
 * decoded bytes `skip_thought_signature_validator`. The genai JS SDK carries a
 * proto `bytes` field as base64, so this constant is that value base64-encoded.
 */
export const SKIP_THOUGHT_SIGNATURE_VALIDATOR =
  'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=';

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
 * Returns the text of a content, excluding its thought parts.
 *
 * Parts are joined with no separator: the model emits a single logical string
 * that is chunked arbitrarily across parts.
 */
export function extractTextFromContent(
  content: Content | undefined | null,
): string {
  return (content?.parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('');
}

/**
 * Coerces an arbitrary value into a `user`-role `Content`.
 *
 * A `Content` keeps its parts and is re-roled to `user`. A string becomes one
 * text part. An object or array is serialized with `JSON.stringify`, which
 * honours a `toJSON()` method and emits non-ASCII verbatim. Anything else is
 * rendered with `String()`.
 *
 * A circular or `BigInt`-bearing value throws out of `JSON.stringify`, matching
 * adk-python, where `json.dumps` raises.
 */
export function toUserContent(value: unknown): Content {
  if (isContent(value)) {
    return {...value, role: 'user'};
  }
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'object' && value !== null) {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  return {role: 'user', parts: [{text}]};
}

function isAudioMimeType(mimeType: string | undefined): boolean {
  return mimeType !== undefined && mimeType.startsWith('audio/');
}
