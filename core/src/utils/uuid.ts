/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from './env_aware_utils.js';

/** A source of unique identifier strings. */
export type IdProvider = () => string;

/** The default provider, which keeps the library's existing UUID source. */
const defaultIdProvider: IdProvider = () => randomUUID();

let idProvider: IdProvider = defaultIdProvider;

/**
 * Installs `provider` as the source of the identifiers ADK mints for
 * invocations, client function calls, sessions and A2A messages, tasks and
 * artifacts.
 *
 * Every other identifier in the library keeps its own source, so a caller sees
 * a mix of provider-supplied and generated identifiers. The OAuth2 `state`
 * parameter deliberately stays off this seam, because a caller-supplied
 * provider carries no cryptographic guarantee.
 *
 * The override is process-wide. It is not scoped to an async context, which is
 * how it differs from the `ContextVar` the Python counterpart uses: concurrent
 * work in the same process shares one provider. The provider also lives in
 * module scope, so two copies of `@google/adk` in one runtime each keep their
 * own.
 *
 * @param provider Returns the identifier to use.
 */
export function setIdProvider(provider: IdProvider): void {
  idProvider = provider;
}

/**
 * Restores the default provider, `randomUUID()`.
 *
 * Safe to call when no provider was ever installed.
 */
export function resetIdProvider(): void {
  idProvider = defaultIdProvider;
}

/** Returns a unique identifier from the active provider. */
export function newUuid(): string {
  return idProvider();
}
