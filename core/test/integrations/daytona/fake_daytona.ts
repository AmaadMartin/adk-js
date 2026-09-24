/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A stand-in for the `@daytona/sdk` module namespace.
 *
 * `DaytonaEnvironment` reaches the SDK through a dynamic `import()`, so a test
 * installs this with
 * `vi.mock('@daytona/sdk', () => import('./fake_daytona.js'))` and then drives
 * the spies below. The error classes are real classes, so the `instanceof`
 * checks in the implementation resolve against them exactly as they resolve
 * against the SDK's own classes.
 */

import {vi} from 'vitest';

/** Mirrors the fields the SDK's base error carries. */
export class DaytonaError extends Error {
  statusCode?: number;
  code?: string;
}

export class DaytonaTimeoutError extends DaytonaError {}
export class DaytonaNotFoundError extends DaytonaError {}
export class DaytonaConflictError extends DaytonaError {}

/** The subset of `Sandbox` that `DaytonaEnvironment` uses. */
export interface FakeSandbox {
  process: {executeCommand: ReturnType<typeof vi.fn>};
  fs: {
    downloadFile: ReturnType<typeof vi.fn>;
    uploadFile: ReturnType<typeof vi.fn>;
    createFolder: ReturnType<typeof vi.fn>;
  };
  refreshActivity: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

/** The config object handed to the `Daytona` constructor. */
export interface FakeDaytonaConfig {
  apiKey?: string;
  apiUrl?: string;
}

function makeSandbox(): FakeSandbox {
  return {
    process: {executeCommand: vi.fn()},
    fs: {
      downloadFile: vi.fn(),
      uploadFile: vi.fn(),
      createFolder: vi.fn(),
    },
    refreshActivity: vi.fn(),
    delete: vi.fn(),
  };
}

let sandbox: FakeSandbox = makeSandbox();
let createFailure: unknown;

/** The sandbox every fake client returns from `create`. */
export function currentSandbox(): FakeSandbox {
  return sandbox;
}

/**
 * Makes every subsequent `create` reject with `err`.
 *
 * A client is constructed inside `initialize()`, so a test cannot reach its
 * `create` spy before the call it wants to fail.
 */
export function failCreate(err: unknown): void {
  createFailure = err;
}

/** Every client constructed since the last {@link resetFakeDaytona}. */
export const clients: Daytona[] = [];

/** Stands in for the SDK's `Daytona` client. */
export class Daytona {
  readonly create = vi.fn(async () => {
    if (createFailure !== undefined) {
      throw createFailure;
    }
    return sandbox;
  });
  /** Spy for the disposal the implementation performs on teardown. */
  readonly dispose = vi.fn(async () => {});

  constructor(readonly config: FakeDaytonaConfig) {
    clients.push(this);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

/** Discards the recorded clients and installs a fresh sandbox. */
export function resetFakeDaytona(): void {
  clients.length = 0;
  sandbox = makeSandbox();
  createFailure = undefined;
}
