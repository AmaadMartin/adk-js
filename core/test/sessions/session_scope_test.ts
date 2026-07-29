/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CompositeSessionKey,
  CreateSessionRequest,
  CreateSessionScope,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  SessionScope,
  UserScope,
} from '@google/adk';
import {InMemorySessionService} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

describe('session scopes', () => {
  const userScope: UserScope = {appName: 'app', userId: 'user'};
  const sessionScope: SessionScope = {...userScope, sessionId: 'session'};

  let service: InMemorySessionService;

  beforeEach(() => {
    service = new InMemorySessionService();
  });

  describe('type identity with the session service request types', () => {
    it('CompositeSessionKey and SessionScope are the same shape', () => {
      const key: CompositeSessionKey = sessionScope;
      const scope: SessionScope = key;

      expect(scope).toEqual(sessionScope);
    });

    it('CreateSessionRequest is a CreateSessionScope', () => {
      const request: CreateSessionRequest = {
        ...userScope,
        sessionId: 'session',
        state: {key: 'value'},
      };
      const scope: CreateSessionScope = request;

      expect(scope).toEqual({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        state: {key: 'value'},
      });
    });

    it('GetSessionRequest is a SessionScope', () => {
      const request: GetSessionRequest = {
        ...sessionScope,
        config: {numRecentEvents: 1},
      };
      const scope: SessionScope = request;

      expect(scope.appName).toBe('app');
      expect(scope.userId).toBe('user');
      expect(scope.sessionId).toBe('session');
    });

    it('DeleteSessionRequest is a SessionScope', () => {
      const request: DeleteSessionRequest = sessionScope;
      const scope: SessionScope = request;

      expect(scope).toEqual(sessionScope);
    });

    it('ListSessionsRequest is a UserScope', () => {
      const request: ListSessionsRequest = {...userScope, limit: 10};
      const scope: UserScope = request;

      expect(scope.appName).toBe('app');
      expect(scope.userId).toBe('user');
    });
  });

  describe('use as session service parameters', () => {
    it('creates, reads, lists and deletes a session addressed by scope', async () => {
      const createScope: CreateSessionScope = {
        ...userScope,
        sessionId: 'session',
      };
      const created = await service.createSession(createScope);
      expect(created.id).toBe('session');

      expect(await service.getSession(sessionScope)).toBeDefined();

      const listed = await service.listSessions(userScope);
      expect(listed.sessions.map((session) => session.id)).toEqual(['session']);

      await service.deleteSession(sessionScope);
      expect(await service.getSession(sessionScope)).toBeUndefined();
    });

    it('generates a session id when CreateSessionScope omits it', async () => {
      const createScope: CreateSessionScope = userScope;

      const created = await service.createSession(createScope);

      expect(created.id).toBeTruthy();
      expect(created.appName).toBe('app');
      expect(created.userId).toBe('user');
    });
  });
});
