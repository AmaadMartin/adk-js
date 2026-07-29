/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk-integrations';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// release-please rewrites src/version.ts and package.json in the same release
// commit, so package.json is a self-maintaining oracle; a literal here rots.
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as {version: string};

describe('version', () => {
  it('should match the version declared in package.json', () => {
    expect(version).toBe(packageJson.version);
  });

  it('should be a valid semver string', () => {
    expect(version).toMatch(SEMVER_PATTERN);
  });
});
