/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {removeFolderOnExit} from '../../src/utils/file_utils.js';

/**
 * Arms the cleanup and isolates the listener it added, so a test can invoke
 * that listener without firing the ones vitest owns.
 */
function arm(folderPath: string) {
  const baseline = process.listeners('exit');
  const unregister = removeFolderOnExit(folderPath);
  const added = process
    .listeners('exit')
    .filter((listener) => !baseline.includes(listener));

  return {baseline, added, unregister};
}

describe('removeFolderOnExit', () => {
  it('removes the folder and its contents synchronously', () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'adk-exit-cleanup-'));
    mkdirSync(path.join(folder, 'nested', 'deeper'), {recursive: true});
    writeFileSync(path.join(folder, 'nested', 'deeper', 'file.txt'), 'content');

    const {added, unregister} = arm(folder);

    try {
      expect(added).toHaveLength(1);
      added[0](0);
      expect(existsSync(folder)).toBe(false);
    } finally {
      unregister();
      rmSync(folder, {recursive: true, force: true});
    }
  });

  it('swallows a removal failure', () => {
    // A NUL byte fails path validation, which force: true does not suppress,
    // so it stands in for an EPERM or EBUSY removal failure.
    const {added, unregister} = arm('exit\0folder');

    try {
      expect(added).toHaveLength(1);
      expect(() => added[0](0)).not.toThrow();
    } finally {
      unregister();
    }
  });

  it('removes the exit listener when the returned function is called', () => {
    const {baseline, added, unregister} = arm(
      path.join(os.tmpdir(), 'adk-exit-cleanup-unregister'),
    );

    expect(added).toHaveLength(1);
    unregister();

    expect(process.listeners('exit')).toEqual(baseline);
  });
});
