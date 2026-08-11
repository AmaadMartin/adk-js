/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk-integrations';
import {describe, expect, it} from 'vitest';
import packageJson from '../package.json' with {type: 'json'};

describe('version', () => {
  // release-please rewrites integrations/package.json and src/version.ts
  // together and never touches this file, so a literal here goes stale on the
  // next release.
  it('should match the version declared in package.json', () => {
    expect(version).toBe(packageJson.version);
  });
});
