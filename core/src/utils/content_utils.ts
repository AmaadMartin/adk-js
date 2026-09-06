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

import {Content, ContentUnion, createUserContent} from '@google/genai';

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
 * Converts an arbitrary workflow node input into a user `Content`.
 *
 * A `Content` keeps its parts but is re-roled to `user`: a node input is the
 * turn being handed to the agent, whatever role its producer stamped. A string
 * becomes one text part, and any other value is serialized.
 */
export function nodeInputToUserContent(input: unknown): Content {
  if (isContent(input)) {
    return {...input, role: 'user'};
  }
  return toUserContent(
    typeof input === 'string' ? input : JSON.stringify(input),
  );
}
