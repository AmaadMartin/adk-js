/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk-integrations';
import {describe, expect, it} from 'vitest';
import packageJson from '../package.json' with {type: 'json'};

/** Semver core, with an optional prerelease suffix such as `-rc.1`. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

describe('version', () => {
  it('should match the version declared in package.json', () => {
    expect(version).toBe(packageJson.version);
  });

  it('should be a well-formed semantic version string', () => {
    expect(version).toMatch(SEMVER_PATTERN);
  });
});
