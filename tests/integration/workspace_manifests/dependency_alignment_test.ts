/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * `peerDependencies` are excluded because a peer range is deliberately allowed
 * to be wider than the dependency range that satisfies it. The root manifest is
 * excluded too: it is the tooling root rather than a shipped workspace.
 */
const CHECKED_FIELDS = ['dependencies', 'devDependencies'] as const;

interface Manifest {
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Declaration {
  site: string;
  range: string;
}

/** Reads a manifest relative to the repo root, which vitest sets as the cwd. */
function readManifest(workspaceDir: string): Manifest {
  return JSON.parse(
    readFileSync(
      path.join(process.cwd(), workspaceDir, 'package.json'),
      'utf8',
    ),
  );
}

describe('workspace dependency ranges', () => {
  it('declares one range per package across all workspaces', () => {
    const workspaces = readManifest('.').workspaces ?? [];
    const declarations = new Map<string, Declaration[]>();

    for (const workspace of workspaces) {
      const manifest = readManifest(workspace);
      for (const field of CHECKED_FIELDS) {
        for (const [name, range] of Object.entries(manifest[field] ?? {})) {
          const sites = declarations.get(name) ?? [];
          sites.push({site: `${workspace} (${field})`, range});
          declarations.set(name, sites);
        }
      }
    }

    const violations = [...declarations]
      .filter(([, sites]) => new Set(sites.map((s) => s.range)).size > 1)
      .map(
        ([name, sites]) =>
          `${name}: ${sites.map((s) => `${s.site} -> ${s.range}`).join(', ')}`,
      );

    expect(workspaces.length).toBeGreaterThan(1);
    expect(violations).toEqual([]);
  });
});
