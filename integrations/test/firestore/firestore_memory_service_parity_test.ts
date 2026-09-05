/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from adk-python, so that the two implementations can
 * be compared name by name.
 *
 * Source:
 * `adk-python:tests/unittests/integrations/firestore/test_firestore_memory_service.py`
 * at ref `main`. Each `it` keeps its original snake_case name. Where adk-js
 * deliberately behaves differently, the test asserts what adk-js does and the
 * comment above it names the divergence.
 */

import {Firestore} from '@google-cloud/firestore';
import {createEvent, createSession, getLogger, setLogger} from '@google/adk';
import {FirestoreMemoryService} from '@google/adk-integrations';
import {createUserContent} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {extractKeywords} from '../../src/firestore/firestore_memory_service.js';
import {DEFAULT_STOP_WORDS} from '../../src/firestore/stop_words.js';
import {FakeFirestore} from './firestore_memory_test_doubles.js';

vi.mock('@google-cloud/firestore', async () => {
  const doubles = await import('./firestore_memory_test_doubles.js');
  return {Firestore: doubles.FakeFirestore};
});

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const TIMESTAMP_MS = 1234567890000;

describe('FirestoreMemoryService reference tests', () => {
  let warnings: string[] = [];
  let previousLogger = getLogger();

  beforeEach(() => {
    FakeFirestore.reset();
    warnings = [];
    previousLogger = getLogger();
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(' '));
      },
      error: () => {},
    });
  });

  afterEach(() => {
    setLogger(previousLogger);
  });

  it('test_extract_keywords', () => {
    const keywords = extractKeywords(
      'The quick brown fox jumps over the lazy dog.',
      DEFAULT_STOP_WORDS,
    );

    expect(keywords.has('the')).toBe(false);
    expect(keywords.has('over')).toBe(false);
    expect(keywords.has('quick')).toBe(true);
    expect(keywords.has('brown')).toBe(true);
    expect(keywords.has('fox')).toBe(true);
    expect(keywords.has('jumps')).toBe(true);
    expect(keywords.has('lazy')).toBe(true);
    expect(keywords.has('dog')).toBe(true);
  });

  it('test_search_memory_empty_query', async () => {
    const {service, store} = createService();

    const response = await service.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query: '',
    });

    expect(response.memories).toEqual([]);
    expect(store.collectionCalls).toEqual([]);
  });

  it('test_search_memory_with_results', async () => {
    const {service, store} = createService();
    store.seed('memories', {
      appName: APP_NAME,
      userId: USER_ID,
      keywords: ['quick', 'fox', 'jumps'],
      author: 'user',
      content: createUserContent('quick fox jumps'),
      timestamp: TIMESTAMP_MS,
    });

    const response = await service.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query: 'quick fox',
    });

    expect(response.memories).toHaveLength(1);
    expect(response.memories[0].author).toBe('user');
    expect(store.collectionCalls).toEqual(['memories', 'memories']);

    // Two keywords, each filtered on appName, userId and the keyword.
    expect(store.whereCalls).toHaveLength(6);
    expect(countWhere(store, 'appName', '==', APP_NAME)).toBe(2);
    expect(countWhere(store, 'userId', '==', USER_ID)).toBe(2);
    expect(countWhere(store, 'keywords', 'array-contains', 'quick')).toBe(1);
    expect(countWhere(store, 'keywords', 'array-contains', 'fox')).toBe(1);
  });

  it('test_search_memory_deduplication', async () => {
    const {service, store} = createService();
    const document = {
      appName: APP_NAME,
      userId: USER_ID,
      author: 'user',
      content: createUserContent('quick fox jumps'),
      timestamp: TIMESTAMP_MS,
    };
    // Two distinct documents, one per lane, carrying the same memory.
    store.seed('memories', {...document, keywords: ['quick']});
    store.seed('memories', {...document, keywords: ['fox']});

    const response = await service.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query: 'quick fox',
    });

    expect(response.memories).toHaveLength(1);
    expect(response.memories[0].author).toBe('user');
  });

  it('test_search_memory_parsing_error', async () => {
    const {service, store} = createService();
    store.seed('memories', {
      appName: APP_NAME,
      userId: USER_ID,
      keywords: ['quick'],
      content: 'invalid_data',
    });

    const response = await service.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query: 'quick',
    });

    expect(response.memories).toEqual([]);
    expect(warnings.join('\n')).toContain('Failed to parse memory entry');
  });

  it('test_search_memory_only_stop_words', async () => {
    const {service, store} = createService();

    const response = await service.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query: 'the and or',
    });

    expect(response.memories).toEqual([]);
    expect(store.collectionCalls).toEqual([]);
  });

  it('test_search_memory_partial_failures', async () => {
    const {service, store} = createService();
    store.seed('memories', {
      appName: APP_NAME,
      userId: USER_ID,
      keywords: ['quick'],
      author: 'user',
      content: createUserContent('quick response'),
      timestamp: TIMESTAMP_MS,
    });
    store.keywordErrors.set(
      'fox',
      new Error('Mock generic network failure standalone'),
    );

    const response = await service.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query: 'fox quick',
    });

    expect(response.memories).toHaveLength(1);
    expect(response.memories[0].author).toBe('user');
    expect(warnings.join('\n')).toContain(
      'Memory keyword search partial failure',
    );
  });

  it('test_init_default_client', async () => {
    const service = new FirestoreMemoryService();

    expect(FakeFirestore.instances).toHaveLength(1);

    // adk-js cannot assert on `service.client`, which stays private. Driving a
    // search proves the default client is the one the service queries.
    await service.searchMemory({
      appName: APP_NAME,
      userId: USER_ID,
      query: 'quick',
    });
    expect(FakeFirestore.latest().collectionCalls).toEqual(['memories']);
  });

  it('test_add_session_to_memory', async () => {
    const {service, store} = createService();
    const session = createSession({
      id: 'test_session',
      appName: APP_NAME,
      userId: USER_ID,
      events: [
        createEvent({
          invocationId: 'test_inv',
          author: 'user',
          content: createUserContent('quick brown fox'),
          timestamp: TIMESTAMP_MS,
        }),
      ],
    });

    await service.addSessionToMemory(session);

    expect(store.batches).toHaveLength(1);
    expect(store.collectionCalls).toEqual(['memories']);
    expect(store.batches[0].sets).toHaveLength(1);
    expect(store.batches[0].commitCount).toBe(1);

    const {data} = store.batches[0].sets[0];
    expect(data['appName']).toBe(APP_NAME);
    expect(data['userId']).toBe(USER_ID);
    expect(data['keywords']).toContain('quick');
    expect(data['author']).toBe('user');
    expect(data['timestamp']).toBe(TIMESTAMP_MS);
  });

  it('test_add_session_to_memory_no_events', async () => {
    const {service, store} = createService();
    const session = createSession({
      id: 'test_session',
      appName: APP_NAME,
      userId: USER_ID,
    });

    await service.addSessionToMemory(session);

    expect(store.batches).toHaveLength(1);
    expect(store.batches[0].sets).toEqual([]);
    expect(store.batches[0].commitCount).toBe(0);
  });

  it('test_add_session_to_memory_no_keywords', async () => {
    const {service, store} = createService();
    const session = createSession({
      id: 'test_session',
      appName: APP_NAME,
      userId: USER_ID,
      events: [
        createEvent({
          invocationId: 'test_inv',
          author: 'user',
          content: createUserContent('the and or'),
        }),
      ],
    });

    await service.addSessionToMemory(session);

    expect(store.batches).toHaveLength(1);
    expect(store.batches[0].sets).toEqual([]);
    expect(store.batches[0].commitCount).toBe(0);
  });

  it('test_add_session_to_memory_commit_error', async () => {
    const {service, store} = createService();
    store.commitError = new Error('Firestore commit failed');
    const session = createSession({
      id: 'test_session',
      appName: APP_NAME,
      userId: USER_ID,
      events: [
        createEvent({
          invocationId: 'test_inv',
          author: 'user',
          content: createUserContent('quick brown fox'),
        }),
      ],
    });

    await expect(service.addSessionToMemory(session)).rejects.toThrow(
      'Firestore commit failed',
    );
  });

  it('test_add_session_to_memory_exceeds_batch_limit', async () => {
    const {service, store} = createService();
    const events = Array.from({length: 501}, (_unused, index) =>
      createEvent({
        invocationId: `test_inv_${index}`,
        author: 'user',
        content: createUserContent(`event keyword ${index}`),
        timestamp: TIMESTAMP_MS + index,
      }),
    );
    const session = createSession({
      id: 'test_session',
      appName: APP_NAME,
      userId: USER_ID,
      events,
    });

    await service.addSessionToMemory(session);

    expect(store.batches).toHaveLength(2);
    expect(store.batches[0].sets).toHaveLength(500);
    expect(store.batches[0].commitCount).toBe(1);
    expect(store.batches[1].sets).toHaveLength(1);
    expect(store.batches[1].commitCount).toBe(1);
  });
});

/** Builds a service over a fresh fake client. */
function createService(): {
  service: FirestoreMemoryService;
  store: FakeFirestore;
} {
  const client = new Firestore();
  return {
    service: new FirestoreMemoryService({client}),
    store: FakeFirestore.latest(),
  };
}

/** Counts the recorded filters that match one field, operator and value. */
function countWhere(
  store: FakeFirestore,
  fieldPath: string,
  opStr: string,
  value: unknown,
): number {
  return store.whereCalls.filter(
    (call) =>
      call.fieldPath === fieldPath &&
      call.opStr === opStr &&
      call.value === value,
  ).length;
}
