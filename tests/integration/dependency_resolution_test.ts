/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';

/** Resolves `@google/genai` the way Node would for a module in `<repo>/dir`. */
function resolveGenai(dir: string): string {
  return createRequire(
    new URL(`../../${dir}/resolver.js`, import.meta.url),
  ).resolve('@google/genai');
}

describe('workspace dependency resolution', () => {
  it('resolves @google/genai to a single copy for all first-party code', () => {
    const fromCore = resolveGenai('core/src');

    expect(resolveGenai('dev/src')).toBe(fromCore);
    expect(resolveGenai('tests/integration')).toBe(fromCore);
  });
});
