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
  InMemoryMemoryService,
  MemoryEntry,
  SearchMemoryResponse,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

/**
 * The diagnostics the base class reports, copied from
 * `adk-python`'s `base_memory_service.py` with the method names camelCased.
 * Held here rather than imported so a reworded message fails the test.
 */
const EVENT_DELTAS_MESSAGE =
  'This memory service does not support adding event deltas. ' +
  'Call addSessionToMemory(session) to ingest the full session.';
const DIRECT_WRITES_MESSAGE =
  'This memory service does not support direct memory writes. ' +
  'Call addEventsToMemory(...) or addSessionToMemory(session) instead.';

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
      ).rejects.toThrow(new Error(EVENT_DELTAS_MESSAGE));
    });

    it('names the whole-session alternative in the message', async () => {
      await expect(
        service.addEventsToMemory({
          appName: 'myApp',
          userId: 'alice',
          events: [newEvent()],
        }),
      ).rejects.toThrow('addSessionToMemory(session)');
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
      ).rejects.toThrow(new Error(EVENT_DELTAS_MESSAGE));
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
      ).rejects.toThrow(new Error(DIRECT_WRITES_MESSAGE));
    });

    it('names both alternatives in the message', async () => {
      const request = {appName: 'myApp', userId: 'alice', memories: [ENTRY]};

      await expect(service.addMemory(request)).rejects.toThrow(
        'addEventsToMemory(...)',
      );
      await expect(service.addMemory(request)).rejects.toThrow(
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
      ).rejects.toThrow(new Error(EVENT_DELTAS_MESSAGE));
    });

    it('inherits the direct write rejection', async () => {
      await expect(
        new InMemoryMemoryService().addMemory({
          appName: 'myApp',
          userId: 'alice',
          memories: [ENTRY],
        }),
      ).rejects.toThrow(new Error(DIRECT_WRITES_MESSAGE));
    });
  });
});
