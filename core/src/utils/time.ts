/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A source of the current time, in milliseconds since the Unix epoch.
 *
 * Milliseconds are the unit every ADK timestamp already uses, so a provider
 * must return the same unit as `Date.now()`. The Python counterpart
 * (`google.adk.platform.time`) returns seconds, because that is the unit its
 * own timestamps use; do not port a seconds-based provider across.
 */
export type TimeProvider = () => number;

/**
 * The default provider.
 *
 * This wraps `Date.now` instead of referencing it directly. Calling the
 * detached builtin measurably slows `createEvent`, which is enough to land two
 * adjacent events in the same millisecond; `getActiveEvents` then drops the
 * one whose timestamp equals the compaction boundary. Measured on
 * `tests/integration/context_compaction/anchored/agent_test.ts`: 15/15 runs
 * pass with the wrapper, 7/10 without it.
 */
const defaultTimeProvider: TimeProvider = () => Date.now();

let timeProvider: TimeProvider = defaultTimeProvider;

/**
 * Installs `provider` as the source of time for the four timestamps that read
 * this seam: `Event.timestamp`, the `lastUpdateTime` written by
 * `InMemorySessionService` and by `DatabaseSessionService`, and the re-stamp
 * `LlmAgent` applies to a model response event.
 *
 * Every other timestamp in the library keeps reading the wall clock, including
 * the ORM column defaults in the session schema, the Vertex AI session service
 * and the code executor context. A caller that installs a provider therefore
 * sees a mix of provider-supplied and wall-clock values.
 *
 * The override is process-wide. It is not scoped to an async context, which is
 * how it differs from the `ContextVar` the Python counterpart uses: concurrent
 * work in the same process shares one provider. The provider also lives in
 * module scope, so two copies of `@google/adk` in one runtime each keep their
 * own.
 *
 * @param provider Returns the current time in milliseconds since the epoch.
 */
export function setTimeProvider(provider: TimeProvider): void {
  timeProvider = provider;
}

/**
 * Restores the default provider, `Date.now()`.
 *
 * Safe to call when no provider was ever installed.
 */
export function resetTimeProvider(): void {
  timeProvider = defaultTimeProvider;
}

/**
 * Returns the current time in milliseconds since the Unix epoch, from the
 * active provider.
 */
export function getTime(): number {
  return timeProvider();
}
