/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createSession, Session} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {validateSession} from '../../src/integration/test_runner.js';

/** Builds a session holding one model event per text. */
function sessionWithTexts(texts: string[]): Session {
  return createSession({
    id: 'test-session',
    appName: 'test-runner',
    events: texts.map((text) =>
      createEvent({author: 'agent', content: {role: 'model', parts: [{text}]}}),
    ),
  });
}

/** Returns the message of the error `validateSession` throws. */
function failureMessage(actual: Session, expected: Session): string {
  try {
    validateSession(actual, expected);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return expect.fail('validateSession did not throw');
}

describe('validateSession', () => {
  it('accepts identical sessions', () => {
    expect(() =>
      validateSession(
        sessionWithTexts(['first', 'second']),
        sessionWithTexts(['first', 'second']),
      ),
    ).not.toThrow();
  });

  it('accepts sessions whose events differ only in per-run fields', () => {
    const perRunEvent = (suffix: string) =>
      createEvent({
        author: 'agent',
        id: `id-${suffix}`,
        invocationId: `invocation-${suffix}`,
        timestamp: suffix === 'live' ? 1 : 2,
        longRunningToolIds: [`tool-${suffix}`],
        content: {role: 'model', parts: [{text: 'first'}]},
      });

    expect(() =>
      validateSession(
        createSession({
          id: 'live-session',
          appName: 'test-runner',
          events: [perRunEvent('live')],
        }),
        createSession({
          id: 'recorded-session',
          appName: 'test-runner',
          events: [perRunEvent('recorded')],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts two sessions that hold no events', () => {
    expect(() =>
      validateSession(sessionWithTexts([]), sessionWithTexts([])),
    ).not.toThrow();
  });

  it('reports the count when the replay produced more events', () => {
    const message = failureMessage(
      sessionWithTexts(['first', 'second']),
      sessionWithTexts(['first']),
    );

    expect(message).toContain('Event count mismatch - Actual: 2, Recorded: 1');
    expect(message).not.toContain('mismatch:');
    expect(message).not.toContain('event 0');
  });

  it('reports the count when the replay produced fewer events', () => {
    const message = failureMessage(
      sessionWithTexts(['first']),
      sessionWithTexts(['first', 'second']),
    );

    expect(message).toContain('Event count mismatch - Actual: 1, Recorded: 2');
  });

  it('names the index of the diverging event and diffs that event alone', () => {
    const message = failureMessage(
      sessionWithTexts(['first', 'live-second', 'third']),
      sessionWithTexts(['first', 'recorded-second', 'third']),
    );

    expect(message).toContain('event 1 mismatch');
    expect(message).toContain('live-second');
    expect(message).toContain('recorded-second');
    expect(message).not.toContain('third');
  });

  it('names the first diverging event when several diverge', () => {
    const message = failureMessage(
      sessionWithTexts(['live-first', 'second', 'live-third']),
      sessionWithTexts(['recorded-first', 'second', 'recorded-third']),
    );

    expect(message).toContain('event 0 mismatch');
    expect(message).not.toContain('event 2 mismatch');
    expect(message).not.toContain('live-third');
  });
});
