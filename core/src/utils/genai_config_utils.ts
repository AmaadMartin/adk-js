/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, HttpOptions} from '@google/genai';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copies `httpOptions` far enough that nothing can write through it.
 *
 * Deliberately not a deep copy. The options can carry objects a caller supplies
 * so that the SDK uses that exact instance, such as a retry policy shared
 * between clients. Every mutable container is copied instead, because a
 * before-model callback receives the request config and can write into any of
 * them, and the source may be the caller's own `RunConfig`.
 *
 * @param httpOptions - The options to copy.
 * @returns A copy whose containers are not shared with `httpOptions`.
 */
export function copyHttpOptions(httpOptions: HttpOptions): HttpOptions {
  const copy: HttpOptions = {...httpOptions};
  if (httpOptions.headers) {
    copy.headers = {...httpOptions.headers};
  }
  if (httpOptions.extraBody) {
    copy.extraBody = {...httpOptions.extraBody};
  }
  if (httpOptions.retryOptions) {
    copy.retryOptions = {...httpOptions.retryOptions};
  }
  return copy;
}

/**
 * Copies the agent config fields that request assembly goes on to mutate.
 *
 * A spread is shallow, so every container the agent configured would still be
 * the agent's own object, and a write during assembly would outlive the
 * invocation and be seen by every later run of that agent.
 *
 * Every array and plain object is copied, not just the fields assembly happens
 * to touch today: a before-model callback receives the request config and can
 * append to any of them. The elements themselves are shared, because assembly
 * replaces entries rather than mutating them. Class instances are passed
 * through by reference — `responseSchema` may hold a Zod schema, which a spread
 * would destroy.
 *
 * @param config - The agent's own generation config.
 * @returns A copy whose containers are not shared with `config`.
 */
export function copyRequestScopedConfig(
  config: GenerateContentConfig,
): GenerateContentConfig {
  const copy: GenerateContentConfig = {...config};
  for (const [name, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      Reflect.set(copy, name, [...value]);
    } else if (isPlainObject(value)) {
      Reflect.set(copy, name, {...value});
    }
  }
  if (config.httpOptions) {
    copy.httpOptions = copyHttpOptions(config.httpOptions);
  }
  return copy;
}
