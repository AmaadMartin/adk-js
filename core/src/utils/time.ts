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

const defaultTimeProvider: TimeProvider = () => Date.now();

let timeProvider: TimeProvider = defaultTimeProvider;

/**
 * Installs `provider` as the source of time for every ADK timestamp.
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
 *
 * The value is whatever the provider returns; ADK neither validates nor
 * corrects it, and an exception thrown by a provider reaches the caller.
 */
export function getTime(): number {
  return timeProvider();
}
