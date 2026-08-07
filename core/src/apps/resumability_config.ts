/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The configuration of resumability for an application or runner.
 *
 * The "resumability" in ADK refers to the ability to:
 * 1. pause an invocation upon a long-running function call.
 * 2. resume an invocation from the last event, if it's paused or failed midway
 * through.
 */
export interface ResumabilityConfig {
  /**
   * Whether the app/runner supports agent resumption.
   *
   * If enabled, resumption routing based on matching function responses is
   * active: a function response is routed back to the agent that issued the
   * matching function call.
   *
   * Defaults to {@link DEFAULT_IS_RESUMABLE}; set it to `false` to opt out.
   */
  isResumable: boolean;
}

/**
 * The default value of {@link ResumabilityConfig.isResumable}.
 *
 * Routing a function response back to the agent that issued the call predates
 * `ResumabilityConfig` and was previously unconditional, so it stays on when a
 * caller supplies no configuration. Disabling it is an explicit opt-in to the
 * new behaviour rather than something a caller can trip over by omission.
 *
 * This is the single source of truth for the default: both
 * {@link createResumabilityConfig} and the runner's routing gate read it, so
 * `new Runner({...})` with no config and `createResumabilityConfig()` cannot
 * drift apart.
 */
export const DEFAULT_IS_RESUMABLE = true;

/**
 * Creates a {@link ResumabilityConfig} with default values.
 *
 * @param params Optional partial {@link ResumabilityConfig} overriding defaults.
 * @returns A merged {@link ResumabilityConfig} object.
 */
export function createResumabilityConfig(
  params: Partial<ResumabilityConfig> = {},
): ResumabilityConfig {
  return {
    isResumable: DEFAULT_IS_RESUMABLE,
    ...params,
  };
}
