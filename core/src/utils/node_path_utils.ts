/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parses hierarchical workflow node paths.
 *
 * A node path is a sequence of segments, each identifying one node instance as
 * `name@runId` or as a bare `name`. `adk-js` joins segments with `.` and
 * `google/adk-python` joins them with `/`, so both separators are accepted: a
 * session written by a Python runner must still parse here.
 *
 * Mirrors `google/adk-python` `events/_node_path_builder.py`.
 */

const SEGMENT_SEPARATOR = /[./]/;

/** Splits a path into its segments; an absent or empty path has none. */
function segmentsOf(path?: string): string[] {
  return path ? path.split(SEGMENT_SEPARATOR) : [];
}

/**
 * Splits a segment into its node name and run id at the LAST `@`, so a node
 * name may itself contain one.
 */
function splitSegment(segment: string): {name: string; runId?: string} {
  const at = segment.lastIndexOf('@');
  if (at === -1) {
    return {name: segment};
  }
  return {name: segment.slice(0, at), runId: segment.slice(at + 1)};
}

/** Splits the leaf segment; an absent or empty path has an empty leaf. */
function leafOf(path?: string): {name: string; runId?: string} {
  const segments = segmentsOf(path);
  return splitSegment(segments[segments.length - 1] ?? '');
}

/**
 * Returns the leaf node's name, without its run id.
 *
 * @param path The node path, e.g. `wf@1/review@3` or `wf@1.review@3`.
 * @returns The leaf name, or `''` when there is no path.
 */
export function nodeNameFromPath(path?: string): string {
  return leafOf(path).name;
}

/**
 * Returns the leaf node's run id.
 *
 * @param path The node path.
 * @returns The leaf run id, or `''` when the leaf carries none.
 */
export function runIdFromPath(path?: string): string {
  return leafOf(path).runId ?? '';
}

/**
 * Returns the run id of the leaf's parent segment, which identifies the node
 * run that scheduled this one.
 *
 * @param path The node path.
 * @returns The parent run id, or `undefined` for a single-segment path or a
 *     parent segment that carries no run id.
 */
export function parentRunIdFromPath(path?: string): string | undefined {
  const segments = segmentsOf(path);
  if (segments.length <= 1) {
    return undefined;
  }
  return splitSegment(segments[segments.length - 2]).runId;
}
