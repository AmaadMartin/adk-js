/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  createSession,
  Event,
  Session,
} from '@google/adk';
import {AssertionError} from 'node:assert';
import {describe, expect, it} from 'vitest';
import {validateSession} from '../../src/integration/test_runner.js';

function session(
  state: Record<string, unknown> | undefined,
  events: Event[] = [],
): Session {
  return createSession({
    id: 'test-session',
    appName: 'test-runner',
    userId: 'test-user',
    state,
    events,
  });
}

function textEvent(text: string): Event {
  return createEvent({author: 'agent', content: {parts: [{text}]}});
}

describe('validateSession', () => {
  it('passes when the states match', () => {
    expect(() =>
      validateSession(session({locale: 'en-US'}), session({locale: 'en-US'})),
    ).not.toThrow();
  });

  it('fails when a user state value differs', () => {
    const run = () =>
      validateSession(session({locale: 'en-US'}), session({locale: 'fr-FR'}));

    expect(run).toThrow(AssertionError);
    expect(run).toThrow(/en-US/);
    expect(run).toThrow(/fr-FR/);
  });

  it('fails when the actual state has an extra key', () => {
    expect(() =>
      validateSession(
        session({locale: 'en-US', turnCount: 3}),
        session({locale: 'en-US'}),
      ),
    ).toThrow(AssertionError);
  });

  it('ignores the ADK bookkeeping keys on the actual side', () => {
    expect(() =>
      validateSession(
        session({
          locale: 'en-US',
          _adk_recordings_config: {mode: 'record'},
          _adk_replay_config: {mode: 'replay'},
        }),
        session({locale: 'en-US'}),
      ),
    ).not.toThrow();
  });

  it('ignores the ADK bookkeeping keys on the expected side', () => {
    expect(() =>
      validateSession(
        session({locale: 'en-US'}),
        session({
          locale: 'en-US',
          _adk_recordings_config: {mode: 'record'},
          _adk_replay_config: {mode: 'replay'},
        }),
      ),
    ).not.toThrow();
  });

  it('ignores id, lastUpdateTime, appName and userId', () => {
    // TestRunner.run() fabricates appName and userId, so they never match the
    // recorded session and must stay out of the comparison.
    const actual = createSession({
      id: 'live-session',
      appName: 'test-runner',
      userId: 'test-user',
      state: {locale: 'en-US'},
      lastUpdateTime: 200,
    });
    const expected = createSession({
      id: 'recorded-session',
      appName: 'weather_agent',
      userId: 'adk_conformance_test_user',
      state: {locale: 'en-US'},
      lastUpdateTime: 100,
    });

    expect(() => validateSession(actual, expected)).not.toThrow();
  });

  it('tolerates a recorded session with no state key', () => {
    const expected = session({});
    delete (expected as Partial<Session>).state;

    expect(() => validateSession(session({}), expected)).not.toThrow();
  });

  it('passes when both states are empty', () => {
    expect(() => validateSession(session({}), session({}))).not.toThrow();
  });

  it('treats a null-prototype actual state as equal to a plain object', () => {
    // deepStrictEqual compares prototypes. No session service builds a
    // null-prototype state map today, so copying the state is defensive.
    const actual = session(
      Object.assign(Object.create(null), {locale: 'en-US'}),
    );

    expect(() =>
      validateSession(actual, session({locale: 'en-US'})),
    ).not.toThrow();
  });

  it('does not mutate either state', () => {
    const actualState = {locale: 'en-US', _adk_replay_config: {mode: 'replay'}};
    const expectedState = {
      locale: 'en-US',
      _adk_recordings_config: {mode: 'record'},
    };

    validateSession(session(actualState), session(expectedState));

    expect(actualState).toHaveProperty('_adk_replay_config');
    expect(expectedState).toHaveProperty('_adk_recordings_config');
  });

  it('strips the ADK bookkeeping keys from event state deltas', () => {
    const actual = session({}, [
      createEvent({
        author: 'agent',
        actions: createEventActions({
          stateDelta: {turnCount: 1, _adk_replay_config: {mode: 'replay'}},
        }),
      }),
    ]);
    const expected = session({}, [
      createEvent({
        author: 'agent',
        actions: createEventActions({stateDelta: {turnCount: 1}}),
      }),
    ]);

    expect(() => validateSession(actual, expected)).not.toThrow();
  });

  it('still fails on an event mismatch when the states match', () => {
    expect(() =>
      validateSession(
        session({locale: 'en-US'}, [textEvent('hello')]),
        session({locale: 'en-US'}, [textEvent('goodbye')]),
      ),
    ).toThrow(AssertionError);
  });

  it('reports the event mismatch when both events and state differ', () => {
    const run = () =>
      validateSession(
        session({locale: 'en-US'}, [textEvent('hello')]),
        session({locale: 'fr-FR'}, [textEvent('goodbye')]),
      );

    expect(run).toThrow(/hello/);
    expect(run).not.toThrow(/fr-FR/);
  });
});
