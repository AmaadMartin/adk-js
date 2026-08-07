/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  CreateSessionRequest,
  ListSessionsResponse,
  Session,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A session service that does not implement `getUserState`. */
class MinimalSessionService extends BaseSessionService {
  async createSession({appName, userId}: CreateSessionRequest) {
    return createSession({id: 's', appName, userId});
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
  it('rejects when the service does not implement it', async () => {
    await expect(
      new MinimalSessionService().getUserState({
        appName: 'my_app',
        userId: 'u1',
      }),
    ).rejects.toThrow(/does not support getUserState/);
  });

  it('names the listSessions and getSession fallback', async () => {
    await expect(
      new MinimalSessionService().getUserState({
        appName: 'my_app',
        userId: 'u1',
      }),
    ).rejects.toThrow(/enumerate sessions via listSessions.*getSession/);
  });
});
