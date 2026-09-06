/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test doubles for the Daytona SDK, shared by the `DaytonaEnvironment` tests.
 *
 * They model only the calls the environment makes, and they contact no
 * network.
 */

import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Process,
} from '@daytona/sdk';
import {vi} from 'vitest';

/** Parameters either `Daytona.create` overload accepts. */
export type CreateSandboxParams =
  | CreateSandboxFromImageParams
  | CreateSandboxFromSnapshotParams;

/**
 * The SDK's command-execution response. `@daytona/sdk` does not export the
 * type from its entry point, so take it from the method that returns it.
 */
export type ExecuteResponse = Awaited<ReturnType<Process['executeCommand']>>;

/** Stand-in for the SDK's `Sandbox`, holding only what the environment drives. */
export function createFakeSandbox() {
  return {
    delete: vi.fn(async (): Promise<void> => {}),
    refreshActivity: vi.fn(async (): Promise<void> => {}),
    process: {
      executeCommand: vi.fn(
        async (
          _command: string,
          _cwd?: string,
          _env?: Record<string, string>,
          _timeout?: number,
        ): Promise<ExecuteResponse> => ({exitCode: 0, result: ''}),
      ),
    },
    fs: {
      // The SDK declares a non-nullable body. The reference implementation
      // guards against an empty one, so the double has to be able to send it.
      downloadFile: vi.fn(
        async (_remotePath: string): Promise<Buffer | null> => Buffer.alloc(0),
      ),
      uploadFile: vi.fn(
        async (_file: Buffer, _remotePath: string): Promise<void> => {},
      ),
      createFolder: vi.fn(
        async (_path: string, _mode: string): Promise<void> => {},
      ),
    },
  };
}

/** The sandbox double, as returned by {@link createFakeSandbox}. */
export type FakeSandbox = ReturnType<typeof createFakeSandbox>;

/** Stand-in for the SDK's `Daytona` client. */
export function createFakeClient(sandbox: FakeSandbox) {
  return {
    create: vi.fn(
      async (_params?: CreateSandboxParams): Promise<FakeSandbox> => sandbox,
    ),
    [Symbol.asyncDispose]: vi.fn(async (): Promise<void> => {}),
  };
}

/** The client double, as returned by {@link createFakeClient}. */
export type FakeClient = ReturnType<typeof createFakeClient>;

/**
 * Builds an error shaped like one of the Daytona SDK's error classes.
 *
 * Every SDK error class sets `name` to its own class name and carries an
 * optional `code` and `statusCode`, which is what the environment matches on.
 */
export function createDaytonaError(
  name: string,
  message: string,
  fields: {code?: string; statusCode?: number} = {},
): Error {
  return Object.assign(new Error(message), {name}, fields);
}
