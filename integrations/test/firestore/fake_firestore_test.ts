/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Timestamp} from '@google-cloud/firestore';
import {describe, expect, it} from 'vitest';

import {createFakeFirestore, FakeStore} from './fake_firestore.js';

describe('FakeStore', () => {
  it('overwrites a document by default and merges when asked', () => {
    const store = new FakeStore();
    store.set('c/a', {keep: 1, drop: 2}, false);

    store.set('c/a', {keep: 3}, true);
    expect(store.documents.get('c/a')).toEqual({keep: 3, drop: 2});

    store.set('c/a', {keep: 4}, false);
    expect(store.documents.get('c/a')).toEqual({keep: 4});
  });

  it('refuses to update a document that does not exist', () => {
    const store = new FakeStore();
    expect(() => store.update('c/missing', {a: 1})).toThrow(
      "cannot update missing document 'c/missing'",
    );
  });

  it('hands out a copy so a reader cannot mutate the store', () => {
    const store = new FakeStore();
    store.write('c/a', {n: 1});

    const read = store.read('c/a');
    expect(read).toEqual({n: 1});
    if (!read) {
      expect.fail('expected the seeded document to be readable');
    }
    read.n = 2;

    expect(store.documents.get('c/a')).toEqual({n: 1});
  });

  it('lists only the documents directly inside a collection', () => {
    const store = new FakeStore();
    store.write('c/a', {});
    store.write('c/b', {});
    store.write('c/a/sub/x', {});
    store.write('other/a', {});

    expect(store.childPaths('c')).toEqual(['c/a', 'c/b']);
    expect(store.childPaths('c/a/sub')).toEqual(['c/a/sub/x']);
  });
});

describe('createFakeFirestore', () => {
  it('leaves the store untouched when a transaction throws', async () => {
    const {client, store} = createFakeFirestore();
    store.write('c/a', {n: 1});

    await expect(
      client.runTransaction(async (tx) => {
        const ref = client.collection('c').doc('a');
        await tx.get(ref);
        tx.update(ref, {n: 2});
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    expect(store.documents.get('c/a')).toEqual({n: 1});
  });

  it('applies buffered writes once the transaction resolves', async () => {
    const {client, store} = createFakeFirestore();

    await client.runTransaction(async (tx) => {
      const ref = client.collection('c').doc('a');
      await tx.get(ref);
      tx.set(ref, {n: 1});
    });

    expect(store.documents.get('c/a')).toEqual({n: 1});
  });

  it('orders, filters and limits an events query', async () => {
    const {client, store} = createFakeFirestore();
    for (const [id, millis] of [
      ['third', 300],
      ['first', 100],
      ['second', 200],
    ] as const) {
      store.write(`c/${id}`, {timestamp: Timestamp.fromMillis(millis)});
    }
    const collection = client.collection('c');

    const ordered = await collection.orderBy('timestamp').get();
    expect(ordered.docs.map((doc) => doc.id)).toEqual([
      'first',
      'second',
      'third',
    ]);

    const filtered = await collection
      .orderBy('timestamp')
      .where('timestamp', '>=', Timestamp.fromMillis(200))
      .get();
    expect(filtered.docs.map((doc) => doc.id)).toEqual(['second', 'third']);

    const limited = await collection.orderBy('timestamp').limitToLast(1).get();
    expect(limited.docs.map((doc) => doc.id)).toEqual(['third']);
  });

  it('rejects query shapes it does not implement', () => {
    const {client} = createFakeFirestore();
    const collection = client.collection('c');

    expect(() => collection.orderBy('other')).toThrow(
      "orderBy is only implemented for 'timestamp'",
    );
    expect(() => collection.where('timestamp', '<=', 1)).toThrow(
      "where is only implemented for 'timestamp >='",
    );
    expect(() => collection.limitToLast(0)).toThrow(
      'limitToLast() requires a positive integer',
    );
  });

  it('counts committed batches and deletes their documents', async () => {
    const {client, store} = createFakeFirestore();
    store.write('c/a', {});
    store.write('c/b', {});

    const batch = client.batch();
    batch.delete(client.collection('c').doc('a'));
    await batch.commit();

    expect(store.batchCommitCount).toBe(1);
    expect([...store.documents.keys()]).toEqual(['c/b']);
  });
});
