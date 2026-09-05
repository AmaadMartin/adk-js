/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sessions: a Firestore round trip
 *
 * Creates a session with all four state scopes, appends two events, re-reads
 * the session, lists the app's sessions, then deletes the session and shows
 * the read coming back empty.
 *
 * Against the Firestore emulator, which needs no credentials:
 *
 *   gcloud emulators firestore start --host-port=localhost:8080
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 \
 *     npx tsx samples/sessions/firestore_session_service/round_trip.ts
 *
 * Against a real project, set GOOGLE_CLOUD_PROJECT and have Application
 * Default Credentials in place. See the README in this directory.
 */

import {createEvent, FirestoreSessionService, getLogger} from '@google/adk';

const logger = getLogger();

const APP_NAME = 'firestore_round_trip';
const USER_ID = 'demo_user';

const SETUP_INSTRUCTIONS =
  'Set FIRESTORE_EMULATOR_HOST=localhost:8080 (gcloud emulators firestore ' +
  'start --host-port=localhost:8080) or GOOGLE_CLOUD_PROJECT with ' +
  'Application Default Credentials, then run this sample again.';

async function main(): Promise<void> {
  if (
    !process.env.FIRESTORE_EMULATOR_HOST &&
    !process.env.GOOGLE_CLOUD_PROJECT
  ) {
    logger.info(SETUP_INSTRUCTIONS);
    return;
  }

  const service = new FirestoreSessionService();

  const session = await service.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    state: {
      'app:tier': 'gold',
      'user:locale': 'en-US',
      'temp:scratch': 'dropped before the write',
      turn: 0,
    },
  });
  logger.info(
    `created session ${session.id} at revision ` +
      `${session.storageUpdateMarker}`,
  );

  for (const turn of [1, 2]) {
    await service.appendEvent({
      session,
      event: createEvent({
        author: 'user',
        invocationId: `inv-${turn}`,
        state: {turn},
      }),
    });
  }
  logger.info(
    `appended 2 events, now at revision ${session.storageUpdateMarker}`,
  );

  const reloaded = await service.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: session.id,
  });
  logger.info(`reloaded ${reloaded?.events.length} events`);
  logger.info(`merged state ${JSON.stringify(reloaded?.state)}`);

  const userState = await service.getUserState({
    appName: APP_NAME,
    userId: USER_ID,
  });
  logger.info(`user state ${JSON.stringify(userState)}`);

  const listed = await service.listSessions({appName: APP_NAME});
  logger.info(
    `listed ${listed.totalItems} session(s) over ` +
      `${listed.totalPages} page(s)`,
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
  logger.info(`after delete the session reads back as ${afterDelete}`);
}

await main();
