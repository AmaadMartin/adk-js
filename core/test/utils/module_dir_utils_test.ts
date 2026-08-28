/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {resolveModuleDir} from '../../src/utils/module_dir_utils.js';

describe('resolveModuleDir', () => {
  const modulePath = path.resolve('pkg', 'esm', 'mod.js');

  it('prefers the module URL, which only the ESM output defines', () => {
    expect(
      resolveModuleDir(pathToFileURL(modulePath).href, path.resolve('cwd')),
    ).toBe(path.dirname(modulePath));
  });

  it('falls back to __dirname, which only the CommonJS output defines', () => {
    const dirname = path.resolve('pkg', 'cjs');

    expect(resolveModuleDir(undefined, dirname)).toBe(dirname);
  });

  it('refuses a build that defines neither locator', () => {
    expect(() => resolveModuleDir(undefined, undefined)).toThrow(
      /defines neither import.meta.url nor __dirname/,
    );
  });
});
