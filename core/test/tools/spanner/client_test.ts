/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {SpannerAdminClientProvider} from '../../../src/tools/spanner/client.js';
import {
  DatabaseAdminClientMock,
  fakeDatabaseAdmin,
  fakeInstanceAdmin,
  InstanceAdminClientMock,
  resetSpannerFakes,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner-api', async () => {
  const {fakeSpannerModule} = await import('./spanner_test_utils.js');
  return fakeSpannerModule;
});

const ADMIN_SCOPE = 'https://www.googleapis.com/auth/spanner.admin';
const LIB_NAME = 'adk-spanner-tool google-adk';

describe('SpannerAdminClientProvider', () => {
  beforeEach(() => {
    resetSpannerFakes();
  });

  it('scopes both clients to the Spanner admin scope', async () => {
    const clients = await new SpannerAdminClientProvider().getClients();

    const expected = {
      scopes: [ADMIN_SCOPE],
      libName: LIB_NAME,
      libVersion: version,
    };
    expect(InstanceAdminClientMock).toHaveBeenCalledWith(expected);
    expect(DatabaseAdminClientMock).toHaveBeenCalledWith(expected);
    expect(clients.instanceAdmin).toBe(fakeInstanceAdmin);
    expect(clients.databaseAdmin).toBe(fakeDatabaseAdmin);
  });

  it('lets the caller override the defaults', async () => {
    await new SpannerAdminClientProvider({
      projectId: 'my-project',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    }).getClients();

    expect(InstanceAdminClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'my-project',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }),
    );
  });

  it('builds the clients once and reuses them', async () => {
    const provider = new SpannerAdminClientProvider();

    const first = await provider.getClients();
    const second = await provider.getClients();

    expect(second).toBe(first);
    expect(InstanceAdminClientMock).toHaveBeenCalledTimes(1);
    expect(DatabaseAdminClientMock).toHaveBeenCalledTimes(1);
  });

  describe('close', () => {
    it('closes both clients', async () => {
      const provider = new SpannerAdminClientProvider();
      await provider.getClients();

      await provider.close();

      expect(fakeInstanceAdmin.close).toHaveBeenCalledTimes(1);
      expect(fakeDatabaseAdmin.close).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the clients were never built', async () => {
      await new SpannerAdminClientProvider().close();

      expect(InstanceAdminClientMock).not.toHaveBeenCalled();
      expect(fakeInstanceAdmin.close).not.toHaveBeenCalled();
    });

    it('does not rethrow a failure from building the clients', async () => {
      InstanceAdminClientMock.mockImplementation(() => {
        throw new Error('no credentials');
      });
      const provider = new SpannerAdminClientProvider();
      await expect(provider.getClients()).rejects.toThrow('no credentials');

      await expect(provider.close()).resolves.toBeUndefined();
    });
  });
});
