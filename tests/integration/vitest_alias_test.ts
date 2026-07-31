/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {workspaceAliases} from '../../vitest.config.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/**
 * Applies the alias entries the way `@rollup/plugin-alias` does for a `RegExp`
 * `find`, so a silent revert to the prefix-matching string form matches nothing
 * and fails these tests.
 */
function matchingAliases(specifier: string) {
  return workspaceAliases.filter(
    (entry) => entry.find instanceof RegExp && entry.find.test(specifier),
  );
}

describe('workspaceAliases', () => {
  it('matches only the bare package specifiers', () => {
    expect(matchingAliases('@google/adk')).toHaveLength(1);
    expect(matchingAliases('@google/adk-integrations')).toHaveLength(1);

    for (const deepSpecifier of [
      '@google/adk/sessions/session.js',
      '@google/adk/agents/processors/code_execution_request_processor.js',
      '@google/adk-integrations/foo.js',
      '@google/adk-devtools',
    ]) {
      expect(matchingAliases(deepSpecifier)).toEqual([]);
    }
  });

  it('resolves each package to its source root', () => {
    expect(matchingAliases('@google/adk')).toEqual([
      {
        find: expect.any(RegExp),
        replacement: path.resolve(REPO_ROOT, 'core/src'),
      },
    ]);
    expect(matchingAliases('@google/adk-integrations')).toEqual([
      {
        find: expect.any(RegExp),
        replacement: path.resolve(REPO_ROOT, 'integrations/src'),
      },
    ]);
  });
});
