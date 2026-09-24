/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {State} from '../../sessions/state.js';

/** Counter key body for `load_skill_resource` misses. */
export const RESOURCE_NOT_FOUND_COUNTER_PREFIX =
  '_adk_skill_resource_not_found_count_';

/** Counter key body for `run_skill_script` misses. */
export const SCRIPT_NOT_FOUND_COUNTER_PREFIX =
  '_adk_skill_script_not_found_count_';

/**
 * Records one lookup failure for the current invocation and returns the
 * running total.
 *
 * The count is deliberately path-agnostic: it counts every miss in the
 * invocation, so the guard still fires when the model invents a different
 * path on each retry. The `temp:` prefix keeps the count out of durable
 * session storage, and the invocation id isolates in-memory backends.
 */
export function countInvocationFailure(
  toolContext: Context,
  keyPrefix: string,
): number {
  const key = `${State.TEMP_PREFIX}${keyPrefix}${toolContext.invocationId}`;
  const failCount = Number(toolContext.state.get(key) ?? 0) + 1;
  toolContext.state.set(key, failCount);
  return failCount;
}
