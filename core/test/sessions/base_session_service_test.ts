/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createSession, ListSessionsRequest, Session} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  paginateSessions,
  resolvePagination,
} from '../../src/sessions/base_session_service.js';

const APP_NAME = 'app';
const USER_ID = 'user';

/** Builds a session fixture with a distinct id and last update time. */
function makeSession(id: string, lastUpdateTime: number): Session {
  return createSession({
    id,
    appName: APP_NAME,
    userId: USER_ID,
    lastUpdateTime,
  });
}

/** Four sessions whose ids are in ascending last-update-time order. */
function makeSessions(): Session[] {
  return [
    makeSession('s1', 100),
    makeSession('s2', 200),
    makeSession('s3', 300),
    makeSession('s4', 400),
  ];
}

/** Builds a list request, which always carries an app name and a user id. */
function request(
  pagination: Omit<ListSessionsRequest, 'appName' | 'userId'> = {},
): ListSessionsRequest {
  return {appName: APP_NAME, userId: USER_ID, ...pagination};
}

describe('paginateSessions', () => {
  it('returns every session when no pagination params are given', () => {
    const sessions = makeSessions();

    const response = paginateSessions(sessions, request());

    expect(response.sessions.map((s) => s.id)).toEqual([
      's1',
      's2',
      's3',
      's4',
    ]);
    expect(response.page).toBe(1);
    expect(response.limit).toBe(4);
    expect(response.totalItems).toBe(4);
    expect(response.totalPages).toBe(1);
  });

  it('reports an empty result set with no pagination params', () => {
    const response = paginateSessions([], request());

    expect(response).toEqual({
      sessions: [],
      page: 1,
      limit: 0,
      totalItems: 0,
      totalPages: 0,
    });
  });

  it('reports an empty result set with a limit', () => {
    const response = paginateSessions([], request({limit: 2, offset: 4}));

    expect(response).toEqual({
      sessions: [],
      page: 3,
      limit: 2,
      totalItems: 0,
      totalPages: 0,
    });
  });

  it('echoes the requested page for an empty result set', () => {
    const response = paginateSessions([], request({limit: 2, page: 7}));

    expect(response).toEqual({
      sessions: [],
      page: 7,
      limit: 2,
      totalItems: 0,
      totalPages: 0,
    });
  });

  it('returns the first page when only a limit is given', () => {
    const response = paginateSessions(makeSessions(), request({limit: 3}));

    expect(response.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(response.page).toBe(1);
    expect(response.limit).toBe(3);
    expect(response.totalItems).toBe(4);
    expect(response.totalPages).toBe(2);
  });

  it('skips offset sessions and reports the pre-offset total as the limit', () => {
    const response = paginateSessions(makeSessions(), request({offset: 3}));

    expect(response.sessions.map((s) => s.id)).toEqual(['s4']);
    expect(response.page).toBe(1);
    expect(response.limit).toBe(4);
    expect(response.totalItems).toBe(4);
    expect(response.totalPages).toBe(1);
  });

  it('derives the page number from limit and offset', () => {
    const response = paginateSessions(
      makeSessions(),
      request({limit: 2, offset: 2}),
    );

    expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    expect(response.page).toBe(2);
    expect(response.limit).toBe(2);
    expect(response.totalItems).toBe(4);
    expect(response.totalPages).toBe(2);
  });

  it('slices by page number when page and limit are given', () => {
    const response = paginateSessions(
      makeSessions(),
      request({limit: 2, page: 2}),
    );

    expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    expect(response.page).toBe(2);
    expect(response.totalPages).toBe(2);
  });

  it('lets page take precedence over offset', () => {
    const response = paginateSessions(
      makeSessions(),
      request({limit: 2, offset: 1, page: 2}),
    );

    expect(response.sessions.map((s) => s.id)).toEqual(['s3', 's4']);
    expect(response.page).toBe(2);
  });

  it('returns no sessions but a truthful total for limit 0', () => {
    const response = paginateSessions(makeSessions(), request({limit: 0}));

    expect(response).toEqual({
      sessions: [],
      page: 1,
      limit: 0,
      totalItems: 4,
      totalPages: 0,
    });
  });

  it('returns no sessions when the offset is beyond the total', () => {
    const response = paginateSessions(
      makeSessions(),
      request({limit: 2, offset: 10}),
    );

    expect(response.sessions).toEqual([]);
    expect(response.page).toBe(6);
    expect(response.limit).toBe(2);
    expect(response.totalItems).toBe(4);
    expect(response.totalPages).toBe(2);
  });

  it('sorts ascending by last update time', () => {
    const sessions = [
      makeSession('b', 300),
      makeSession('a', 100),
      makeSession('c', 200),
    ];

    const response = paginateSessions(sessions, request({order: 'asc'}));

    expect(response.sessions.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts descending by last update time', () => {
    const sessions = [
      makeSession('b', 300),
      makeSession('a', 100),
      makeSession('c', 200),
    ];

    const response = paginateSessions(sessions, request({order: 'desc'}));

    expect(response.sessions.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ascending ties by id', () => {
    const sessions = [
      makeSession('c', 100),
      makeSession('a', 100),
      makeSession('b', 100),
    ];

    const response = paginateSessions(sessions, request({order: 'asc'}));

    expect(response.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks descending ties by id', () => {
    const sessions = [
      makeSession('c', 100),
      makeSession('a', 100),
      makeSession('b', 100),
    ];

    const response = paginateSessions(sessions, request({order: 'desc'}));

    expect(response.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves the input order when order is omitted', () => {
    const sessions = [
      makeSession('b', 300),
      makeSession('a', 100),
      makeSession('c', 200),
    ];

    const response = paginateSessions(sessions, request());

    expect(response.sessions.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const sessions = [
      makeSession('b', 300),
      makeSession('a', 100),
      makeSession('c', 200),
    ];
    const idsBefore = sessions.map((s) => s.id);

    paginateSessions(sessions, request({order: 'desc'}));

    expect(sessions.map((s) => s.id)).toEqual(idsBefore);
  });
});

describe('resolvePagination', () => {
  it('reports the total as the limit when no limit is requested', () => {
    expect(resolvePagination(request(), 7)).toEqual({
      offset: 0,
      meta: {page: 1, limit: 7, totalItems: 7, totalPages: 1},
    });
  });

  it('keeps the offset when no limit is requested', () => {
    expect(resolvePagination(request({offset: 3}), 7)).toEqual({
      offset: 3,
      meta: {page: 1, limit: 7, totalItems: 7, totalPages: 1},
    });
  });

  it('reports zero pages for an empty total with no limit', () => {
    expect(resolvePagination(request(), 0)).toEqual({
      offset: 0,
      meta: {page: 1, limit: 0, totalItems: 0, totalPages: 0},
    });
  });

  it('converts a page number into an offset', () => {
    expect(resolvePagination(request({limit: 5, page: 3}), 12)).toEqual({
      offset: 10,
      meta: {page: 3, limit: 5, totalItems: 12, totalPages: 3},
    });
  });

  it('derives the page number from the offset', () => {
    expect(resolvePagination(request({limit: 5, offset: 5}), 12)).toEqual({
      offset: 5,
      meta: {page: 2, limit: 5, totalItems: 12, totalPages: 3},
    });
  });

  it('defaults the offset to zero when only a limit is requested', () => {
    expect(resolvePagination(request({limit: 5}), 12)).toEqual({
      offset: 0,
      meta: {page: 1, limit: 5, totalItems: 12, totalPages: 3},
    });
  });

  it('reports page 1 and zero pages for limit 0', () => {
    expect(resolvePagination(request({limit: 0}), 12)).toEqual({
      offset: 0,
      meta: {page: 1, limit: 0, totalItems: 12, totalPages: 0},
    });
  });
});
