/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createRedisSessionServiceConfig,
  type RedisSessionServiceConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

  it('preserves a falsy db, port and ssl instead of restoring the default', () => {
    const config = createRedisSessionServiceConfig({
      db: 0,
      port: 0,
      ssl: false,
    });

    expect(config.db).toBe(0);
    expect(config.port).toBe(0);
    expect(config.ssl).toBe(false);
  });

  it('leaves an explicitly undefined optional field absent', () => {
    const config = createRedisSessionServiceConfig({
      uri: undefined,
      host: undefined,
      port: undefined,
      password: undefined,
    });

    expect(config.uri).toBeUndefined();
    expect(config.host).toBeUndefined();
    expect(config.port).toBeUndefined();
    expect(config.password).toBeUndefined();
  });

  it('restores the default for an explicitly undefined required field', () => {
    const config = createRedisSessionServiceConfig({
      ssl: undefined,
      db: undefined,
      ttlSeconds: undefined,
      keyPrefix: undefined,
    });

    expect(config.ssl).toBe(false);
    expect(config.db).toBe(0);
    expect(config.ttlSeconds).toBe(604800);
    expect(config.keyPrefix).toBe('adk:session:');
  });

  it('does not modify params and returns a new object', () => {
    const params: Partial<RedisSessionServiceConfig> = {db: 2};

    const config = createRedisSessionServiceConfig(params);

    expect(params).toStrictEqual({db: 2});
    expect(config).not.toBe(params);
  });
});
