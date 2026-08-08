/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CreateSessionRequest,
  DatabaseSessionService,
  InMemorySessionService,
} from '@google/adk';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'shared-session';

const request: CreateSessionRequest = {
  appName: APP_NAME,
  userId: USER_ID,
  sessionId: SESSION_ID,
};

describe('getOrCreateSession with InMemorySessionService', () => {
  let service: InMemorySessionService;

  beforeEach(() => {
    service = new InMemorySessionService();
  });

  it('resolves two concurrent calls for the same id to one session', async () => {
    const [first, second] = await Promise.all([
      service.getOrCreateSession(request),
      service.getOrCreateSession(request),
    ]);

    expect(first.id).toBe(SESSION_ID);
    expect(second.id).toBe(SESSION_ID);

    const listed = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });
    expect(listed.sessions).toHaveLength(1);
  });

  it('returns the existing session without creating a second one', async () => {
    const created = await service.createSession(request);

    const fetched = await service.getOrCreateSession(request);

    expect(fetched.id).toBe(created.id);
    const listed = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });
    expect(listed.sessions).toHaveLength(1);
  });

  it('creates a session when no session id is given', async () => {
    const created = await service.getOrCreateSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    expect(created.id).not.toBe('');
  });
});

describe('getOrCreateSession with DatabaseSessionService', () => {
  let service: DatabaseSessionService;

  beforeEach(async () => {
    service = new DatabaseSessionService({
      dbName: ':memory:',
      driver: SqliteDriver,
      allowGlobalContext: true, // simplified for tests
    });
    await service.init();
  });

  afterEach(async () => {
    await service.close();
  });

  it('resolves two concurrent calls for the same id to one session', async () => {
    const [first, second] = await Promise.all([
      service.getOrCreateSession(request),
      service.getOrCreateSession(request),
    ]);

    expect(first.id).toBe(SESSION_ID);
    expect(second.id).toBe(SESSION_ID);

    const listed = await service.listSessions({
      appName: APP_NAME,
      userId: USER_ID,
    });
    expect(listed.totalItems).toBe(1);
  });
});

describe('getOrCreateSession when createSession fails', () => {
  let service: InMemorySessionService;

  beforeEach(() => {
    service = new InMemorySessionService();
  });

  it('returns the session created by the winner of the race', async () => {
    const create = service.createSession.bind(service);
    let creates = 0;
    vi.spyOn(service, 'createSession').mockImplementation(async (req) => {
      if (creates++ > 0) {
        throw new Error(`Session with id ${req.sessionId} already exists.`);
      }
      return create(req);
    });

    const [first, second] = await Promise.all([
      service.getOrCreateSession(request),
      service.getOrCreateSession(request),
    ]);

    expect(first.id).toBe(SESSION_ID);
    expect(second.id).toBe(SESSION_ID);
  });

  it('rethrows the original error when the session still does not exist', async () => {
    vi.spyOn(service, 'createSession').mockRejectedValue(new Error('boom'));
    const getSession = vi.spyOn(service, 'getSession');

    await expect(service.getOrCreateSession(request)).rejects.toThrow('boom');

    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
