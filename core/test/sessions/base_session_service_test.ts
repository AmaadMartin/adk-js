/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  InputValidationError,
  ListSessionsResponse,
  NotImplementedError,
  Session,
  createEvent,
  createSession,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  applyTempDeltaState,
  validateGetSessionConfig,
} from '../../src/sessions/base_session_service.js';
import {recordStateWrite} from '../../src/sessions/state_write_order.js';

/** A concrete service that adds nothing, so the base defaults are observable. */
class StubSessionService extends BaseSessionService {
  async createSession({
    appName,
    userId,
    sessionId,
    state,
  }: CreateSessionRequest): Promise<Session> {
    return createSession({
      id: sessionId ?? 'stub-session',
      appName,
      userId,
      state,
    });
  }

  async getSession(_request: GetSessionRequest): Promise<Session | undefined> {
    return undefined;
  }

  async listSessions(): Promise<ListSessionsResponse> {
    return {sessions: [], page: 1, limit: 0, totalItems: 0, totalPages: 0};
  }

  async deleteSession(_request: DeleteSessionRequest): Promise<void> {}
}

function newSession(state: Record<string, unknown> = {}): Session {
  return createSession({
    id: 'session-1',
    appName: 'app',
    userId: 'user',
    state,
  });
}

describe('BaseSessionService', () => {
  let service: StubSessionService;

  beforeEach(() => {
    service = new StubSessionService();
  });

  describe('getUserState', () => {
    it('rejects with NotImplementedError by default', async () => {
      await expect(
        service.getUserState({appName: 'app', userId: 'user'}),
      ).rejects.toBeInstanceOf(NotImplementedError);
    });

    it('names the concrete class and the workaround', async () => {
      await expect(
        service.getUserState({appName: 'app', userId: 'user'}),
      ).rejects.toThrow(
        /StubSessionService does not support getUserState.*listSessions.*getSession/s,
      );
    });
  });

  describe('flush', () => {
    it('resolves to undefined by default', async () => {
      await expect(service.flush()).resolves.toBeUndefined();
    });
  });

  describe('appendEvent', () => {
    it('keeps temp state on the session and out of the delta', async () => {
      const session = newSession();
      const event = createEvent({
        author: 'agent',
        actions: {stateDelta: {'temp:k1': 'v1', sk: 'v2'}},
      });

      const appended = await service.appendEvent({session, event});

      expect(session.state['temp:k1']).toBe('v1');
      expect(session.state['sk']).toBe('v2');
      expect(appended.actions.stateDelta).not.toHaveProperty('temp:k1');
      expect(appended.actions.stateDelta['sk']).toBe('v2');
    });

    it('makes temp state readable by a later event in the invocation', async () => {
      const session = newSession();

      await service.appendEvent({
        session,
        event: createEvent({
          author: 'first',
          actions: {stateDelta: {'temp:output': 'draft'}},
        }),
      });

      expect(session.state['temp:output']).toBe('draft');

      await service.appendEvent({
        session,
        event: createEvent({author: 'second'}),
      });

      expect(session.state['temp:output']).toBe('draft');
    });

    it('applies no temp state for a partial event', async () => {
      const session = newSession();
      const event = createEvent({
        author: 'agent',
        partial: true,
        actions: {stateDelta: {'temp:k1': 'v1'}},
      });

      await service.appendEvent({session, event});

      expect(session.state).not.toHaveProperty('temp:k1');
      expect(session.events).toHaveLength(0);
    });

    it('accepts an event whose actions carry no state delta', async () => {
      const session = newSession();
      const event = createEvent({
        author: 'agent',
        actions: {stateDelta: undefined},
      });

      await expect(service.appendEvent({session, event})).resolves.toBe(event);
      expect(Object.keys(session.state)).toHaveLength(0);
    });
  });

  describe('applyTempDeltaState', () => {
    it('ignores keys without the temp prefix', () => {
      const session = newSession();
      const event = createEvent({
        author: 'agent',
        actions: {stateDelta: {sk: 'v2', 'user:name': 'Ada'}},
      });

      applyTempDeltaState(session, event);

      expect(Object.keys(session.state)).toHaveLength(0);
    });

    it('applies a temp key that no newer write has superseded', () => {
      const session = newSession();
      const stateDelta: Record<string, unknown> = {'temp:draft': 'first'};
      recordStateWrite(session.state, stateDelta, 'temp:draft');

      applyTempDeltaState(
        session,
        createEvent({author: 'agent', actions: {stateDelta}}),
      );

      expect(session.state['temp:draft']).toBe('first');
    });

    it('does not roll a temp key back to an older write', () => {
      const session = newSession();
      const stateDelta: Record<string, unknown> = {'temp:draft': 'first'};
      recordStateWrite(session.state, stateDelta, 'temp:draft');

      session.state['temp:draft'] = 'second';
      recordStateWrite(session.state, undefined, 'temp:draft');

      applyTempDeltaState(
        session,
        createEvent({author: 'agent', actions: {stateDelta}}),
      );

      expect(session.state['temp:draft']).toBe('second');
    });

    it('does nothing when the event carries no state delta', () => {
      const session = newSession();
      const event = createEvent({
        author: 'agent',
        actions: {stateDelta: undefined},
      });

      expect(() => applyTempDeltaState(session, event)).not.toThrow();
      expect(Object.keys(session.state)).toHaveLength(0);
    });
  });

  describe('validateGetSessionConfig', () => {
    it('rejects a negative numRecentEvents', () => {
      expect(() => validateGetSessionConfig({numRecentEvents: -1})).toThrow(
        InputValidationError,
      );
      expect(() => validateGetSessionConfig({numRecentEvents: -1})).toThrow(
        /greater than or equal to 0/,
      );
    });

    it('accepts an omitted, empty, zero or positive configuration', () => {
      expect(() => validateGetSessionConfig()).not.toThrow();
      expect(() => validateGetSessionConfig({})).not.toThrow();
      expect(() =>
        validateGetSessionConfig({numRecentEvents: 0}),
      ).not.toThrow();
      expect(() =>
        validateGetSessionConfig({numRecentEvents: 5}),
      ).not.toThrow();
      expect(() => validateGetSessionConfig({afterTimestamp: 1})).not.toThrow();
    });
  });
});
