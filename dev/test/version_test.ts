/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {version} from '../src/version.js';

describe('version', () => {
  it('matches the version declared in package.json', () => {
    const pkg: {version: string} = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    );
    expect(version).toBe(pkg.version);
  });
});
