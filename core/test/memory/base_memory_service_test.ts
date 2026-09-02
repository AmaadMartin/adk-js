/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AddEventsToMemoryRequest,
  AddMemoryRequest,
  BaseMemoryService,
  createEvent,
  DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE,
  EVENT_DELTAS_UNSUPPORTED_MESSAGE,
  InMemoryMemoryService,
  MemoryEntry,
  SearchMemoryResponse,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

/** A service that implements only the two abstract members. */
class MinimalMemoryService extends BaseMemoryService {
  async addSessionToMemory(): Promise<void> {}

  async searchMemory(): Promise<SearchMemoryResponse> {
    return {memories: []};
  }
}

/** A service that supports both optional write paths. */
class WritableMemoryService extends MinimalMemoryService {
  eventsRequests: AddEventsToMemoryRequest[] = [];
  memoryRequests: AddMemoryRequest[] = [];

  override async addEventsToMemory(
    request: AddEventsToMemoryRequest,
  ): Promise<void> {
    this.eventsRequests.push(request);
  }

  override async addMemory(request: AddMemoryRequest): Promise<void> {
    this.memoryRequests.push(request);
  }
}

const ENTRY: MemoryEntry = {
  content: {role: 'user', parts: [{text: 'Prefers window seats.'}]},
  author: 'user',
  timestamp: '2026-01-15T10:30:00.000Z',
};

function newEvent() {
  return createEvent({
    author: 'user',
    content: {role: 'user', parts: [{text: 'hello world'}]},
  });
}

describe('BaseMemoryService', () => {
  let service: MinimalMemoryService;

  beforeEach(() => {
    service = new MinimalMemoryService();
  });

  describe('addEventsToMemory default', () => {
    it('rejects when the service does not override it', async () => {
      await expect(
        service.addEventsToMemory({
          appName: 'myApp',
          userId: 'alice',
          events: [newEvent()],
        }),
      ).rejects.toThrow(EVENT_DELTAS_UNSUPPORTED_MESSAGE);
    });

    it('names the whole-session alternative in the message', () => {
      expect(EVENT_DELTAS_UNSUPPORTED_MESSAGE).toContain(
        'addSessionToMemory(session)',
      );
    });

    it('rejects the same way when sessionId and customMetadata are set', async () => {
      await expect(
        service.addEventsToMemory({
          appName: 'myApp',
          userId: 'alice',
          events: [newEvent()],
          sessionId: 'session-1',
          customMetadata: {ttl: '3600s'},
        }),
      ).rejects.toThrow(EVENT_DELTAS_UNSUPPORTED_MESSAGE);
    });
  });

  describe('addMemory default', () => {
    it('rejects when the service does not override it', async () => {
      await expect(
        service.addMemory({
          appName: 'myApp',
          userId: 'alice',
          memories: [ENTRY],
        }),
      ).rejects.toThrow(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE);
    });

    it('names both alternatives in the message', () => {
      expect(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE).toContain(
        'addEventsToMemory(...)',
      );
      expect(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE).toContain(
        'addSessionToMemory(session)',
      );
    });
  });

  describe('overrides', () => {
    it('passes the event delta through unchanged', async () => {
      const writable = new WritableMemoryService();
      const request = {
        appName: 'myApp',
        userId: 'alice',
        events: [newEvent()],
        sessionId: 'session-1',
        customMetadata: {ttl: '3600s'},
      };

      await writable.addEventsToMemory(request);

      expect(writable.eventsRequests).toEqual([request]);
    });

    it('passes the memories through unchanged', async () => {
      const writable = new WritableMemoryService();
      const request = {
        appName: 'myApp',
        userId: 'alice',
        memories: [ENTRY],
      };

      await writable.addMemory(request);

      expect(writable.memoryRequests).toEqual([request]);
    });
  });

  describe('InMemoryMemoryService inheritance', () => {
    it('inherits the event delta rejection', async () => {
      await expect(
        new InMemoryMemoryService().addEventsToMemory({
          appName: 'myApp',
          userId: 'alice',
          events: [newEvent()],
        }),
      ).rejects.toThrow(EVENT_DELTAS_UNSUPPORTED_MESSAGE);
    });

    it('inherits the direct write rejection', async () => {
      await expect(
        new InMemoryMemoryService().addMemory({
          appName: 'myApp',
          userId: 'alice',
          memories: [ENTRY],
        }),
      ).rejects.toThrow(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE);
    });
  });
});
