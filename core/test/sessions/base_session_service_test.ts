/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  createEvent,
  createSession,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsResponse,
  Session,
  State,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  applyTempDeltaState,
  extractStateDelta,
} from '../../src/sessions/base_session_service.js';
import {recordStateWrite} from '../../src/sessions/state_write_order.js';

// A `'__proto__': value` pair in an object literal invokes the prototype
// setter instead of creating an own key, so it cannot express what an attacker
// actually sends. `JSON.parse` is what the dev server does with a request
// body, and it does produce an own `__proto__` key.
const parseBody = (json: string): Record<string, unknown> =>
  JSON.parse(json) as Record<string, unknown>;

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

describe('extractStateDelta', () => {
  it('splits a delta by scope and strips the scope prefixes', () => {
    const delta = extractStateDelta({
      [State.APP_PREFIX + 'theme']: 'dark',
      [State.USER_PREFIX + 'lang']: 'fr',
      [State.TEMP_PREFIX + 'draft']: 'skip me',
      'turnCount': 3,
    });

    expect(delta.app).toEqual({theme: 'dark'});
    expect(delta.user).toEqual({lang: 'fr'});
    expect(delta.session).toEqual({turnCount: 3});
  });

  it('returns three empty maps for an empty delta', () => {
    const delta = extractStateDelta({});

    expect(delta.app).toEqual({});
    expect(delta.user).toEqual({});
    expect(delta.session).toEqual({});
  });

  it('strips only the leading prefix', () => {
    const deltas = extractStateDelta({
      [`${State.APP_PREFIX}x${State.APP_PREFIX}y`]: 'v',
    });

    expect(deltas.app).toEqual({[`x${State.APP_PREFIX}y`]: 'v'});
  });

  it('stores a __proto__ key without re-parenting the map', () => {
    const delta = extractStateDelta({
      [State.APP_PREFIX + '__proto__']: {polluted: true},
    });

    expect(Object.keys(delta.app)).toEqual(['__proto__']);
    expect({}).not.toHaveProperty('polluted');
  });

  it('keeps a __proto__ key as an own property of its bucket', () => {
    const deltas = extractStateDelta(
      parseBody(`{"${State.USER_PREFIX}__proto__": {"isAdmin": true}}`),
    );

    expect(Object.keys(deltas.user)).toEqual(['__proto__']);
    expect(deltas.user['__proto__']).toEqual({isAdmin: true});
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

describe('BaseSessionService', () => {
  let service: StubSessionService;

  beforeEach(() => {
    service = new StubSessionService();
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
});
