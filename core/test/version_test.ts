/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

// Read the sibling package.json at runtime so a release bump keeps this test
// green without editing it. A hardcoded literal would rot on the next release.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as {version: string};

describe('version', () => {
  it('matches the version in package.json', () => {
    expect(version).toBe(packageJson.version);
  });

  it('is a semver string', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
