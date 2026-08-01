/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk-integrations';
import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * release-please rewrites `integrations/package.json` and the
 * `x-release-please-version` line in `integrations/src/version.ts` together but
 * never touches this test, so any literal here goes stale at the next release.
 * Deriving the expectation from the manifest keeps the assertion correct across
 * releases and catches the two halves drifting apart. The path is resolved from
 * this file's own URL because vitest runs with the repository root as the
 * working directory.
 */
const manifest: {version: string} = JSON.parse(
  readFileSync(path.join(dirname, '..', 'package.json'), 'utf-8'),
);

describe('version', () => {
  it('should be a semantic version string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('should match the version declared in package.json', () => {
    expect(version).toBe(manifest.version);
  });
});
