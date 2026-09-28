/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseMemoryService,
  EVENT_DELTAS_UNSUPPORTED_MESSAGE,
  InMemoryMemoryService,
  addEventsToMemory,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('addEventsToMemory', () => {
  it('rejects when the service does not implement addEventsToMemory', async () => {
    const service: BaseMemoryService = {
      async addSessionToMemory() {},
      async searchMemory() {
        return {memories: []};
      },
    };

    await expect(
      addEventsToMemory(service, {
        appName: 'myApp',
        userId: 'alice',
        events: [],
      }),
    ).rejects.toThrow(EVENT_DELTAS_UNSUPPORTED_MESSAGE);
  });

  it('forwards the request to a service that implements it', async () => {
    const service = new InMemoryMemoryService();

    await addEventsToMemory(service, {
      appName: 'myApp',
      userId: 'alice',
      sessionId: 'session-1',
      events: [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello world'}]},
        }),
      ],
    });

    const result = await service.searchMemory({
      appName: 'myApp',
      userId: 'alice',
      query: 'hello',
    });

    expect(result.memories).toHaveLength(1);
  });
});
