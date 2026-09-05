/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BIGTABLE_DEFAULT_SCOPES} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {BigtableClientCache} from '../../../src/tools/bigtable/client.js';
import {FakeBigtable} from './bigtable_fakes.js';

vi.mock('@google-cloud/bigtable', () => ({Bigtable: FakeBigtable}));

describe('BigtableClientCache', () => {
  beforeEach(() => {
    FakeBigtable.reset();
  });

  it('creates one client per project', async () => {
    const cache = new BigtableClientCache();

    await cache.get('project-a');
    await cache.get('project-b');

    expect(FakeBigtable.created).toHaveLength(2);
    expect(
      FakeBigtable.created.map((client) => client.options['projectId']),
    ).toEqual(['project-a', 'project-b']);
  });

  it('serves the same project from the cache', async () => {
    const cache = new BigtableClientCache();

    const first = await cache.get('project-a');
    const second = await cache.get('project-a');

    expect(second).toBe(first);
    expect(FakeBigtable.created).toHaveLength(1);
  });

  it('applies the default scopes when the config omits them', async () => {
    const cache = new BigtableClientCache({keyFilename: '/keys/service.json'});

    await cache.get('project-a');

    expect(FakeBigtable.created[0].options).toMatchObject({
      projectId: 'project-a',
      keyFilename: '/keys/service.json',
      scopes: BIGTABLE_DEFAULT_SCOPES,
    });
  });

  it('keeps the scopes the config names', async () => {
    const scopes = ['https://www.googleapis.com/auth/bigtable.data.readonly'];
    const cache = new BigtableClientCache({scopes});

    await cache.get('project-a');

    expect(FakeBigtable.created[0].options['scopes']).toEqual(scopes);
  });

  it('closes every client it opened, once', async () => {
    const cache = new BigtableClientCache();
    await cache.get('project-a');
    await cache.get('project-b');

    await cache.close();

    expect(FakeBigtable.created.map((client) => client.closes)).toEqual([1, 1]);
  });

  it('empties the cache on close, so the next call opens a new client', async () => {
    const cache = new BigtableClientCache();
    await cache.get('project-a');
    await cache.close();

    await cache.get('project-a');

    expect(FakeBigtable.created).toHaveLength(2);
  });

  it('closes the remaining clients when one fails to close', async () => {
    const cache = new BigtableClientCache();
    await cache.get('project-a');
    await cache.get('project-b');
    FakeBigtable.setup.closeError = new Error('channel already gone');

    await expect(cache.close()).resolves.toBeUndefined();

    expect(FakeBigtable.created.map((client) => client.closes)).toEqual([1, 1]);
  });

  it('closes nothing when no client was ever opened', async () => {
    const cache = new BigtableClientCache();

    await cache.close();

    expect(FakeBigtable.created).toHaveLength(0);
  });
});
