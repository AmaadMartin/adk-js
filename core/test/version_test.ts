/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk';
import {describe, expect, it} from 'vitest';
import packageJson from '../package.json' with {type: 'json'};

describe('version', () => {
  // Compared against package.json rather than a hardcoded literal so that a
  // release-please bump keeps this green without ever editing the test.
  it('matches the version in package.json', () => {
    expect(version).toBe(packageJson.version);
  });
});
