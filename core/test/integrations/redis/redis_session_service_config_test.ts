/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The configuration contract of `RedisSessionService`: the defaults it applies
 * to a setting the caller left out, and the caller's settings when they are
 * present.
 *
 * The field set and the defaults come from
 * `src/google/adk/integrations/redis/_config.py` at `google/adk-python` `main`.
 * They are what make an adk-js runner and an adk-python runner address the
 * same keys, so a default that drifts breaks the two runtimes apart.
 */

import {
  RedisSessionService,
  type RedisSessionServiceConfig,
  type RedisSessionServiceOptions,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {FakeRedis} from './fake_redis.js';

/** Seven days, adk-python's default lifetime for a key. */
const DEFAULT_TTL_SECONDS = 604800;

/**
 * Reads a configuration as constructor options.
 *
 * The signature is the point: this compiles only while the options stay the
 * configuration plus a client. A field that drifts out of
 * {@link RedisSessionServiceConfig} fails the typecheck here.
 */
function asOptions(
  config: RedisSessionServiceConfig,
): RedisSessionServiceOptions {
  return config;
}

/** Creates one session, and the app-state and user-state keys beside it. */
async function seed(service: RedisSessionService): Promise<void> {
  await service.createSession({
    appName: 'app1',
    userId: 'u1',
    sessionId: 's1',
    state: {'app:tier': 'gold', 'user:theme': 'dark', topic: 'weather'},
  });
}

describe('RedisSessionServiceConfig defaults', () => {
  it('writes every key under the default prefix', async () => {
    const client = new FakeRedis();
    await seed(new RedisSessionService({client}));

    expect(client.keys().sort()).toEqual([
      'adk:session:app1:u1:s1',
      'adk:session:app_state:app1',
      'adk:session:user_state:app1:u1',
    ]);
  });

  it('expires every key it writes after seven days', async () => {
    const client = new FakeRedis();
    await seed(new RedisSessionService({client}));

    const written = client.keys();
    expect(written).toHaveLength(3);
    for (const key of written) {
      expect(client.ttlOf(key)).toBe(DEFAULT_TTL_SECONDS);
    }
  });

  it('keeps a session until the default expiry passes', async () => {
    const client = new FakeRedis();
    const service = new RedisSessionService({client});
    await seed(service);
    const request = {appName: 'app1', userId: 'u1', sessionId: 's1'};

    client.advanceTime(DEFAULT_TTL_SECONDS - 1);
    expect(await service.getSession(request)).toBeDefined();

    client.advanceTime(1);
    expect(await service.getSession(request)).toBeUndefined();
  });

  it('takes the prefix and the expiry a caller supplies', async () => {
    const client = new FakeRedis();
    const options = asOptions({keyPrefix: 'other:', ttlSeconds: 60});
    await seed(new RedisSessionService({...options, client}));

    expect(client.keys().sort()).toEqual([
      'other:app1:u1:s1',
      'other:app_state:app1',
      'other:user_state:app1:u1',
    ]);
    expect(client.ttlOf('other:app1:u1:s1')).toBe(60);
  });
});
