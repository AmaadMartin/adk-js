/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigtableOptions} from '@google-cloud/bigtable';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {BIGTABLE_DEFAULT_SCOPE} from '../../../src/tools/bigtable/bigtable_credentials.js';
import {
  BigtableClientPool,
  createBigtableClient,
} from '../../../src/tools/bigtable/client.js';

/** The one method {@link BigtableClientPool} calls on a pooled client. */
interface FakeClient {
  close: Mock<() => Promise<void[]>>;
}

const {BigtableMock} = vi.hoisted(() => ({
  // A fresh fake per construction, so the pool's identity guarantees are
  // observable.
  BigtableMock: vi.fn<(options: BigtableOptions) => FakeClient>(() => ({
    close: vi.fn(async () => [] as void[]),
  })),
}));

vi.mock('@google-cloud/bigtable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google-cloud/bigtable')>()),
  Bigtable: BigtableMock,
}));

/** Reads back the options the pool passed to the SDK constructor. */
function constructorOptions(callIndex = 0): BigtableOptions {
  const call = BigtableMock.mock.calls[callIndex];
  if (!call) {
    expect.fail(
      `Bigtable was constructed ${BigtableMock.mock.calls.length} times, ` +
        `so there is no call ${callIndex}.`,
    );
  }
  return call[0];
}

describe('createBigtableClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests the default scopes when the config declares none', async () => {
    await createBigtableClient('proj-1');

    expect(constructorOptions()).toEqual({
      projectId: 'proj-1',
      scopes: BIGTABLE_DEFAULT_SCOPE,
    });
  });

  it('forwards the credentials config verbatim', async () => {
    await createBigtableClient('proj-1', {
      scopes: ['https://www.googleapis.com/auth/bigtable.data.readonly'],
      keyFilename: '/etc/keys/service-account.json',
    });

    expect(constructorOptions()).toEqual({
      projectId: 'proj-1',
      scopes: ['https://www.googleapis.com/auth/bigtable.data.readonly'],
      keyFilename: '/etc/keys/service-account.json',
    });
  });
});

describe('BigtableClientPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the same promise for one project id', async () => {
    const pool = new BigtableClientPool();

    const first = pool.forProject('proj-1');

    expect(pool.forProject('proj-1')).toBe(first);
    await first;
    expect(BigtableMock).toHaveBeenCalledTimes(1);
  });

  it('creates a distinct client per project id', async () => {
    const pool = new BigtableClientPool();

    const first = await pool.forProject('proj-1');
    const second = await pool.forProject('proj-2');

    expect(first).not.toBe(second);
    expect(
      BigtableMock.mock.calls.map(([options]) => options.projectId),
    ).toEqual(['proj-1', 'proj-2']);
  });

  it('builds every client with the pool credentials', async () => {
    const pool = new BigtableClientPool({
      keyFilename: '/etc/keys/service-account.json',
    });

    await pool.forProject('proj-1');

    expect(constructorOptions().keyFilename).toBe(
      '/etc/keys/service-account.json',
    );
  });

  it('closes every client it opened and empties the pool', async () => {
    const pool = new BigtableClientPool();
    const first = await pool.forProject('proj-1');
    const second = await pool.forProject('proj-2');

    await pool.close();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);

    // The pool is empty again, so the next call builds a third client.
    await pool.forProject('proj-1');
    expect(BigtableMock).toHaveBeenCalledTimes(3);
  });

  it('closes an empty pool without opening a client', async () => {
    await new BigtableClientPool().close();

    expect(BigtableMock).not.toHaveBeenCalled();
  });
});
