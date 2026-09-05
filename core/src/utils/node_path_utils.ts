/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parsers for hierarchical workflow node paths.
 *
 * A node path is a sequence of segments, each identifying one node instance in
 * the form `name@runId` or just `name`. adk-js joins segments with `.` (the
 * workflow engine's `${parent.nodePath}.${nodeName}`) while
 * `google/adk-python` joins them with `/`, so both separators are accepted.
 *
 * Mirrors `google/adk-python` `events/_node_path_builder.py`.
 */

/** Matches either separator between two path segments. */
const SEGMENT_SEPARATOR = /[./]/;

/** Separates a node name from its run id inside one segment. */
const RUN_ID_SEPARATOR = '@';

/** Splits a path into its segments; an empty or absent path has none. */
function segmentsOf(path?: string): string[] {
  return path ? path.split(SEGMENT_SEPARATOR) : [];
}

/**
 * Returns the run id of a segment, or `''` when it carries none.
 *
 * The split is at the last `@`, so a node name may itself contain one.
 */
function runIdOf(segment: string): string {
  const index = segment.lastIndexOf(RUN_ID_SEPARATOR);
  return index === -1 ? '' : segment.slice(index + 1);
}

/** Returns the last segment of `path`, or `''` when there is none. */
function leafOf(path?: string): string {
  const segments = segmentsOf(path);
  return segments.length === 0 ? '' : segments[segments.length - 1];
}

/** Returns the leaf node name of `path`, without its run id. */
export function nodeNameFromPath(path?: string): string {
  const leaf = leafOf(path);
  const index = leaf.lastIndexOf(RUN_ID_SEPARATOR);
  return index === -1 ? leaf : leaf.slice(0, index);
}

/** Returns the run id of the leaf segment of `path`, or `''` when absent. */
export function runIdFromPath(path?: string): string {
  return runIdOf(leafOf(path));
}

/**
 * Returns the run id of the segment before the leaf, or `undefined` when
 * `path` has a single segment or that segment carries no run id.
 */
export function parentRunIdFromPath(path?: string): string | undefined {
  const segments = segmentsOf(path);
  if (segments.length <= 1) {
    return undefined;
  }
  return runIdOf(segments[segments.length - 2]) || undefined;
}
