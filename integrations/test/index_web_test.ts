/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import * as nodeEntry from '../src/index.js';
import * as webEntry from '../src/index_web.js';

/**
 * `build.js` compiles `src/index.ts` and `src/index_web.ts` into separate
 * published artifacts (`dist/esm` + `dist/cjs`, and the `dist/web` bundle the
 * `browser` field points at), so an export added to one entry point and
 * forgotten in the other ships a browser bundle silently missing the symbol.
 * Both entry points are imported by relative path because
 * `integrations/package.json` declares only the `"."` subpath export, leaving
 * `index_web` unreachable by package specifier.
 */
describe('index_web', () => {
  it('exposes the same public surface as the node entry point', () => {
    const nodeExports = Object.keys(nodeEntry).sort();

    expect(nodeExports).not.toHaveLength(0);
    expect(Object.keys(webEntry).sort()).toEqual(nodeExports);
  });

  it('re-exports the same version binding as the node entry point', () => {
    expect(webEntry.version).toBe(nodeEntry.version);
  });
});
