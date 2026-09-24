/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createSession, ListSessionsResponse} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  EVAL_SESSION_ID_PREFIX,
  withoutEvalSessions,
} from '../../src/server/eval_sessions.js';

const APP_NAME = 'testApp';
const USER_ID = 'testUser';

/** Builds a listing whose pagination fields count every id it was given. */
function listing(...ids: string[]): ListSessionsResponse {
  return {
    sessions: ids.map((id) =>
      createSession({id, appName: APP_NAME, userId: USER_ID}),
    ),
    page: 1,
    limit: ids.length,
    totalItems: ids.length,
    totalPages: 1,
  };
}

function idsOf(response: ListSessionsResponse): string[] {
  return response.sessions.map((session) => session.id);
}

describe('withoutEvalSessions', () => {
  it('matches the prefix adk-python reserves for evaluation sessions', () => {
    expect(EVAL_SESSION_ID_PREFIX).toBe('___eval___session___');
  });

  it('drops a session whose id carries the eval prefix', () => {
    const filtered = withoutEvalSessions(
      listing(`${EVAL_SESSION_ID_PREFIX}abc`),
    );

    expect(idsOf(filtered)).toEqual([]);
  });

  it('keeps the sessions a user created, in their original order', () => {
    const filtered = withoutEvalSessions(
      listing('s1', `${EVAL_SESSION_ID_PREFIX}abc`, 's2'),
    );

    expect(idsOf(filtered)).toEqual(['s1', 's2']);
  });

  it('keeps an id that carries the prefix somewhere other than the start', () => {
    const filtered = withoutEvalSessions(
      listing(`mine-${EVAL_SESSION_ID_PREFIX}abc`),
    );

    expect(idsOf(filtered)).toEqual([`mine-${EVAL_SESSION_ID_PREFIX}abc`]);
  });

  it('keeps an id that only starts to look like the prefix', () => {
    const filtered = withoutEvalSessions(listing('___eval___', '___'));

    expect(idsOf(filtered)).toEqual(['___eval___', '___']);
  });

  it('returns an empty listing unchanged', () => {
    const filtered = withoutEvalSessions(listing());

    expect(idsOf(filtered)).toEqual([]);
  });

  it('reports the count the session service gave it, not the filtered count', () => {
    const filtered = withoutEvalSessions(
      listing('s1', `${EVAL_SESSION_ID_PREFIX}abc`),
    );

    expect(filtered.totalItems).toBe(2);
    expect(filtered.page).toBe(1);
    expect(filtered.limit).toBe(2);
    expect(filtered.totalPages).toBe(1);
  });

  it('leaves the listing it was given alone', () => {
    const original = listing('s1', `${EVAL_SESSION_ID_PREFIX}abc`);

    withoutEvalSessions(original);

    expect(idsOf(original)).toEqual(['s1', `${EVAL_SESSION_ID_PREFIX}abc`]);
  });
});
