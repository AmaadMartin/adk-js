/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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

  it('returns three empty maps for an empty delta', () => {
    const delta = extractStateDelta({});

    expect(delta.app).toEqual({});
    expect(delta.user).toEqual({});
    expect(delta.session).toEqual({});
  });

  it('stores a __proto__ key without re-parenting the map', () => {
    const delta = extractStateDelta({
      [State.APP_PREFIX + '__proto__']: {polluted: true},
    });

    expect(Object.keys(delta.app)).toEqual(['__proto__']);
    expect({}).not.toHaveProperty('polluted');
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
