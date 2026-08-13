/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    name: 'conformance',
    environment: 'node',
    // Against sources, not dist: the point is to check the branch as written.
    alias: {'@google/adk': path.resolve(__dirname, '../core/src')},
    include: ['conformance/**/*_test.ts'],
    testTimeout: 20000,
  },
});
