/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {recordStateWrite} from './state_write_order.js';

/**
 * Stores `key` on `target` as an own data property.
 *
 * Plain assignment reaches an inherited setter, and on an
 * `Object.prototype`-parented map the key `__proto__` therefore re-parents the
 * map instead of storing the entry: the map's prototype becomes
 * caller-controlled and the entry is lost. `defineProperty` always creates an
 * own property.
 *
 * Exported for the session services, which apply a committed delta to
 * `session.state` and need the same guarantee. `common.ts` re-exports `State`
 * by name, so this stays internal to the package.
 */
export function defineStateEntry(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * A state mapping that maintains the current value and the pending-commit
 * delta.
 */
export class State {
  static readonly APP_PREFIX = 'app:';
  static readonly USER_PREFIX = 'user:';
  static readonly TEMP_PREFIX = 'temp:';

  // The null-prototype defaults are belt and braces: the read and write paths
  // below are already prototype-safe on a plain `{}`, and a caller-supplied map
  // keeps whatever prototype the caller gave it.
  constructor(
    /** The current value of the state. */
    private value: Record<string, unknown> = Object.create(null),
    /** The delta change to the current value that hasn't been committed. */
    private delta: Record<string, unknown> = Object.create(null),
  ) {}

  /**
   * Returns the value of the state dict for the given key.
   *
   * @param key The key to get the value for.
   * @param defaultValue The default value to return if the key is not found.
   * @return The value of the state for the given key, or the default value if
   *     not found.
   */
  get<T>(key: string, defaultValue?: T): T | undefined {
    // `hasOwn`, because a caller may name a state key `constructor`, which a
    // bare lookup would resolve off Object.prototype.
    if (Object.hasOwn(this.delta, key)) {
      return this.delta[key] as T;
    }

    if (Object.hasOwn(this.value, key)) {
      return this.value[key] as T;
    }

    return defaultValue;
  }

  /**
   * Sets the value of the state dict for the given key.
   *
   * @param key The key to set the value for.
   * @param value The value to set.
   */
  set(key: string, value: unknown) {
    defineStateEntry(this.value, key, value);
    defineStateEntry(this.delta, key, value);
    // Stamp the write so that committing this delta later cannot roll the key
    // back over a newer write. See `state_write_order.ts`.
    recordStateWrite(this.value, this.delta, key);
  }

  /**
   * Whether the state has pending delta.
   */
  has(key: string): boolean {
    return Object.hasOwn(this.value, key) || Object.hasOwn(this.delta, key);
  }

  /**
   * Whether the state has pending delta.
   */
  hasDelta(): boolean {
    return Object.keys(this.delta).length > 0;
  }

  /**
   * Updates the state dict with the given delta.
   *
   * @param delta The delta to update the state with.
   */
  update(delta: Record<string, unknown>) {
    // This should be revised while working on the parallel tool execution.
    for (const [key, value] of Object.entries(delta)) {
      defineStateEntry(this.delta, key, value);
      defineStateEntry(this.value, key, value);
      recordStateWrite(this.value, this.delta, key);
    }
  }

  /**
   * Returns the state as a plain JSON object.
   */
  toRecord(): Record<string, unknown> {
    return {...this.value, ...this.delta};
  }
}
