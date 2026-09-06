/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  createRedisSessionServiceConfig,
  type RedisSessionServiceConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * Builds params the way an untyped caller does, so the runtime type checks
 * are reachable from TypeScript without a cast.
 */
function untypedParams(
  field: string,
  value: unknown,
): Partial<RedisSessionServiceConfig> {
  const params: Partial<RedisSessionServiceConfig> = {};
  Object.assign(params, {[field]: value});
  return params;
}

describe('createRedisSessionServiceConfig', () => {
  it('returns the reference defaults when called with no argument', () => {
    const config = createRedisSessionServiceConfig();

    expect(config).toStrictEqual({
      host: 'localhost',
      port: 6379,
      ssl: false,
      db: 0,
      ttlSeconds: 604800,
      keyPrefix: 'adk:session:',
    });
    expect('uri' in config).toBe(false);
    expect('password' in config).toBe(false);
  });

  it('overrides every default with the supplied value', () => {
    const config = createRedisSessionServiceConfig({
      uri: 'rediss://cache.example.com:6379/1',
      host: 'cache.example.com',
      port: 6380,
      password: 'secret',
      ssl: true,
      db: 3,
      ttlSeconds: 3600,
      keyPrefix: 'myapp:sessions:',
    });

    expect(config.uri).toBe('rediss://cache.example.com:6379/1');
    expect(config.host).toBe('cache.example.com');
    expect(config.port).toBe(6380);
    expect(config.password).toBe('secret');
    expect(config.ssl).toBe(true);
    expect(config.db).toBe(3);
    expect(config.ttlSeconds).toBe(3600);
    expect(config.keyPrefix).toBe('myapp:sessions:');
  });

  it('accepts a ttlSeconds of 0 or less, which disables expiry', () => {
    expect(createRedisSessionServiceConfig({ttlSeconds: 0}).ttlSeconds).toBe(0);
    expect(createRedisSessionServiceConfig({ttlSeconds: -1}).ttlSeconds).toBe(
      -1,
    );
  });

  it('preserves a falsy db and port instead of restoring the default', () => {
    const config = createRedisSessionServiceConfig({db: 0, port: 0});

    expect(config.db).toBe(0);
    expect(config.port).toBe(0);
  });

  it('leaves an explicitly undefined optional field absent', () => {
    const config = createRedisSessionServiceConfig({
      host: undefined,
      port: undefined,
    });

    expect(config.host).toBeUndefined();
    expect(config.port).toBeUndefined();
  });

  it('drops an unknown key without throwing', () => {
    const config = createRedisSessionServiceConfig(
      untypedParams('unknownKey', 'ignored'),
    );

    expect(config).toStrictEqual(createRedisSessionServiceConfig());
  });

  it('does not modify params and returns a new object', () => {
    const params: Partial<RedisSessionServiceConfig> = {db: 2};

    const config = createRedisSessionServiceConfig(params);

    expect(params).toStrictEqual({db: 2});
    expect(config).not.toBe(params);
  });

  it.each([
    ['uri', 123, 'uri must be a string, received number.'],
    ['host', null, 'host must be a string, received null.'],
    ['password', true, 'password must be a string, received boolean.'],
    ['keyPrefix', 7, 'keyPrefix must be a string, received number.'],
    ['keyPrefix', undefined, 'keyPrefix must be a string, received undefined.'],
    ['ssl', 'yes', 'ssl must be a boolean, received string.'],
    ['ssl', undefined, 'ssl must be a boolean, received undefined.'],
    ['db', '3', 'db must be an integer, received string.'],
    ['db', undefined, 'db must be an integer, received undefined.'],
    ['port', '6379', 'port must be an integer, received string.'],
    [
      'ttlSeconds',
      undefined,
      'ttlSeconds must be an integer, received undefined.',
    ],
  ])('rejects a %s of the wrong type', (field, value, message) => {
    expect(() =>
      createRedisSessionServiceConfig(untypedParams(field, value)),
    ).toThrow(InputValidationError);
    expect(() =>
      createRedisSessionServiceConfig(untypedParams(field, value)),
    ).toThrow(message);
  });

  it.each([
    ['port', 'port must be an integer, received number.'],
    ['db', 'db must be an integer, received number.'],
    ['ttlSeconds', 'ttlSeconds must be an integer, received number.'],
  ])('rejects a non-integer %s', (field, message) => {
    expect(() =>
      createRedisSessionServiceConfig(untypedParams(field, 3.5)),
    ).toThrow(message);
  });

  it('rejects NaN and Infinity as an integer', () => {
    expect(() =>
      createRedisSessionServiceConfig({ttlSeconds: Number.NaN}),
    ).toThrow(InputValidationError);
    expect(() =>
      createRedisSessionServiceConfig({ttlSeconds: Number.POSITIVE_INFINITY}),
    ).toThrow(InputValidationError);
  });

  it('never puts the password value in the error message', () => {
    expect(() =>
      createRedisSessionServiceConfig(untypedParams('password', ['hunter2'])),
    ).toThrow('password must be a string, received object.');
  });
});
