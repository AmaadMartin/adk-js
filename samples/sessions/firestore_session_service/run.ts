/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sessions: a round trip through Firestore
 *
 * Creates a session, appends two events, reads it back, lists it and deletes
 * it, against a real Firestore. Nothing is stubbed, so this is the end-to-end
 * proof that the service works against the actual client.
 *
 * Point it at the emulator, which needs no credentials and no project:
 *
 *   gcloud emulators firestore start --host-port=127.0.0.1:8080
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=demo-adk \
 *     npx tsx samples/sessions/firestore_session_service/run.ts
 *
 * Or at a real project, with application default credentials configured. See
 * the README in this directory.
 */

import {
  createEvent,
  FirestoreSessionService,
  getLogger,
  LogLevel,
  setLogLevel,
} from '@google/adk';
import {createUserContent} from '@google/genai';

const logger = getLogger();
setLogLevel(LogLevel.INFO);

const APP_NAME = 'firestore_sample';
const USER_ID = 'demo_user';

async function main(): Promise<void> {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
  if (!projectId) {
    throw new Error(
      'Set GOOGLE_CLOUD_PROJECT. Against the emulator any value works, ' +
        'as long as FIRESTORE_EMULATOR_HOST is set too.',
    );
  }

  const service = new FirestoreSessionService({settings: {projectId}});
  logger.info(`Using root collection "${service.rootCollection}".`);

  const session = await service.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    state: {'app:tier': 'pro', 'user:locale': 'en-GB', turn: 0},
  });
  logger.info(
    `Created session ${session.id} at revision ${session.storageUpdateMarker}.`,
  );

  await service.appendEvent({
    session,
    event: createEvent({
      author: 'user',
      content: createUserContent('What is the weather?'),
    }),
  });
  await service.appendEvent({
    session,
    event: createEvent({
      author: 'assistant',
      content: createUserContent('Sunny.'),
      actions: {stateDelta: {turn: 1}},
    }),
  });

  const reloaded = await service.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: session.id,
    config: {numRecentEvents: 20},
  });
  logger.info(
    `Read back ${reloaded?.events.length} events at revision ` +
      `${reloaded?.storageUpdateMarker}, state ${JSON.stringify(reloaded?.state)}.`,
  );

  const listed = await service.listSessions({
    appName: APP_NAME,
    userId: USER_ID,
  });
  logger.info(
    `Listed ${listed.totalItems} session(s) on page ${listed.page} of ` +
      `${listed.totalPages}.`,
  );

  // A second worker holding the copy from before the appends loses the race.
  const stale = await service.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: session.id,
  });
  if (stale) {
    stale.storageUpdateMarker = '0';
    const rejected = await service
      .appendEvent({session: stale, event: createEvent({author: 'user'})})
      .then(() => undefined)
      .catch((err: unknown) => (err as Error).name);
    logger.info(`A stale append was rejected with ${rejected}.`);
  }

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
  logger.info(`After delete, getSession returned ${String(afterDelete)}.`);
}

await main();
