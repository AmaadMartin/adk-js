/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemoryMemoryService,
  InMemorySessionService,
  SearchMemoryResponse,
  createEvent,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

/** Returns the text of every memory, so assertions can ignore result order. */
function memoryTexts(response: SearchMemoryResponse): string[] {
  return response.memories.map(
    (memory) => memory.content.parts?.[0]?.text ?? '',
  );
}

describe('InMemoryMemoryService', () => {
  let service: InMemoryMemoryService;
  let sessionService: InMemorySessionService;

  beforeEach(() => {
    service = new InMemoryMemoryService();
    sessionService = new InMemorySessionService();
  });

  describe('addSessionToMemory', () => {
    it('stores events that have content parts', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].content).toEqual(event.content);
    });

    it('filters out events with no content parts', async () => {
      const emptyEvent = createEvent({author: 'user'});
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event: emptyEvent});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('stores events under the correct appName/userId key', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const sessionAlice = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session: sessionAlice, event});

      const sessionBob = await sessionService.createSession({
        appName: 'myApp',
        userId: 'bob',
      });

      await service.addSessionToMemory(sessionAlice);
      await service.addSessionToMemory(sessionBob);

      const aliceResult = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });
      const bobResult = await service.searchMemory({
        appName: 'myApp',
        userId: 'bob',
        query: 'hello',
      });

      expect(aliceResult.memories).toHaveLength(1);
      expect(bobResult.memories).toHaveLength(0);
    });
  });

  describe('addEventsToMemory', () => {
    it('appends a delta alongside the events of the same session', async () => {
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({
        session,
        event: createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello world'}]},
        }),
      });
      await service.addSessionToMemory(session);

      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: session.id,
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'a new fact'}]},
          }),
        ],
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello fact',
      });

      expect(new Set(memoryTexts(result))).toEqual(
        new Set(['hello world', 'a new fact']),
      );
    });

    it('keeps the stored event when the delta repeats its id', async () => {
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({
        session,
        event: createEvent({
          id: 'event-1a',
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello world'}]},
        }),
      });
      await service.addSessionToMemory(session);

      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: session.id,
        events: [
          createEvent({
            id: 'event-1a',
            author: 'user',
            content: {role: 'user', parts: [{text: 'updated duplicate text'}]},
          }),
        ],
      });

      const stored = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });
      const replaced = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'updated',
      });

      expect(memoryTexts(stored)).toEqual(['hello world']);
      expect(replaced.memories).toHaveLength(0);
    });

    it('skips an event with no content parts so its id stays free', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: 'session-1',
        events: [createEvent({id: 'e1', author: 'user'})],
      });

      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: 'session-1',
        events: [
          createEvent({
            id: 'e1',
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

      expect(memoryTexts(result)).toEqual(['hello world']);
    });

    it('collects deltas with no sessionId in one bucket', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        events: [
          createEvent({
            id: 'e1',
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello world'}]},
          }),
        ],
      });

      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        events: [
          createEvent({
            id: 'e1',
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello again'}]},
          }),
          createEvent({
            id: 'e2',
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello there'}]},
          }),
        ],
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      // Both deltas share one bucket, so the repeated `e1` is deduped against
      // the first delta rather than stored a second time.
      expect(new Set(memoryTexts(result))).toEqual(
        new Set(['hello world', 'hello there']),
      );
    });

    it('treats an empty sessionId as no sessionId', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: '',
        events: [
          createEvent({
            id: 'e1',
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello world'}]},
          }),
        ],
      });

      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        events: [
          createEvent({
            id: 'e1',
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello again'}]},
          }),
        ],
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(memoryTexts(result)).toEqual(['hello world']);
    });

    it('scopes the delta to the app name and user ID', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello world'}]},
          }),
        ],
      });

      const alice = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });
      const bob = await service.searchMemory({
        appName: 'myApp',
        userId: 'bob',
        query: 'hello',
      });
      const otherApp = await service.searchMemory({
        appName: 'appB',
        userId: 'alice',
        query: 'hello',
      });

      expect(alice.memories).toHaveLength(1);
      expect(bob.memories).toHaveLength(0);
      expect(otherApp.memories).toHaveLength(0);
    });

    it('indexes a delta whose sessionId is __proto__', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: '__proto__',
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

  describe('searchMemory', () => {
    it('returns empty memories when no session added for user', async () => {
      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'unknown',
        query: 'hello',
      });

      expect(result.memories).toEqual([]);
    });

    it('returns matching memory entries for keyword query', async () => {
      const event = createEvent({
        author: 'agent',
        content: {role: 'model', parts: [{text: 'the weather is sunny today'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'weather',
      });

      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].author).toBe('agent');
    });

    it('returns no matches when query has no overlapping words', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'goodbye',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('matches case-insensitively', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'Hello World'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(1);
    });

    it('does not return memories from a different user', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'secret info'}]},
      });
      const sessionAlice = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session: sessionAlice, event});

      await service.addSessionToMemory(sessionAlice);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'bob',
        query: 'secret',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('does not return memories from a different app', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'appA',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'appB',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('includes author and ISO timestamp in returned memory entries', async () => {
      const timestamp = new Date('2024-01-15T10:30:00.000Z').getTime();
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
        timestamp,
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories[0].author).toBe('user');
      expect(result.memories[0].timestamp).toBe('2024-01-15T10:30:00.000Z');
    });

    it('matches any word in a multi-word query', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'python programming language'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'irrelevant python',
      });

      expect(result.memories).toHaveLength(1);
    });
  });

  describe('prototype pollution', () => {
    it('indexes a session whose id is __proto__', async () => {
      // `session.id` comes off the request path and holds no `/`, so unlike
      // the user key it can be exactly `__proto__`. On a plain inner map that
      // key re-parents the map instead of creating an own property, and the
      // `Object.values` scan in `searchMemory` then steps over the session.
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
        sessionId: '__proto__',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(1);
    });
  });
});
