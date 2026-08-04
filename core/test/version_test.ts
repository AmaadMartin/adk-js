/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

/** major.minor.patch, with an optional pre-release suffix. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe('version', () => {
  it('matches the version declared in package.json', () => {
    const pkg: {name: string; version: string} = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    );

    // release-please holds every workspace at the same version, so a read that
    // resolved to the wrong manifest would still compare equal. Pin the name.
    expect(pkg.name).toBe('@google/adk');
    // Guards against both sides being undefined, which would compare equal.
    expect(version).toMatch(SEMVER_PATTERN);
    expect(version).toBe(pkg.version);
  });
});
