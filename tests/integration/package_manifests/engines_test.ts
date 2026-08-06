/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Workspace directories published to npm. The root manifest is the workspace
 * container, is never published, and deliberately declares no engines: npm
 * already validates a workspace package's engines during a root install.
 */
const PUBLISHED_WORKSPACES = ['core', 'dev', 'integrations'];

interface Manifest {
  engines?: {node?: string};
}

async function readEnginesNode(workspace: string): Promise<string | undefined> {
  const manifestPath = path.join(process.cwd(), workspace, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  return manifest.engines?.node;
}

describe('published package manifests', () => {
  it('declare one agreed engines.node range', async () => {
    const entries = await Promise.all(
      PUBLISHED_WORKSPACES.map(
        async (workspace) =>
          [workspace, await readEnginesNode(workspace)] as const,
      ),
    );
    const declared = Object.fromEntries(entries);
    const [reference] = Object.values(declared);

    expect(reference).toBeDefined();
    expect(declared).toEqual(
      Object.fromEntries(
        PUBLISHED_WORKSPACES.map((workspace) => [workspace, reference]),
      ),
    );
  });
});
