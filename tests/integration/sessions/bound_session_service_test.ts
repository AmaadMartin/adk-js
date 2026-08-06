/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BoundSessionService,
  DatabaseSessionService,
  InMemorySessionService,
  createEvent,
  createEventActions,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

describe('BoundSessionService Integration Tests across Backends', () => {
  describe('InMemorySessionService', () => {
    let service: InMemorySessionService;

    beforeEach(() => {
      service = new InMemorySessionService();
    });

    it('persists state updates across independent service retrievals', async () => {
      const bound = await service.getOrBindSession({
        appName: 'integration-app',
        userId: 'user-1',
        sessionId: 'session-in-mem',
        state: {step: 0},
      });

      expect(bound.state).toEqual({step: 0});

      const event = createEvent({
        timestamp: Date.now(),
        actions: createEventActions({
          stateDelta: {step: 1, lastAction: 'init'},
        }),
      });

      await bound.appendEvent(event);
      expect(bound.state).toHaveProperty('step', 1);
      expect(bound.state).toHaveProperty('lastAction', 'init');

      // Independent retrieval via getOrBindSession on same sessionId
      const bound2 = await service.getOrBindSession({
        appName: 'integration-app',
        userId: 'user-1',
        sessionId: 'session-in-mem',
      });

      expect(bound2.state).toHaveProperty('step', 1);
      expect(bound2.state).toHaveProperty('lastAction', 'init');
      expect(bound2.events).toHaveLength(1);

      await bound.deleteSession();
      const check = await service.getSession({
        appName: 'integration-app',
        userId: 'user-1',
        sessionId: 'session-in-mem',
      });
      expect(check).toBeUndefined();
    });
  });

  describe('DatabaseSessionService', () => {
    let service: DatabaseSessionService;

    beforeEach(async () => {
      service = new DatabaseSessionService({
        dbName: ':memory:',
        driver: SqliteDriver,
        allowGlobalContext: true,
      });
      await service.init();
    });

    afterEach(async () => {
      const orm = (service as unknown as {orm: MikroORM}).orm;
      if (orm) {
        await orm.close();
      }
    });

    it('persists state updates and events across independent service retrievals', async () => {
      const bound: BoundSessionService = await service.getOrBindSession({
        appName: 'db-app',
        userId: 'db-user',
        sessionId: 'session-db',
        state: {counter: 10},
      });

      expect(bound.appName).toBe('db-app');
      expect(bound.userId).toBe('db-user');
      expect(bound.sessionId).toBe('session-db');
      expect(bound.state).toHaveProperty('counter', 10);

      const event1 = createEvent({
        timestamp: 1000,
        actions: createEventActions({
          stateDelta: {counter: 20, status: 'active'},
        }),
      });

      await bound.appendEvent(event1);
      expect(bound.state).toHaveProperty('counter', 20);
      expect(bound.state).toHaveProperty('status', 'active');
      expect(bound.events).toHaveLength(1);

      // Verify persistence via independent retrieval
      const boundAfter: BoundSessionService = await service.getOrBindSession({
        appName: 'db-app',
        userId: 'db-user',
        sessionId: 'session-db',
      });

      expect(boundAfter.state).toHaveProperty('counter', 20);
      expect(boundAfter.state).toHaveProperty('status', 'active');
      expect(boundAfter.events).toHaveLength(1);
      expect(boundAfter.events[0].id).toBe(event1.id);

      // Mutate via boundAfter and refresh via original bound
      const event2 = createEvent({
        timestamp: 2000,
        actions: createEventActions({
          stateDelta: {status: 'completed'},
        }),
      });
      await boundAfter.appendEvent(event2);

      await bound.getSession();
      expect(bound.state).toHaveProperty('status', 'completed');
      expect(bound.events).toHaveLength(2);

      await bound.deleteSession();
      const check = await service.getSession({
        appName: 'db-app',
        userId: 'db-user',
        sessionId: 'session-db',
      });
      expect(check).toBeUndefined();
    });
  });
});
