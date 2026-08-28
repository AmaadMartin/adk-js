/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Every shape a fetch-style caller may supply request headers in. */
export type HeadersLike = Headers | string[][] | Record<string, string>;

/**
 * Normalizes any headers shape into a plain record, so headers supplied as a
 * `Headers` instance or an array of pairs are not silently dropped when other
 * headers are merged over them.
 */
export function toHeaderRecord(init?: HeadersLike): Record<string, string> {
  if (!init) return {};

  const record: Record<string, string> = {};
  if (init instanceof Headers) {
    // `Headers` is iterable only under the DOM.Iterable lib, which this
    // package does not enable; `forEach` is on the base DOM lib.
    init.forEach((value, name) => {
      record[name] = value;
    });
  } else if (Array.isArray(init)) {
    for (const [name, value] of init) {
      record[name] = value;
    }
  } else {
    Object.assign(record, init);
  }
  return record;
}

/**
 * Merges `overrides` over `base`, matching header names case-insensitively.
 *
 * HTTP header names are case-insensitive, so a plain spread would keep both
 * `authorization` and `Authorization` and the server would receive the two
 * values joined by a comma. An override replaces the entry it matches, under
 * the override's own spelling.
 */
export function mergeHeaders(
  base: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  const overriddenNames = new Set(
    Object.keys(overrides).map((name) => name.toLowerCase()),
  );
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (!overriddenNames.has(name.toLowerCase())) {
      merged[name] = value;
    }
  }
  return {...merged, ...overrides};
}
