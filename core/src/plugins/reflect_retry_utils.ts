/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Response-type marker written into synthesized reflect-and-retry payloads so
 * downstream consumers can recognize (and skip re-processing) an error that has
 * already been handled by a reflect-and-retry plugin.
 */
export const REFLECT_AND_RETRY_RESPONSE_TYPE =
  'ERROR_HANDLED_BY_REFLECT_AND_RETRY_PLUGIN';

/**
 * Scope key used to track failures shared across all invocations when
 * {@link TrackingScope.GLOBAL} is selected.
 */
export const GLOBAL_SCOPE_KEY = '__global_reflect_and_retry_scope__';

/**
 * Defines the lifecycle scope for tracking consecutive failure counts.
 */
export enum TrackingScope {
  /** Failures are tracked independently per invocation. */
  INVOCATION = 'invocation',
  /** Failures are tracked globally across all invocations. */
  GLOBAL = 'global',
}

/**
 * Resolves the scope key used to bucket failure counters.
 *
 * @param scope The tracking scope.
 * @param invocationId The current invocation id, required for
 *     {@link TrackingScope.INVOCATION}.
 * @returns The resolved scope key.
 */
export function resolveScopeKey(
  scope: TrackingScope,
  invocationId: string | undefined,
): string {
  if (scope === TrackingScope.INVOCATION) {
    if (!invocationId) {
      throw new Error('invocationId must be provided for INVOCATION scope');
    }
    return invocationId;
  }
  if (scope === TrackingScope.GLOBAL) {
    return GLOBAL_SCOPE_KEY;
  }
  throw new Error(`Unknown scope: ${scope}`);
}

/**
 * Tracks consecutive failure counts per item (e.g. tool or model name) within a
 * scope key.
 *
 * Read-modify-write is synchronous under the single-threaded event loop, so no
 * explicit mutex is required. Methods stay `async` to preserve the call shape of
 * the Python reference and to allow adding a lock later without signature churn.
 */
export class ScopedFailureTracker {
  private readonly scopedFailureCounters = new Map<
    string,
    Map<string, number>
  >();

  /**
   * Increments and returns the consecutive-failure count for `itemName` within
   * `scopeKey`.
   */
  async increment(scopeKey: string, itemName: string): Promise<number> {
    let counter = this.scopedFailureCounters.get(scopeKey);
    if (!counter) {
      counter = new Map<string, number>();
      this.scopedFailureCounters.set(scopeKey, counter);
    }
    const current = (counter.get(itemName) ?? 0) + 1;
    counter.set(itemName, current);
    return current;
  }

  /**
   * Resets the failure count for `itemName` within `scopeKey` and cleans up the
   * scope entry when it becomes empty.
   */
  async reset(scopeKey: string, itemName: string): Promise<void> {
    const counter = this.scopedFailureCounters.get(scopeKey);
    if (!counter) return;
    counter.delete(itemName);
    if (counter.size === 0) {
      this.scopedFailureCounters.delete(scopeKey);
    }
  }
}
