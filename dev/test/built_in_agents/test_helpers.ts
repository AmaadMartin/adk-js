/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Shared fixtures for the Agent Builder file tool tests. */

import {
  Context,
  createSession,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach} from 'vitest';

/**
 * Builds a real tool context whose session carries `state`.
 *
 * @param state The initial session state.
 * @return A context the file tools can read the project root from.
 */
export function createTestContext(state: Record<string, unknown>): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'agent-builder-test',
        state,
      }),
      pluginManager: new PluginManager([]),
    }),
  });
}

/**
 * Registers an `afterEach` hook that removes every directory the returned
 * factory created.
 *
 * @return A factory producing a fresh temporary directory.
 */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  return async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_builder_test-'));
    created.push(dir);
    return dir;
  };
}
