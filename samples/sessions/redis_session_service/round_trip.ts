/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RedisSessionService round trip against a live Redis instance.
 *
 * Creates a session carrying all four state scopes, appends two events, reads
 * the session back, lists the application's sessions, deletes it, and shows
 * the read coming back undefined.
 *
 * See ./README.md for how to run it.
 */

import {createEvent, getLogger, RedisSessionService} from '@google/adk';

const APP_NAME = 'redis_round_trip';
const USER_ID = 'user-123';
const KEY_PREFIX = 'adk:sample:';

const logger = getLogger();

async function roundTrip(uri: string): Promise<void> {
  const service = new RedisSessionService({uri, keyPrefix: KEY_PREFIX});
  try {
    const session = await service.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {
        'app:tier': 'gold',
        'user:locale': 'en-US',
        'temp:scratch': 'discarded',
        turn: 0,
      },
    });
    logger.info(`Created session ${session.id}`);
    logger.info(`  state: ${JSON.stringify(session.state)}`);

    for (const author of ['user', 'assistant']) {
      await service.appendEvent({
        session,
        event: createEvent({
          author,
          invocationId: 'inv-1',
          actions: {stateDelta: {turn: session.events.length + 1}},
        }),
      });
    }

    const loaded = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    logger.info(`Read it back with ${loaded?.events.length} events`);
    // `temp:scratch` is gone: temporary state is never persisted.
    logger.info(`  state: ${JSON.stringify(loaded?.state)}`);

    const listed = await service.listSessions({appName: APP_NAME});
    logger.info(
      `Listed ${listed.totalItems} session(s) for ${APP_NAME}: ` +
        listed.sessions.map((s) => s.id).join(', '),
    );

    await service.deleteSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    const afterDelete = await service.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    logger.info(`After delete, getSession returns ${String(afterDelete)}`);
  } finally {
    await service.close();
  }
}

const uri = process.env['REDIS_URL'];
if (uri === undefined || uri === '') {
  logger.info(
    'Set REDIS_URL to run this sample. For a throwaway local instance:\n' +
      '  docker run --rm -p 6379:6379 redis:7\n' +
      '  REDIS_URL=redis://localhost:6379/0 node round_trip.js',
  );
} else {
  roundTrip(uri).catch((err: unknown) => {
    logger.error(`The round trip failed: ${String(err)}`);
    process.exitCode = 1;
  });
}
