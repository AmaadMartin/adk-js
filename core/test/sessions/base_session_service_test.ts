/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  applyStateDelta,
  applyTempState,
  BaseSessionService,
  createEvent,
  createEventActions,
  createSession,
  CreateSessionRequest,
  DeleteSessionRequest,
  extractStateDelta,
  GetSessionRequest,
  InputValidationError,
  ListSessionsResponse,
  NotImplementedError,
  Session,
  State,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  applyTempDeltaState,
  validateGetSessionConfig,
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

describe('BaseSessionService.getUserState', () => {
  it('rejects with a message naming the backend and the fallback', async () => {
    await expect(
      new StubSessionService().getUserState({appName: 'app', userId: 'u1'}),
    ).rejects.toThrow(
      /StubSessionService does not support getUserState.*listSessions/s,
    );
  });
});

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

  it('splits the state by scope and strips the prefixes', () => {
    const deltas = extractStateDelta({
      [`${State.APP_PREFIX}a`]: 'av',
      [`${State.USER_PREFIX}u`]: 'uv',
      [`${State.TEMP_PREFIX}t`]: 'tv',
      sk: 'sv',
    });

    expect(deltas.app).toEqual({a: 'av'});
    expect(deltas.user).toEqual({u: 'uv'});
    expect(deltas.session).toEqual({sk: 'sv'});
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

describe('applyStateDelta', () => {
  it('commits every non-temp entry', () => {
    const state: Record<string, unknown> = {existing: 'old'};

    applyStateDelta(state, {
      existing: 'new',
      added: 'v',
      [`${State.TEMP_PREFIX}t`]: 'tv',
    });

    expect(state).toEqual({existing: 'new', added: 'v'});
  });

  it('stores a __proto__ entry as an own property', () => {
    const state: Record<string, unknown> = {};

    applyStateDelta(state, parseBody('{"__proto__": {"isAdmin": true}}'));

    expect(Object.keys(state)).toEqual(['__proto__']);
    expect(new State(state).get('isAdmin')).toBeUndefined();
  });

  it('skips an entry a newer write already superseded', () => {
    const state: Record<string, unknown> = {};
    const delta: Record<string, unknown> = {attempts: 0};
    recordStateWrite(state, delta, 'attempts');
    state['attempts'] = 1;
    recordStateWrite(state, undefined, 'attempts');

    applyStateDelta(state, delta);

    expect(state['attempts']).toBe(1);
  });
});

describe('applyTempState', () => {
  it('copies only the temp entries onto the session state', () => {
    const session = createSession({id: 's1', appName: 'app'});
    const event = createEvent({
      actions: createEventActions({
        stateDelta: {
          [State.TEMP_PREFIX + 'draft']: 'in progress',
          'saved': 'yes',
        },
      }),
    });

    applyTempState({session, event});

    expect(session.state[State.TEMP_PREFIX + 'draft']).toBe('in progress');
    expect(session.state['saved']).toBeUndefined();
  });

  it('does nothing when the event carries no state delta', () => {
    const session = createSession({id: 's1', appName: 'app'});

    applyTempState({
      session,
      event: createEvent({actions: {stateDelta: undefined}}),
    });

    expect(session.state).toEqual({});
  });

  it('does nothing when the delta holds no temp entries', () => {
    const session = createSession({id: 's1', appName: 'app'});

    applyTempState({session, event: createEvent()});

    expect(session.state).toEqual({});
  });

  it('stores a temp __proto__ key without re-parenting the state', () => {
    const session = createSession({id: 's1', appName: 'app'});
    const event = createEvent({
      actions: createEventActions({
        stateDelta: {[State.TEMP_PREFIX + '__proto__']: {polluted: true}},
      }),
    });

    applyTempState({session, event});

    expect(session.state[State.TEMP_PREFIX + '__proto__']).toEqual({
      polluted: true,
    });
    expect({}).not.toHaveProperty('polluted');
  });
});

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
