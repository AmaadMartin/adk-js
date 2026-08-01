/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Workspace directories whose package.json is published to npm. The root
 * manifest is excluded: it is the workspace container, not a deliverable.
 */
const PUBLISHED_WORKSPACES = ['core', 'dev', 'integrations'];

/**
 * Consumer-facing Node.js floor. 22.12.0 is the lowest release on a supported
 * LTS line that satisfies every engine constraint in the production dependency
 * closure. All three published manifests must agree on it.
 */
const EXPECTED_NODE_RANGE = '>=22.12.0';

interface Manifest {
  name?: string;
  engines?: {node?: string};
}

async function readManifest(workspace: string): Promise<Manifest> {
  const manifestPath = path.join(process.cwd(), workspace, 'package.json');
  return JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
}

describe('published package manifests', () => {
  it.each(PUBLISHED_WORKSPACES)(
    '%s declares the shared engines.node range',
    async (workspace) => {
      const manifest = await readManifest(workspace);
      expect(manifest.engines?.node).toBe(EXPECTED_NODE_RANGE);
    },
  );
});
