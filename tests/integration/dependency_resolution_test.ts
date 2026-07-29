/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, '../..');

/** Resolves `specifier` the way Node would for a module living in `dir`. */
function resolveFrom(dir: string, specifier: string): string {
  return createRequire(path.join(dir, 'resolver.js')).resolve(specifier);
}

describe('workspace dependency resolution', () => {
  it('resolves @google/genai to a single copy for all first-party code', () => {
    const fromCore = resolveFrom(
      path.join(repoRoot, 'core/src'),
      '@google/genai',
    );

    expect(resolveFrom(testsDir, '@google/genai')).toBe(fromCore);
    expect(resolveFrom(path.join(repoRoot, 'dev/src'), '@google/genai')).toBe(
      fromCore,
    );
    expect(
      resolveFrom(path.join(repoRoot, 'integrations/src'), '@google/genai'),
    ).toBe(fromCore);
  });
});
