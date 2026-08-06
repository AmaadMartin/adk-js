/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Workspace directories that are published to npm. `npm publish --workspaces`
 * *skips* a private workspace with a warning rather than failing, so marking
 * one of these private would drop a package from a release silently.
 */
const PUBLISHED_WORKSPACES = ['core', 'dev', 'integrations'];

interface Manifest {
  private?: boolean;
}

/** Reads a manifest relative to the repository root; `.` reads the root one. */
function readManifest(relativeDir: string): Manifest {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), relativeDir, 'package.json'), 'utf8'),
  );
}

describe('workspace manifests', () => {
  it('marks the workspace root as private so it cannot be published', () => {
    // The root manifest is the workspace container. It carries a real package
    // name (`adk`) and no `files` allowlist, so without `private` a bare
    // `npm publish` in the repository root ships the whole tree to npm.
    expect(readManifest('.').private).toBe(true);
  });

  it.each(PUBLISHED_WORKSPACES)(
    'keeps the %s package publishable',
    (workspace: string) => {
      expect(readManifest(workspace).private).toBeUndefined();
    },
  );
});
