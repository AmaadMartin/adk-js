/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CommandResult, CommandStartOpts} from 'e2b';
import {type Mock, vi} from 'vitest';

/**
 * Stand-in for an e2b `Sandbox`, exposing only the members
 * `E2BEnvironment` uses.
 */
export interface FakeSandbox {
  isRunning: Mock<() => Promise<boolean>>;
  setTimeout: Mock<(timeoutMs: number) => Promise<void>>;
  kill: Mock<() => Promise<boolean>>;
  commands: {
    run: Mock<(cmd: string, opts?: CommandStartOpts) => Promise<CommandResult>>;
  };
  files: {
    read: Mock<(path: string, opts?: {format: 'bytes'}) => Promise<Uint8Array>>;
    write: Mock<(path: string, data: string | Blob) => Promise<void>>;
  };
}

/** Builds a fake sandbox whose methods all resolve. */
export function createFakeSandbox(running = true): FakeSandbox {
  return {
    isRunning: vi.fn(async () => running),
    setTimeout: vi.fn(async () => {}),
    kill: vi.fn(async () => true),
    commands: {run: vi.fn(async () => commandResult({}))},
    files: {
      read: vi.fn(async () => new Uint8Array()),
      write: vi.fn(async () => {}),
    },
  };
}

/** Builds a `CommandResult`, defaulting every field to a success. */
export function commandResult(
  fields: Partial<CommandResult> = {},
): CommandResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    error: undefined,
    ...fields,
  };
}

/**
 * Builds an error carrying one of the e2b SDK's error names.
 *
 * `E2BEnvironment` narrows on `Error.name` rather than `instanceof`, so a
 * plain `Error` with the right name reproduces the SDK's behaviour exactly.
 */
export function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Builds the error e2b throws for a command that exits non-zero. */
export function commandExitError(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): Error {
  return Object.assign(namedError('CommandExitError'), result);
}
