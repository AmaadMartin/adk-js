/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** Resolves `@google/genai` the way Node would for a module in `repoRoot/dir`. */
function resolveGenai(dir: string): string {
  return createRequire(path.join(repoRoot, dir, 'resolver.js')).resolve(
    '@google/genai',
  );
}

describe('workspace dependency resolution', () => {
  it('resolves @google/genai to a single copy for all first-party code', () => {
    const fromCore = resolveGenai('core/src');

    expect(resolveGenai('dev/src')).toBe(fromCore);
    expect(resolveGenai('tests/integration')).toBe(fromCore);
  });
});
