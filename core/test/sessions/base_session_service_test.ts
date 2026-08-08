/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  InMemorySessionService,
  ListSessionsRequest,
  ListSessionsResponse,
  Session,
  createEvent,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TEST_APP_NAME = 'test-app';
const TEST_USER_ID = 'test-user';

/** The smallest subclass that satisfies the abstract members. */
class MinimalSessionService extends BaseSessionService {
  override async createSession(
    request: CreateSessionRequest,
  ): Promise<Session> {
    return createSession({
      id: request.sessionId ?? 'session-id',
      appName: request.appName,
      userId: request.userId,
    });
  }

  override async getSession(
    _request: GetSessionRequest,
  ): Promise<Session | undefined> {
    return undefined;
  }

  override async listSessions(
    _request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    return {sessions: [], page: 1, limit: 0, totalItems: 0, totalPages: 0};
  }

  override async deleteSession(_request: DeleteSessionRequest): Promise<void> {}
}

describe('BaseSessionService.flush', () => {
  it('resolves to undefined by default', async () => {
    const service = new MinimalSessionService();

    await expect(service.flush()).resolves.toBeUndefined();
  });

  it('is inherited by a shipped service and leaves its events untouched', async () => {
    const service = new InMemorySessionService();
    const session = await service.createSession({
      appName: TEST_APP_NAME,
      userId: TEST_USER_ID,
    });
    await service.appendEvent({
      session,
      event: createEvent({
        invocationId: 'invocation-id',
        author: 'user',
        content: {role: 'user', parts: [{text: 'Hello'}]},
      }),
    });

    await expect(service.flush()).resolves.toBeUndefined();

    const stored = await service.getSession({
      appName: TEST_APP_NAME,
      userId: TEST_USER_ID,
      sessionId: session.id,
    });
    expect(stored?.events).toHaveLength(1);
    expect(stored?.events[0].content?.parts).toEqual([{text: 'Hello'}]);
  });
});
