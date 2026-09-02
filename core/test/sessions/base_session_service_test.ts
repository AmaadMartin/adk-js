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
  extractStateDelta,
  ListSessionsResponse,
  Session,
  State,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {recordStateWrite} from '../../src/sessions/state_write_order.js';

// A `'__proto__': value` pair in an object literal invokes the prototype
// setter instead of creating an own key, so it cannot express what an attacker
// actually sends. `JSON.parse` is what the dev server does with a request
// body, and it does produce an own `__proto__` key.
const parseBody = (json: string): Record<string, unknown> =>
  JSON.parse(json) as Record<string, unknown>;

/** A backend that implements only the four abstract methods. */
class StubSessionService extends BaseSessionService {
  async createSession(): Promise<Session> {
    return createSession({id: 's1', appName: 'app'});
  }

  async getSession(): Promise<Session | undefined> {
    return undefined;
  }

  async listSessions(): Promise<ListSessionsResponse> {
    return {sessions: [], page: 1, limit: 0, totalItems: 0, totalPages: 0};
  }

  async deleteSession(): Promise<void> {}
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
