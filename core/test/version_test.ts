/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

describe('version', () => {
  // Compared against package.json rather than a hardcoded literal so that a
  // release-please bump keeps this green without ever editing the test.
  it('matches the version declared in package.json', () => {
    const pkg: {version: string} = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    );
    expect(version).toBe(pkg.version);
  });
});
