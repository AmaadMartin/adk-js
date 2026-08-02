/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import * as nodeEntry from '../src/index.js';
import * as webEntry from '../src/index_web.js';

describe('index_web', () => {
  it('exposes the same public surface as the node entry point', () => {
    const nodeExports = Object.keys(nodeEntry).sort();
    expect(nodeExports).not.toHaveLength(0);
    expect(Object.keys(webEntry).sort()).toEqual(nodeExports);
  });
});
