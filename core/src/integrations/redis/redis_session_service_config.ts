/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../../errors/input_validation_error.js';

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
 * Copies the known fields out of `params`.
 *
 * A key the caller supplies is copied even when its value is `undefined`, so
 * an explicit `{host: undefined}` clears the default instead of restoring it.
 * A key this config does not declare is dropped, which is what the reference
 * pydantic model does with an unknown field.
 */
function pickKnownFields(
  params: Partial<RedisSessionServiceConfig>,
): Partial<RedisSessionServiceConfig> {
  const known: Partial<RedisSessionServiceConfig> = {};
  if ('uri' in params) known.uri = params.uri;
  if ('host' in params) known.host = params.host;
  if ('port' in params) known.port = params.port;
  if ('password' in params) known.password = params.password;
  if ('ssl' in params) known.ssl = params.ssl;
  if ('db' in params) known.db = params.db;
  if ('ttlSeconds' in params) known.ttlSeconds = params.ttlSeconds;
  if ('keyPrefix' in params) known.keyPrefix = params.keyPrefix;
  return known;
}

/**
 * Reports the type of a rejected value.
 *
 * The value itself never appears in the message, because `password` holds a
 * credential and an error message reaches a log.
 */
function describeType(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function requireString(field: string, value: unknown): void {
  if (typeof value !== 'string') {
    throw new InputValidationError(
      `${field} must be a string, received ${describeType(value)}.`,
    );
  }
}

function requireInteger(field: string, value: unknown): void {
  if (!Number.isInteger(value)) {
    throw new InputValidationError(
      `${field} must be an integer, received ${describeType(value)}.`,
    );
  }
}

function requireBoolean(field: string, value: unknown): void {
  if (typeof value !== 'boolean') {
    throw new InputValidationError(
      `${field} must be a boolean, received ${describeType(value)}.`,
    );
  }
}

/**
 * Rejects a field whose value has the wrong type.
 *
 * `undefined` means "absent" for an optional field and passes. There is no
 * range check on any field: the reference model imposes none, and a
 * `ttlSeconds` of `0` or less is the documented way to disable expiry.
 */
function validate(config: RedisSessionServiceConfig): void {
  if (config.uri !== undefined) requireString('uri', config.uri);
  if (config.host !== undefined) requireString('host', config.host);
  if (config.port !== undefined) requireInteger('port', config.port);
  if (config.password !== undefined) requireString('password', config.password);
  requireBoolean('ssl', config.ssl);
  requireInteger('db', config.db);
  requireInteger('ttlSeconds', config.ttlSeconds);
  requireString('keyPrefix', config.keyPrefix);
}

/**
 * Creates a {@link RedisSessionServiceConfig}, filling in the defaults.
 *
 * @param params Optional overrides. Unknown keys are dropped.
 * @returns A new config. `params` is not modified.
 * @throws InputValidationError When a supplied field has the wrong type.
 */
export function createRedisSessionServiceConfig(
  params: Partial<RedisSessionServiceConfig> = {},
): RedisSessionServiceConfig {
  const config: RedisSessionServiceConfig = {
    ...DEFAULTS,
    ...pickKnownFields(params),
  };
  validate(config);
  return config;
}
