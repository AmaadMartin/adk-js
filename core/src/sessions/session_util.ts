/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns `value` as `T` when it is a decodable model payload, else undefined.
 *
 * A session store can hand back a primitive where a model was expected: a
 * legacy or corrupted `"null"` string persisted in place of SQL NULL, or a
 * backend that serialized an empty message as `[]`. Passing that on as a model
 * breaks session replay, so it is dropped instead.
 *
 * Only the payload's shape is checked. A non-null, non-array object is
 * returned unchanged, which mirrors what the wire format already guarantees
 * for these fields.
 */
export function decodeModel<T>(value: unknown): T | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as T;
}
