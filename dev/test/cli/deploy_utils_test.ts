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
import {registerStagingFolderCleanup} from '../../src/cli/deploy/deploy_utils.js';

/**
 * Arms the cleanup and isolates the listener it added, so a test can invoke
 * that listener without firing the ones vitest owns.
 */
function arm(stagingFolder: string) {
  const baseline = process.listeners('exit');
  const unregister = registerStagingFolderCleanup(stagingFolder);
  const added = process
    .listeners('exit')
    .filter((listener) => !baseline.includes(listener));

  return {baseline, added, unregister};
}

describe('registerStagingFolderCleanup', () => {
  it('removes the staging folder and its contents synchronously', () => {
    const stagingFolder = mkdtempSync(
      path.join(os.tmpdir(), 'adk-staging-cleanup-'),
    );
    mkdirSync(path.join(stagingFolder, 'agents', 'agent1'), {recursive: true});
    writeFileSync(
      path.join(stagingFolder, 'agents', 'agent1', 'agent.js'),
      'agent',
    );

    const {added, unregister} = arm(stagingFolder);

    try {
      expect(added).toHaveLength(1);
      added[0](0);
      expect(existsSync(stagingFolder)).toBe(false);
    } finally {
      unregister();
      rmSync(stagingFolder, {recursive: true, force: true});
    }
  });

  it('swallows a removal failure', () => {
    // A NUL byte fails path validation, which force: true does not suppress,
    // so it stands in for an EPERM or EBUSY removal failure.
    const {added, unregister} = arm('staging\0folder');

    try {
      expect(added).toHaveLength(1);
      expect(() => added[0](0)).not.toThrow();
    } finally {
      unregister();
    }
  });

  it('removes the exit listener when the returned function is called', () => {
    const stagingFolder = path.join(os.tmpdir(), 'adk-staging-unregister');
    const {baseline, added, unregister} = arm(stagingFolder);

    expect(added).toHaveLength(1);
    unregister();

    expect(process.listeners('exit')).toEqual(baseline);
  });
});
