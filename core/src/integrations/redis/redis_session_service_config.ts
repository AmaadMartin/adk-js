/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Seven days, the default lifetime of a session key. */
const SEVEN_DAYS_IN_SECONDS = 604800;

/**
 * Connection and storage settings for a Redis-backed session service.
 *
 * The field set and the defaults match `google/adk-python`
 * (`src/google/adk/integrations/redis/_config.py`), so both runtimes address
 * the same keys when they share a Redis instance.
 */
export interface RedisSessionServiceConfig {
  /**
   * Redis connection URI, for example `redis://[:password@]host:port/db`.
   *
   * A service that reads this config takes every connection setting from the
   * URI when it is present, and ignores `host`, `port`, `password`, `ssl` and
   * `db`.
   */
  uri?: string;
  /** Redis server hostname. Defaults to `localhost`. */
  host?: string;
  /** Redis server port. Defaults to `6379`. */
  port?: number;
  /** Password for Redis authentication. */
  password?: string;
  /** Whether to use SSL for Redis connections. Defaults to `false`. */
  ssl: boolean;
  /** Redis database index. Defaults to `0`. */
  db: number;
  /**
   * Lifetime of a session key in seconds. Defaults to `604800`, seven days.
   * A value of `0` or less disables expiry.
   */
  ttlSeconds: number;
  /** Prefix applied to every session key. Defaults to `adk:session:`. */
  keyPrefix: string;
}

/** The value of every field a caller does not supply. */
const DEFAULTS: RedisSessionServiceConfig = {
  host: 'localhost',
  port: 6379,
  ssl: false,
  db: 0,
  ttlSeconds: SEVEN_DAYS_IN_SECONDS,
  keyPrefix: 'adk:session:',
};

/**
 * Creates a {@link RedisSessionServiceConfig}, filling in the defaults.
 *
 * An optional field set to `undefined` stays absent, matching `host=None` in
 * the reference model. A required field falls back to its default instead, so
 * the returned object always carries the type it declares.
 *
 * @param params Optional partial {@link RedisSessionServiceConfig} overriding
 *     defaults.
 * @returns A merged {@link RedisSessionServiceConfig}. `params` is not
 *     modified.
 */
export function createRedisSessionServiceConfig(
  params: Partial<RedisSessionServiceConfig> = {},
): RedisSessionServiceConfig {
  return {
    ...DEFAULTS,
    ...params,
    ssl: params.ssl ?? DEFAULTS.ssl,
    db: params.db ?? DEFAULTS.db,
    ttlSeconds: params.ttlSeconds ?? DEFAULTS.ttlSeconds,
    keyPrefix: params.keyPrefix ?? DEFAULTS.keyPrefix,
  };
}
