/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import config from '../../../vitest.config.js';

describe('Coverage configuration', () => {
  it('covers the sources of every declared npm workspace', () => {
    const {workspaces} = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'),
    ) as {workspaces: string[]};

    const coverage = config.test?.coverage;
    if (coverage?.provider !== 'v8') {
      expect.fail(
        `expected the v8 coverage provider, got ${coverage?.provider}`,
      );
    }

    expect(coverage.include).toEqual(
      workspaces.map((workspace) => `${workspace}/src/**/*.ts`),
    );
  });
});
