/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionInput,
  CodeExecutionLanguage,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {EventEmitter} from 'node:events';
import {vi} from 'vitest';

/** The sandbox binary path the executor defaults to. */
export const SANDBOX_BIN = '/usr/local/gcp/bin/sandbox';

/**
 * The status the executor reports for a timed-out run: the negated SIGKILL
 * number on POSIX, and `TerminateProcess`'s 1 on Windows.
 */
export const TIMEOUT_EXIT_CODE = process.platform === 'win32' ? 1 : -9;

/** The unmocked `spawn`, for the tests that drive a real child process. */
export const {spawn: realSpawn} =
  await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  );

function createFakeStream() {
  return Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    destroy: vi.fn(),
  });
}

/**
 * A stand-in for a spawned child process. `EventEmitter.emit` is synchronous,
 * so a test controls the exact order of `'data'`, `'error'` and `'close'`.
 */
export function createFakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: createFakeStream(),
    stderr: createFakeStream(),
    stdin: Object.assign(new EventEmitter(), {end: vi.fn()}),
    kill: vi.fn(),
  });
}

/** A code execution input carrying `code`; the executor ignores the rest. */
export function executionInput(code: string): CodeExecutionInput {
  return {code, language: CodeExecutionLanguage.PYTHON, inputFiles: []};
}

/** An invocation context the executor accepts but never reads. */
export function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}
