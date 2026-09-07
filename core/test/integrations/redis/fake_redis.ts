/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory Redis double for `RedisSessionService` tests.
 *
 * Ported from `FakeRedisAsync` in
 * `tests/unittests/integrations/redis/test_redis_session_service.py` at
 * `google/adk-python` `main`.
 *
 * Two deliberate differences from the reference double:
 *
 * - `scanIterator` matches a real glob rather than the reference's
 *   `match.rstrip('*')` prefix, because adk-js escapes glob metacharacters in
 *   its scan pattern and a prefix match cannot tell an escaped `*` from a
 *   wildcard.
 * - The recorded expiry is read through {@link FakeRedis.ttlOf} rather than a
 *   private field, which two reference tests index into directly.
 */

import type {RedisClientLike} from '@google/adk';

/** Characters a Redis glob pattern treats as metacharacters. */
const GLOB_METACHARACTERS = /[.+^${}()|[\]\\*?]/g;

/**
 * Compiles a Redis glob pattern into a regular expression.
 *
 * Redis globs support `*`, `?` and `[...]`; a backslash escapes the next
 * character. Only the subset the session service produces is compiled here:
 * escaped literals, `*` and `?`.
 */
function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\' && i + 1 < pattern.length) {
      i++;
      source += pattern[i].replace(GLOB_METACHARACTERS, '\\$&');
    } else if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += char.replace(GLOB_METACHARACTERS, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** Everything the double remembers about one key. */
interface FakeEntry {
  value: string;
  /** The `EX` argument the write carried, or undefined when it carried none. */
  expiry: number | undefined;
  /** The double's clock reading when the key was written. */
  createdAt: number;
}

/** An in-memory {@link RedisClientLike} with a manually advanced clock. */
export class FakeRedis implements RedisClientLike {
  private readonly store = new Map<string, FakeEntry>();
  private currentTime = 0;
  /** Set by {@link close}, so a test can assert the service closed it. */
  closed = false;

  /** Moves the double's clock forward, expiring keys whose expiry has passed. */
  advanceTime(seconds: number): void {
    this.currentTime += seconds;
  }

  /** Returns the `EX` recorded for `key`, or undefined when it holds none. */
  ttlOf(key: string): number | undefined {
    return this.liveEntry(key)?.expiry;
  }

  /** Returns the stored value for `key` without going through `get`. */
  rawValue(key: string): string | undefined {
    return this.liveEntry(key)?.value;
  }

  /** Returns every live key, so a test can assert nothing was written. */
  keys(): string[] {
    return [...this.store.keys()].filter((key) => this.liveEntry(key));
  }

  /** Writes a value directly, bypassing the service, for corrupt-key tests. */
  seed(key: string, value: string): void {
    this.store.set(key, {
      value,
      expiry: undefined,
      createdAt: this.currentTime,
    });
  }

  async get(key: string): Promise<string | null> {
    return this.liveEntry(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: {EX?: number; NX?: boolean},
  ): Promise<unknown> {
    if (options?.NX && this.liveEntry(key)) {
      return null;
    }
    this.store.set(key, {
      value,
      expiry: options?.EX,
      createdAt: this.currentTime,
    });
    return 'OK';
  }

  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
  }

  async *scanIterator(options?: {
    MATCH?: string;
    COUNT?: number;
  }): AsyncGenerator<string[]> {
    const match = options?.MATCH;
    const pattern = match === undefined ? undefined : globToRegExp(match);
    // Real node-redis yields batches, and yielding one key per batch keeps the
    // service's flattening honest.
    for (const key of [...this.store.keys()]) {
      if (this.liveEntry(key) && (!pattern || pattern.test(key))) {
        yield [key];
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Returns the entry for `key`, dropping it first when its expiry passed. */
  private liveEntry(key: string): FakeEntry | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (
      entry.expiry !== undefined &&
      entry.expiry > 0 &&
      this.currentTime - entry.createdAt >= entry.expiry
    ) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }
}
