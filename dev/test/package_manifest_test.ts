/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const MANIFEST_PATH = fileURLToPath(
  new URL('../package.json', import.meta.url),
);
const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

/** Extracts the semver major from a range such as `^4.17.21` or `>=4.0.0`. */
function majorVersion(range: string): string {
  return range.replace(/^\D+/, '').split('.')[0];
}

describe('dev/package.json', () => {
  /**
   * `AdkApiServer.app` is typed `express.Application` and the class is exported
   * from `dev/src/index.ts`, so the published declarations name the `express`
   * module. express@4 bundles no declarations of its own, so a consumer can
   * only resolve that import if `@types/express` is installed for them, and a
   * devDependency never is.
   */
  it('declares @types/express as a runtime dependency', () => {
    expect(manifest.dependencies?.['@types/express']).toBeDefined();
    expect(manifest.devDependencies?.['@types/express']).toBeUndefined();
  });

  it('keeps express and @types/express on the same semver major', () => {
    const expressRange = manifest.dependencies?.['express'];
    const typesExpressRange = manifest.dependencies?.['@types/express'];
    if (expressRange === undefined || typesExpressRange === undefined) {
      expect.fail(
        'dev/package.json must declare both express and @types/express as dependencies',
      );
    }
    expect(majorVersion(typesExpressRange)).toBe(majorVersion(expressRange));
  });
});
