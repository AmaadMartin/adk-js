/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isPlainObject} from 'lodash-es';

/**
 * Reports whether `JSON.stringify` renders `value` as `{}`, meaning the value
 * carries data that will not survive serialization.
 *
 * A plain object is exempt: `{}` is a legitimate payload, and skipping it also
 * keeps a large record off the serializer. Only exotic objects -- a `Map`, a
 * `Set`, a `RegExp`, an `Error`, an instance whose state sits behind getters --
 * reach the `JSON.stringify` call, and those are small.
 */
export function rendersAsEmptyJsonObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || isPlainObject(value)) {
    return false;
  }
  try {
    return JSON.stringify(value) === '{}';
  } catch {
    // A circular reference and a bigint both throw here, and both throw again
    // when the caller serializes the value for the wire. That failure is
    // already loud, so this predicate stays quiet about it.
    return false;
  }
}
