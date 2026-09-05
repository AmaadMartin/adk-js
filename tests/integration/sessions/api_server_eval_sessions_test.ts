/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService, Session} from '@google/adk';
import {AdkApiClient, AdkApiServer} from '@google/adk-devtools';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const APP_NAME = 'my_agent';
const USER_ID = 'u1';
const EVAL_SESSION_ID = '___eval___session___run1';
const USER_SESSION_ID = 'chat1';

describe('Eval sessions over a running API server', () => {
  const sessionService = new InMemorySessionService();
  const server = new AdkApiServer({sessionService});
  let client: AdkApiClient;

  beforeAll(async () => {
    await server.start();
    client = new AdkApiClient({backendUrl: server.url});

    for (const sessionId of [EVAL_SESSION_ID, USER_SESSION_ID]) {
      await sessionService.createSession({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId,
      });
    }
  });

  afterAll(async () => {
    await server.stop();
  });

  it('serves only the user session to a real client', async () => {
    const sessions = await client.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(sessions.map((session) => session.id)).toEqual([USER_SESSION_ID]);
  });

  it('reports the count the session service stored', async () => {
    const response = await fetch(
      `${server.url}/apps/${APP_NAME}/users/${USER_ID}/sessions`,
    );
    const body = (await response.json()) as {
      sessions: Session[];
      page: number;
      totalItems: number;
    };

    expect(response.status).toBe(200);
    expect(body.page).toBe(1);
    expect(body.totalItems).toBe(2);
    expect(body.sessions).toHaveLength(1);
  });

  it('serves the eval session when it is asked for by id', async () => {
    const response = await fetch(
      `${server.url}/apps/${APP_NAME}/users/${USER_ID}/sessions/${EVAL_SESSION_ID}`,
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as Session).id).toBe(EVAL_SESSION_ID);
  });
});
