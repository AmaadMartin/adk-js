/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AppendEventRequest,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionConfig,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
} from '@google/adk';
import * as adk from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * These helpers are internal to `core/src/sessions`, and their analogue is
 * private in adk-python (`_merge_state`). A wildcard re-export of
 * `sessions/base_session_service.js` publishes them again, so this list guards
 * the barrel against one coming back.
 */
const INTERNAL_STATE_HELPERS = [
  'trimTempDeltaState',
  'trimTempState',
  'mergeStates',
];

describe('the @google/adk session surface', () => {
  it('does not publish the internal session state helpers', () => {
    for (const name of INTERNAL_STATE_HELPERS) {
      expect(name in adk).toBe(false);
    }
  });

  it('still publishes BaseSessionService and its request and response types', () => {
    // The type annotations below are the assertion: `ts:check` and the Vitest
    // transform both fail if the barrel stops resolving one of these types.
    const session = adk.createSession({id: 's1', appName: 'app', userId: 'u1'});
    const create: CreateSessionRequest = {appName: 'app', userId: 'u1'};
    const key: DeleteSessionRequest = {...create, sessionId: session.id};
    const config: GetSessionConfig = {numRecentEvents: 1};
    const get: GetSessionRequest = {...key, config};
    const list: ListSessionsRequest = {appName: 'app', order: 'asc'};
    const listed: ListSessionsResponse = {
      sessions: [session],
      page: 1,
      limit: 1,
      totalItems: 1,
      totalPages: 1,
    };
    const append: AppendEventRequest = {
      session,
      event: adk.createEvent({author: 'agent'}),
    };

    expect(typeof adk.BaseSessionService).toBe('function');
    expect(get.sessionId).toBe(session.id);
    expect(get.config).toBe(config);
    expect(list.order).toBe('asc');
    expect(listed.sessions).toContain(append.session);
  });
});
