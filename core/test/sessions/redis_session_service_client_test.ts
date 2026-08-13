/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RedisSessionService} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

/** Records what the service asked node-redis to build, and how it drove it. */
const driver = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  errorListeners: [] as Array<(error: unknown) => void>,
  connectCount: 0,
  closeCount: 0,
}));

vi.mock('redis', () => ({
  createClient: (options: unknown) => {
    driver.clientOptions.push(options);
    const client = {
      on(event: string, listener: (error: unknown) => void) {
        if (event === 'error') {
          driver.errorListeners.push(listener);
        }
        return client;
      },
      async connect() {
        driver.connectCount++;
        return client;
      },
      async get() {
        return null;
      },
      async set() {
        return 'OK';
      },
      async del() {
        return 0;
      },
      async *scanIterator() {
        yield [] as string[];
      },
      async close() {
        driver.closeCount++;
      },
    };
    return client;
  },
}));

describe('RedisSessionService with its own client', () => {
  beforeEach(() => {
    driver.clientOptions.length = 0;
    driver.errorListeners.length = 0;
    driver.connectCount = 0;
    driver.closeCount = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the client from the uri and connects it', async () => {
    const service = new RedisSessionService({uri: 'redis://localhost:6379/0'});

    await service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'});

    expect(driver.clientOptions).toEqual([{url: 'redis://localhost:6379/0'}]);
    expect(driver.connectCount).toBe(1);
  });

  it('falls back to the default host, port and database', async () => {
    const service = new RedisSessionService();

    await service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'});

    expect(driver.clientOptions).toEqual([
      {
        socket: {host: 'localhost', port: 6379},
        password: undefined,
        database: 0,
      },
    ]);
  });

  it('enables TLS and forwards the discrete connection options', async () => {
    const service = new RedisSessionService({
      host: 'redis.example.com',
      port: 6380,
      password: 'placeholder',
      ssl: true,
      db: 2,
    });

    await service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'});

    expect(driver.clientOptions).toEqual([
      {
        socket: {host: 'redis.example.com', port: 6380, tls: true},
        password: 'placeholder',
        database: 2,
      },
    ]);
  });

  it('logs a client error against the host it was configured with', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const service = new RedisSessionService({host: 'redis.example.com'});
    await service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'});

    const failure = new Error('connection reset');
    driver.errorListeners[0](failure);

    expect(error).toHaveBeenCalledWith(
      'Redis client error for redis.example.com:6379:',
      failure,
    );
  });

  it('redacts the password before logging a client error', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const service = new RedisSessionService({
      uri: 'redis://admin:placeholder@localhost:6379/0',
    });
    await service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'});

    driver.errorListeners[0](new Error('connection reset'));

    const [message] = vi.mocked(error).mock.calls[0];
    expect(message).toBe(
      'Redis client error for redis://admin:***@localhost:6379/0:',
    );
  });

  it('connects once and reuses the client across calls', async () => {
    const service = new RedisSessionService({uri: 'redis://localhost:6379/0'});

    await Promise.all([
      service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'}),
      service.getSession({appName: 'app1', userId: 'u1', sessionId: 's2'}),
    ]);
    await service.deleteSession({
      appName: 'app1',
      userId: 'u1',
      sessionId: 's1',
    });

    expect(driver.connectCount).toBe(1);
    expect(driver.clientOptions).toHaveLength(1);
  });

  it('closes the client it opened, once', async () => {
    const service = new RedisSessionService({uri: 'redis://localhost:6379/0'});
    await service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'});

    await service.close();
    await service.close();

    expect(driver.closeCount).toBe(1);
  });
});
