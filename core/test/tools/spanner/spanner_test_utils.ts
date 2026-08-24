/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Doubles for the two `@google-cloud/spanner-api` admin clients, shared by the
 * Spanner tool tests. Install them with:
 *
 * ```ts
 * vi.mock('@google-cloud/spanner-api', async () => {
 *   const {fakeSpannerModule} = await import('./spanner_test_utils.js');
 *   return fakeSpannerModule;
 * });
 * ```
 */

import {vi} from 'vitest';

/** A long-running operation double. */
export interface FakeOperation {
  promise: () => Promise<unknown>;
}

/** Builds a long-running operation whose completion resolves. */
export function completedOperation(): FakeOperation {
  return {promise: vi.fn(async () => [{}])};
}

export const fakeInstanceAdmin = {
  listInstances: vi.fn(),
  getInstance: vi.fn(),
  listInstanceConfigs: vi.fn(),
  getInstanceConfig: vi.fn(),
  createInstance: vi.fn(),
  projectPath: vi.fn(),
  instancePath: vi.fn(),
  instanceConfigPath: vi.fn(),
  close: vi.fn(),
};

export const fakeDatabaseAdmin = {
  listDatabases: vi.fn(),
  createDatabase: vi.fn(),
  instancePath: vi.fn(),
  close: vi.fn(),
};

export const InstanceAdminClientMock = vi.fn();
export const DatabaseAdminClientMock = vi.fn();

/** The `@google-cloud/spanner-api` module shape the provider destructures. */
export const fakeSpannerModule = {
  v1: {
    InstanceAdminClient: InstanceAdminClientMock,
    DatabaseAdminClient: DatabaseAdminClientMock,
  },
};

/**
 * Clears every recorded call and restores the deterministic behaviour: the
 * resource-path builders and `close()`. Request methods are left without an
 * implementation so a test that forgets to arrange one fails loudly.
 */
export function resetSpannerFakes(): void {
  for (const mock of [
    ...Object.values(fakeInstanceAdmin),
    ...Object.values(fakeDatabaseAdmin),
    InstanceAdminClientMock,
    DatabaseAdminClientMock,
  ]) {
    mock.mockReset();
  }
  fakeInstanceAdmin.projectPath.mockImplementation(
    (project: string) => `projects/${project}`,
  );
  fakeInstanceAdmin.instancePath.mockImplementation(
    (project: string, instance: string) =>
      `projects/${project}/instances/${instance}`,
  );
  fakeInstanceAdmin.instanceConfigPath.mockImplementation(
    (project: string, config: string) =>
      `projects/${project}/instanceConfigs/${config}`,
  );
  fakeDatabaseAdmin.instancePath.mockImplementation(
    (project: string, instance: string) =>
      `projects/${project}/instances/${instance}`,
  );
  fakeInstanceAdmin.close.mockResolvedValue(undefined);
  fakeDatabaseAdmin.close.mockResolvedValue(undefined);
  InstanceAdminClientMock.mockImplementation(() => fakeInstanceAdmin);
  DatabaseAdminClientMock.mockImplementation(() => fakeDatabaseAdmin);
}
