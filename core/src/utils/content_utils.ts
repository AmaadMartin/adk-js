/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, ContentUnion, Part} from '@google/genai';

/**
 * Distinguishes the two object arms of `ContentUnion`. Only `Content` carries
 * a `parts` array; every other object arm is a `Part`.
 */
export function isPart(value: Content | Part): value is Part {
  return !('parts' in value);
}

/** Joins the fragments that carry text, or returns `undefined` when none do. */
function joinTexts(texts: Array<string | undefined>): string | undefined {
  return texts.filter(Boolean).join('\n') || undefined;
}

/**
 * Reads the text carried by any arm of `@google/genai`'s `ContentUnion`
 * (`Content | (Part | string)[] | Part | string`).
 *
 * Several fragments are joined with a newline. The result is never an empty
 * string: a value that carries no text at all yields `undefined`, so callers
 * can test it for truthiness. The argument is never mutated.
 *
 * @param value The value to read, typically a `systemInstruction`.
 * @returns The recovered text, or `undefined` when there is none.
 */
export function contentUnionToText(
  value: ContentUnion | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return joinTexts(value.map(contentUnionToText));
  }
  if (isPart(value)) {
    return value.text || undefined;
  }
  return joinTexts((value.parts ?? []).map(contentUnionToText));
}
