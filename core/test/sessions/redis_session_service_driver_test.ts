/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RedisSessionService} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

/**
 * Counts how often the service imports `redis`. The mock stands in for the
 * package being absent, which is the state of a consumer who never installed
 * the optional peer dependency.
 */
const {imports} = vi.hoisted(() => ({imports: {count: 0}}));

vi.mock('redis', () => {
  imports.count++;
  throw new Error("Cannot find package 'redis'");
});

describe('RedisSessionService driver loading', () => {
  it('does not import redis until a method needs a client', async () => {
    const service = new RedisSessionService({uri: 'redis://localhost:6379/0'});
    expect(imports.count).toBe(0);

    await expect(
      service.getSession({appName: 'app1', userId: 'u1', sessionId: 's1'}),
    ).rejects.toThrow();
    expect(imports.count).toBeGreaterThan(0);
  });

  it('explains how to install redis when the package is missing', async () => {
    const service = new RedisSessionService({uri: 'redis://localhost:6379/0'});

    await expect(
      service.createSession({appName: 'app1', userId: 'u1'}),
    ).rejects.toThrow(
      "RedisSessionService requires the 'redis' package. " +
        'Install it with: npm install redis',
    );
  });

  it('retries the connect after a failure instead of replaying it', async () => {
    const service = new RedisSessionService({uri: 'redis://localhost:6379/0'});

    await expect(
      service.deleteSession({appName: 'app1', userId: 'u1', sessionId: 's1'}),
    ).rejects.toThrow("RedisSessionService requires the 'redis' package.");
    await expect(
      service.deleteSession({appName: 'app1', userId: 'u1', sessionId: 's1'}),
    ).rejects.toThrow("RedisSessionService requires the 'redis' package.");

    await expect(service.close()).resolves.toBeUndefined();
  });
});
