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

  it('still publishes BaseSessionService and its request and response types', async () => {
    // The annotations are what pin the type surface: `ts:check` fails if the
    // barrel stops resolving one of these types. Vitest strips them, so each
    // request also drives a real service to keep the assertions able to fail.
    const service: adk.BaseSessionService = new adk.InMemorySessionService();
    const create: CreateSessionRequest = {
      appName: 'app',
      userId: 'u1',
      sessionId: 's1',
    };
    const created = await service.createSession(create);

    const key: DeleteSessionRequest = {...create, sessionId: created.id};
    const config: GetSessionConfig = {numRecentEvents: 1};
    const get: GetSessionRequest = {...key, config};
    const append: AppendEventRequest = {
      session: created,
      event: adk.createEvent({author: 'agent'}),
    };
    await service.appendEvent(append);

    const list: ListSessionsRequest = {appName: 'app', order: 'asc'};
    const listed: ListSessionsResponse = await service.listSessions(list);

    expect(typeof adk.BaseSessionService).toBe('function');
    expect(listed.sessions.map((session) => session.id)).toEqual(['s1']);
    expect((await service.getSession(get))?.events).toHaveLength(1);

    await service.deleteSession(key);
    expect(await service.getSession(get)).toBeUndefined();
  });
});
